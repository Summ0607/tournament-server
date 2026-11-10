const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { initializeJudgeDatabase } = require('../db/judgeManagement');
const { createJudgeManagementRouter } = require('./judgeManagementRoutes');
const { validDate } = require('./tournamentAge');
const { writeJsonAtomicSync } = require('./atomicJsonFile');
const { createSimulationEventRouter } = require('./judgeSimulationEvents');
const { createEventConfigStore } = require('./eventConfig');
const { createVolunteerRouter } = require('./volunteerRoutes');
const { createRingJudgeRouter } = require('./ringJudgeRoutes');
const { createJudgeAssignmentRouter } = require('./judgeAssignmentRoutes');

const DEFAULT_DIRECTORY = path.join(__dirname, '..', 'judge-simulation-data');
const FORMAT = 'judge-lifecycle-simulation-v1';
const assets = path.join(__dirname, '..', 'tournament-management');

function readSimulation(directory) {
  const state = JSON.parse(fs.readFileSync(path.join(directory, 'simulation.json'), 'utf8'));
  if (state.format !== FORMAT) throw new Error('Not a Judge Lifecycle Simulation directory.');
  validDate(state.date);
  return state;
}

function fixtures(today) {
  function offset(days) {
    const date = new Date(`${today}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }
  const experience = (name, role, eventScope = 'REGIONAL', logVerified = true, days = -30) => ({
    eventName: `SIMULATED ${name}`, eventDate: offset(days), location: 'Fabricated regional venue',
    role, eventScope, logVerified
  });
  const tests = (targetLevel, writtenScore = 80, practicalPassed = true) => [{
    targetLevel, writtenDate: offset(-5), writtenScore, practicalDate: offset(-5), practicalPassed
  }];
  const regional = experience('Regional One', 'CORNER_JUDGE');
  return [
    { name: 'New Candidate', certification: 'UNKNOWN', rank: 'D1' },
    { name: 'Young Candidate', certification: 'UNCERTIFIED', rank: 'G5', birth: offset(-15 * 365) },
    { name: 'New Scorekeeper', certification: 'SK_TK', rank: 'D1' },
    { name: 'Corner Ready', certification: 'SK_TK', rank: 'D1',
      experience: [experience('Regional One', 'SCOREKEEPER')], tests: tests('CORNER') },
    { name: 'Corner Developing', certification: 'CORNER', rank: 'D2',
      experience: [regional], tests: tests('REGIONAL', 79, false) },
    { name: 'Regional Ready', certification: 'CORNER', rank: 'D2',
      experience: [regional, experience('Regional Two', 'CORNER_JUDGE', 'REGIONAL', true, -60)], tests: tests('REGIONAL') },
    { name: 'International Ready', certification: 'REGIONAL', rank: 'D3',
      experience: [experience('Regional One', 'CENTER_JUDGE'), experience('World', 'CORNER_JUDGE', 'WORLD')],
      tests: tests('INTERNATIONAL') },
    { name: 'International Current', certification: 'INTERNATIONAL', rank: 'D4' },
    { name: 'Regional Expired', certification: 'REGIONAL', rank: 'D3', expiration: offset(-1) },
    { name: 'Verification Pending', certification: 'SK_TK', rank: 'D1',
      experience: [experience('Regional One', 'SCOREKEEPER', 'REGIONAL', false)] },
    { name: 'InHouse Experience', certification: 'CORNER', rank: 'D2',
      experience: [experience('In House', 'CORNER_JUDGE', 'IN_HOUSE')] }
  ].map((item, index) => {
    const [firstName, lastName] = item.name.split(' ');
    return {
      judge: { associationId: `SIM-${String(index + 1).padStart(3, '0')}`, firstName, lastName,
        school: `Simulation School ${index % 3 + 1}`, rank: item.rank, certification: item.certification,
        dateOfBirth: item.birth || offset(-30 * 365),
        expiration: ['UNKNOWN', 'UNCERTIFIED'].includes(item.certification) ? '' : item.expiration || offset(365),
        status: 'Active', notes: `FABRICATED: ${item.name}. Not an actual association member.` },
      tests: item.tests || [], experience: item.experience || []
    };
  });
}

function createSimulationApp(directory) {
  readSimulation(directory);
  const app = express();
  let activeRequests = 0;
  app.use((req, res, next) => {
    const expectedHost = `127.0.0.1:${req.socket.localPort}`;
    if (req.headers.host !== expectedHost || req.headers.origin && req.headers.origin !== `http://${expectedHost}`) {
      return res.status(403).json({ error: 'Simulation requests must originate from this local simulation server.' });
    }
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.json({ limit: '3mb' }));
  app.get('/api/simulation', (_req, res) => res.json(readSimulation(directory)));
  app.put('/api/simulation', (req, res) => {
    try {
      const state = readSimulation(directory);
      if (activeRequests || req.body?.previousDate !== state.date) {
        return res.status(409).json({ error: 'Judge data or the simulation date is changing. Reload and retry.' });
      }
      try { validDate(req.body?.date); }
      catch (error) { return res.status(400).json({ error: error.message }); }
      if (req.body.date < state.date) return res.status(400).json({ error: 'Advance the date only; use a new simulation to start earlier.' });
      const next = { ...state, date: req.body.date };
      writeJsonAtomicSync(path.join(directory, 'simulation.json'), next);
      res.json(next);
    } catch (error) {
      console.error('Unable to update simulation date:', error);
      res.status(500).json({ error: 'Unable to update the simulation date. Check the server log.' });
    }
  });
  app.use('/api', (_req, res, next) => {
    activeRequests++;
    let finished = false;
    const finish = () => { if (!finished) { finished = true; activeRequests--; } };
    res.once('finish', finish); res.once('close', finish);
    next();
  }, createJudgeManagementRouter({ file: path.join(directory, 'judges.db'),
    currentDate: () => readSimulation(directory).date, allowSimulation: true }));
  const eventsRoot = path.join(directory, 'events'), judgeFile = path.join(directory, 'judges.db');
  app.use('/api', createSimulationEventRouter({ directory }));
  const { configurationStatus } = createEventConfigStore(eventsRoot);
  app.use('/api', createVolunteerRouter({ eventsRoot, configurationStatus }));
  app.use('/api', createRingJudgeRouter({ eventsRoot, configurationStatus, judgeFile }));
  app.use('/api', createJudgeAssignmentRouter({ eventsRoot, judgeFile }));
  app.get('/', (_req, res) => res.sendFile(path.join(assets, 'judge-simulation.html')));
  app.get('/management-template', (_req, res) => res.sendFile(path.join(assets, 'index.html')));
  for (const name of ['judge-management.js', 'judge-simulation.js', 'volunteers.js', 'ring-judges.js', 'judge-assignments.js']) {
    app.get(`/${name}`, (_req, res) => res.sendFile(path.join(assets, name)));
  }
  app.use((_req, res) => res.status(404).json({ error: 'Only isolated Judge Management and event preparation are available here.' }));
  return app;
}

