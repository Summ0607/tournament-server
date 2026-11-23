const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { generateSimulationSetup, SIMULATION_JUDGE_POOL_REFERENCE_DATE } = require('./simulatorSetupGenerator');
const { buildPreparationFiles, writeCsvFiles } = require('./simulatorSetupCsvExport');
const { createSimulationApp, initializeSimulation } = require('./judgeSimulation');
const { applyExperiencePayload } = require('./judgeSimulationData');
const { writeJsonAtomicSync } = require('./atomicJsonFile');
const { validDate } = require('./tournamentAge');

const ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_ACTIVE_WORKSPACES = 5;

function createSimulationWorkspaceRouter({ root }) {
  const router = express.Router();
  const workspaceRoot = path.resolve(root);
  const servers = new Map();
  router.use(express.json({ limit: '5mb' }));
  fs.mkdirSync(workspaceRoot, { recursive: true });

  function workspace(id) {
    if (!ID_PATTERN.test(String(id || ''))) throw Object.assign(new Error('Simulation workspace not found.'), { statusCode: 404 });
    const directory = path.join(workspaceRoot, id);
    const manifestFile = path.join(directory, 'workspace.json');
    if (!fs.existsSync(manifestFile)) throw Object.assign(new Error('Simulation workspace not found.'), { statusCode: 404 });
    return { id, directory, manifest: JSON.parse(fs.readFileSync(manifestFile, 'utf8')) };
  }

  function list() {
    return fs.readdirSync(workspaceRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name))
      .flatMap((entry) => {
        try {
          const item = workspace(entry.name);
          return [{ ...item.manifest, running: Boolean(servers.get(item.id)?.listening) }];
        } catch (error) {
          if (error.code === 'ENOENT' || error instanceof SyntaxError) return [];
          throw error;
        }
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async function listen(app) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    return server;
  }

  async function ensureRunning(item) {
    const current = servers.get(item.id);
    if (current?.listening) return `http://127.0.0.1:${current.address().port}/`;
    if (servers.size >= MAX_ACTIVE_WORKSPACES) {
      throw Object.assign(new Error(`Close or stop one of the ${MAX_ACTIVE_WORKSPACES} active simulation workspaces before opening another.`), { statusCode: 409 });
    }
    const directory = path.join(item.directory, 'judge-simulation');
    const server = await listen(createSimulationApp(directory));
    servers.set(item.id, server);
    return `http://127.0.0.1:${server.address().port}/`;
  }

  async function request(base, endpoint, body) {
    const response = await fetch(`${base}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Simulation setup failed (${response.status}).`);
    return result;
  }

  router.get('/simulation-workspaces', (_req, res) => {
    try { res.json({ workspaces: list() }); }
    catch (error) {
      console.error('Unable to list simulation workspaces:', error);
      res.status(500).json({ error: 'Unable to list simulation workspaces. Check the server log.' });
    }
  });

  router.post('/simulation-workspaces/:id/open', async (req, res) => {
    try {
      const item = workspace(req.params.id);
      res.json({ url: await ensureRunning(item) });
    } catch (error) {
      if (!error.statusCode) console.error('Unable to open simulation workspace:', error);
      res.status(error.statusCode || 500).json({
        error: error.statusCode ? error.message : 'Unable to open the simulation workspace. Check the server log.'
      });
    }
  });

  router.post('/simulation-workspaces/:id/stop', async (req, res) => {
    try {
      const item = workspace(req.params.id);
      const server = servers.get(item.id);
      const wasRunning = Boolean(server?.listening);
      if (wasRunning) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      servers.delete(item.id);
      res.json({ stopped: wasRunning });
    } catch (error) {
      if (!error.statusCode) console.error('Unable to stop simulation workspace:', error);
      res.status(error.statusCode || 500).json({
        error: error.statusCode ? error.message : 'Unable to stop the simulation workspace. Check the server log.'
      });
    }
  });

  router.post('/simulation-workspaces', async (req, res) => {
    let directory = '';
    let server;
    try {
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}$/.test(name) ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name)) {
        throw Object.assign(new Error('Use an event name of 1-80 letters, numbers, spaces, underscores or hyphens.'), { statusCode: 400 });
      }
      const eventDate = req.body?.eventDate;
      if (typeof eventDate !== 'string' || eventDate < SIMULATION_JUDGE_POOL_REFERENCE_DATE) {
        throw Object.assign(new Error(`Simulation event date must be on or after ${SIMULATION_JUDGE_POOL_REFERENCE_DATE}.`), { statusCode: 400 });
      }
      try { validDate(eventDate); } catch (error) { throw Object.assign(error, { statusCode: 400 }); }
      const competitorCount = req.body?.competitorCount;
      if (!Number.isSafeInteger(competitorCount) || competitorCount < 1 || competitorCount > 646) {
        throw Object.assign(new Error('Competitor count must be between 1 and 646 for the fixed 20-ring judge pool.'), { statusCode: 400 });
      }
      if (!['regional', 'national', 'world', 'in-house'].includes(req.body?.scope)) {
        throw Object.assign(new Error('Select an event scope.'), { statusCode: 400 });
      }
      if (![1, 2].includes(req.body?.tournamentDays)) {
        throw Object.assign(new Error('Select one or two tournament days.'), { statusCode: 400 });
      }

      const id = crypto.randomUUID();
      directory = path.join(workspaceRoot, id);
      fs.mkdirSync(directory);
      const setup = generateSimulationSetup({ eventDate, seed: `simulation-${id}`, competitorCount });
      setup.profile.eventName = name;
      setup.profile.scope = req.body.scope;
      setup.profile.tournamentDays = req.body.tournamentDays;
      const { files } = buildPreparationFiles(setup);
      writeCsvFiles(files, path.join(directory, 'package'));

      const simulationDirectory = path.join(directory, 'judge-simulation');
      await initializeSimulation(simulationDirectory, eventDate, { empty: true });
      server = await listen(createSimulationApp(simulationDirectory));
      const base = `http://127.0.0.1:${server.address().port}`;
      const currentRosterResponse = await fetch(`${base}/api/judge-management`);
      const currentRoster = await currentRosterResponse.json();
      if (!currentRosterResponse.ok || !Number.isSafeInteger(currentRoster.revision)) {
        throw new Error(currentRoster.error || 'Unable to read the isolated Judge Management revision.');
      }
      const imported = await request(base, '/api/judge-management-import', {
        revision: currentRoster.revision, csv: files['judges.csv']
      });
      if (imported.added !== setup.judges.length || imported.updated !== 0) {
        throw new Error(`Judge import receipt mismatch: expected ${setup.judges.length} new judges.`);
      }
      const experience = await applyExperiencePayload(base, JSON.parse(files['experience-api.json']));
      if (experience.added !== setup.priorExperience.length) {
        throw new Error(`Experience import receipt mismatch: expected ${setup.priorExperience.length} records.`);
      }
      const event = await request(base, '/api/simulation/events', {
        name, date: eventDate, scope: req.body.scope, tournamentDays: req.body.tournamentDays,
        ringCount: setup.profile.ringCount
      });
      const participants = await request(base,
        `/api/simulation/events/import-setup?eventName=${encodeURIComponent(name)}`, setup);
      if (participants.addedCompetitors !== competitorCount ||
          participants.addedVolunteers !== setup.volunteers.length) {
        throw new Error('Generated event roster receipt does not match the setup.');
      }

      const manifest = {
        id,
        name,
        eventDate,
        competitorCount,
        judgeCount: setup.judges.length,
        volunteerCount: setup.volunteers.length,
        judgeRequirementCount: setup.profile.judgeRequirementCount,
        judgeTargetCount: setup.profile.judgeTargetCount,
        competitorJudgeCount: setup.profile.competitorJudgeCount,
        judgingVolunteerCount: setup.profile.judgingVolunteerCount,
        supportVolunteerCount: setup.profile.otherVolunteerCount,
        supportRoleCounts: {
          setup: setup.profile.setupVolunteerCount,
          teardown: setup.profile.teardownVolunteerCount,
          setupTeardownOverlap: setup.profile.setupTeardownOverlapCount,
          setupTeardownUnique: setup.profile.setupTeardownUniqueCount,
          security: setup.profile.securityVolunteerCount,
          operations: setup.profile.operationsVolunteerCount,
          awards: setup.profile.awardsVolunteerCount,
          medical: setup.profile.medicalVolunteerCount
        },
        priorExperienceCount: setup.priorExperience.length,
        ringCount: setup.profile.ringCount,
        scope: req.body.scope,
        tournamentDays: req.body.tournamentDays,
        createdAt: new Date().toISOString()
      };
      writeJsonAtomicSync(path.join(directory, 'workspace.json'), manifest);
      servers.set(id, server);
      res.status(201).json({ workspace: { ...manifest, running: true },
        url: `http://127.0.0.1:${server.address().port}/`, event: event.event });
    } catch (error) {
      if (server) await new Promise((resolve) => server.close(resolve));
      if (directory && fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true });
      if (!error.statusCode) console.error('Unable to create isolated simulation workspace:', error);
      res.status(error.statusCode || 500).json({
        error: error.statusCode ? error.message : 'Unable to create the isolated simulation workspace. Check the server log.'
      });
    }
  });

  router.closeSimulationServers = async () => {
    const active = [...servers.values()];
    servers.clear();
    await Promise.all(active.map((server) => new Promise((resolve) => server.close(resolve))));
  };
  return router;
}

module.exports = { createSimulationWorkspaceRouter };