async function listen(app, port) {
  const server = app.listen(port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return server;
}

async function initializeSimulation(directory, date, { empty = false } = {}) {
  validDate(date);
  fs.mkdirSync(directory);
  await initializeJudgeDatabase(path.join(directory, 'judges.db'));
  writeJsonAtomicSync(path.join(directory, 'simulation.json'), { format: FORMAT, date, initialDate: date });
  if (empty) return;
  const server = await listen(createSimulationApp(directory), 0);
  try {
    let revision = 0;
    for (const record of fixtures(date)) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/judge-management`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision, ...record })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(`Unable to seed ${record.judge.associationId}: ${result.error}`);
      revision = result.revision;
    }
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

async function main(args) {
  const [command, ...options] = args;
  if (!['init', 'serve'].includes(command) || options.length % 2) throw new Error('Usage: npm run judge:simulation -- init --date YYYY-MM-DD [--directory PATH] | serve [--directory PATH] [--port 3450]');
  const values = {};
  for (let i = 0; i < options.length; i += 2) {
    const flag = options[i];
    if (!['--date', '--directory', '--port', '--population'].includes(flag) || values[flag] !== undefined) throw new Error(`Invalid or duplicate option: ${flag}`);
    values[flag] = options[i + 1];
  }
  const directory = path.resolve(values['--directory'] || DEFAULT_DIRECTORY);
  if (command === 'init') {
    if (values['--port']) throw new Error('--port is only valid for serve.');
    if (values['--population'] && !['empty', 'scenarios'].includes(values['--population'])) throw new Error('Population must be empty or scenarios.');
    await initializeSimulation(directory, values['--date'], { empty: values['--population'] === 'empty' });
    console.log(`Created FABRICATED judge simulation at ${directory}. Date: ${values['--date']}. Existing directories are never overwritten.`);
  } else {
    if (values['--date']) throw new Error('Change the simulation date in the simulation page.');
    if (values['--population']) throw new Error('--population is only valid for init.');
    const port = Number(values['--port'] || 3450);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be an integer from 1024 to 65535.');
    readSimulation(directory);
    await initializeJudgeDatabase(path.join(directory, 'judges.db'));
    await listen(createSimulationApp(directory), port);
    console.log(`FABRICATED judge lifecycle and event preparation: http://127.0.0.1:${port}\nDatabase: ${path.join(directory, 'judges.db')}\nIsolated events: ${path.join(directory, 'events')}\nNo live data or tablet services are connected. Stop with Ctrl+C; records, events and date persist.`);
  }
}

if (require.main === module) main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { createSimulationApp, initializeSimulation, readSimulation };
