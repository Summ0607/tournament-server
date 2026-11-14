const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeJsonAtomicSync } = require('./atomicJsonFile');
const { createEventConfigStore } = require('./eventConfig');
const { assignmentCandidates } = require('./judgeAssignmentCandidates');
const { DEFAULT_JUDGE_DATABASE } = require('../db/judgeManagement');
const { judgeRankOptions } = require('../db/judgeCertification');
const { POSITIONS, preferred, autoAssign } = require('./judgeAssignmentAlgorithm');
const { buildRingLabel } = require('../group-server-helpers');
const phases = ['P1', 'P2'];
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const emptyPhase = (discipline) => ({ discipline, rings: [], available: [], arbitrators: [], assignments: {} });
function read(file) {
  if (!fs.existsSync(file)) return {
    revision: null,
    phases: { P1: emptyPhase('black-belt'), P2: emptyPhase('gup') },
    replacementPinVerifier: null
  };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data || typeof data.revision !== 'string' || !data.phases || phases.some((phase) => !data.phases[phase])) throw new Error('Invalid saved judge assignment phases.');
  if (data.replacementPinVerifier && !validReplacementPinVerifier(data.replacementPinVerifier)) {
    throw new Error('Invalid saved event replacement PIN verifier.');
  }
  return { ...data, replacementPinVerifier: data.replacementPinVerifier || null };
}
function competitionDiscipline(judge) {
  if (!Array.isArray(judge?.sources) || !judge.sources.includes('competitor')) return '';
  const rank = String(judge.rank || '').trim().toUpperCase();
  if (/^D[1-8]$/.test(rank)) return 'black-belt';
  if (/^(?:G(?:10|[1-9])|CDB)$/.test(rank)) return 'gup';
  return '';
}
function competingInPhase(judge, phase) {
  return Boolean(competitionDiscipline(judge) && competitionDiscipline(judge) === phase.discipline);
}
function canServe(judge, phase, role) {
  return Boolean(judge?.roles[role] && !competingInPhase(judge, phase));
}
function createReplacementPinVerifier(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.createHash('sha256').update(`${salt}:${pin}`, 'utf8').digest('hex');
  return { algorithm: 'SHA-256-salted-v1', salt, digest };
}
function validReplacementPinVerifier(value) {
  return value && value.algorithm === 'SHA-256-salted-v1' &&
    /^[a-f0-9]{32}$/i.test(value.salt) && /^[a-f0-9]{64}$/i.test(value.digest);
}
function validatePhase(phase, rings, judges) {
  if (!phase || !['black-belt', 'gup'].includes(phase.discipline)) fail('Select Black Belt or Gup for each phase.');
  const byId = new Map(judges.map((judge) => [judge.id, judge]));
  const distinct = (list, allowed, label) => {
    if (!Array.isArray(list) || new Set(list).size !== list.length || list.some((id) => !allowed.has(id))) fail(`Invalid ${label}. Reload and correct the draft.`);
  };
  distinct(phase.rings, new Set(rings), 'rings');
  distinct(phase.available, new Set(byId.keys()), 'availability');
  for (const id of phase.available) {
    if (competingInPhase(byId.get(id), phase)) fail('An official competing in this phase cannot be marked available.');
  }
  if (!Array.isArray(phase.arbitrators)) fail('Arbitrators must be a list.');
  distinct(phase.arbitrators, new Set(phase.available), 'arbitrators');
  const used = new Set(phase.arbitrators);
  for (const id of phase.arbitrators) if (!canServe(byId.get(id), phase, 'arbitrator')) fail('An arbitrator is not qualified or is competing in this phase.');
  if (!phase.assignments || typeof phase.assignments !== 'object' || Array.isArray(phase.assignments)) fail('Assignments are required.');
  for (const [ring, assignment] of Object.entries(phase.assignments)) {
    if (!phase.rings.includes(ring) || !assignment || Object.keys(assignment).some((role) => !POSITIONS.includes(role))) fail('Invalid ring or position.');
    for (const role of POSITIONS) {
      distinct(assignment[role], new Set(phase.available), `${role} assignments`);
      if (assignment[role].length > preferred[role]) fail(`Too many ${role} officials.`);
      for (const id of assignment[role]) {
        if (used.has(id)) fail('An official cannot hold two positions in the same phase.');
        if (!canServe(byId.get(id), phase, role)) fail('An assigned official is not qualified or is competing in this phase.');
        used.add(id);
      }
    }
  }
  return structuredClone(phase);
}
function createJudgeAssignmentRouter({ eventsRoot, judgeFile = DEFAULT_JUDGE_DATABASE, readActiveEvent = () => '' }) {
  const router = express.Router();
  const { readEventConfig, configurationStatus } = createEventConfigStore(eventsRoot);
  async function contextForEvent(name) {
    if (typeof name !== 'string' || !name.trim() || name !== name.trim() || /[<>:"/\\|?*\x00-\x1F]/.test(name) || ['.', '..'].includes(name)) fail('An explicit valid eventName is required.');
    const dir = path.join(eventsRoot, name), eventFile = path.join(dir, 'tournament.db');
    if (!fs.existsSync(eventFile)) fail('Tournament database not found.', 404);
    const config = readEventConfig(name);
    const candidates = await assignmentCandidates({ eventFile, judgeFile, config });
    const sourceRevision = crypto.createHash('sha256').update(JSON.stringify([config, candidates.judgeRevision,
      candidates.volunteerRevision, candidates.sourceFingerprint])).digest('hex');
    const rings = [];
    for (let x = 0; x < config.ringConfigX; x++) for (let y = 1; y <= config.ringConfigY; y++) rings.push(buildRingLabel(String.fromCharCode(65 + x), y));
    const file = path.join(dir, 'judge-assignments.json');
    const saved = read(file);
    return { ...saved, eventName: name, file, rings, judges: candidates.judges, sourceRevision,
      assignmentSourceRevision: saved.sourceRevision || null, asOf: config.date, ...configurationStatus(name) };
  }
  const context = (req) => contextForEvent(req.query.eventName);
  const payload = ({ file, replacementPinVerifier, ...data }) => ({
    ...data,
    judgeRanks: judgeRankOptions(),
    replacementPinConfigured: Boolean(replacementPinVerifier)
  });
  const handle = (action) => async (req, res) => {
    try { res.json(await action(req, await context(req))); }
    catch (error) {
      if (!error.statusCode) console.error('Judge assignments failed:', error);
      res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Unable to access judge assignments. Check the server log.' });
    }
  };
  function writable(state, req) {
    if (state.configurationLocked) fail('Assignments are locked after operational use begins. Reset Run before editing.', 409);
    if (req.body?.sourceRevision !== state.sourceRevision || req.body?.revision !== state.revision) fail('Judge qualifications, event data or assignments changed. Reload before saving.', 409);
  }
  router.get('/rings/:ringId/judge-plan', async (req, res) => {
    try {
      const eventName = req.query.eventName || res.locals.tabletSession?.event || readActiveEvent();
      const state = await contextForEvent(eventName);
      const phaseName = req.query.phase;
      if (!phases.includes(phaseName)) fail('phase must be P1 or P2.');
      const ringId = String(req.params.ringId || '').trim();
      if (!state.rings.includes(ringId)) fail('Ring is not configured for this event.', 404);
      const phase = state.phases[phaseName];
      if (!phase) fail('The requested phase has no saved judge assignment.', 404);
      if (state.assignmentSourceRevision && state.assignmentSourceRevision !== state.sourceRevision) {
        fail('Judge qualifications or event data changed. Reload and save the assignment plan before using it.', 409);
      }
      const candidates = new Map(state.judges.map((judge) => [judge.id, judge]));
      const checked = validatePhase(phase, state.rings, state.judges);
      const planned = checked.rings.includes(ringId);
      const ids = planned ? checked.assignments[ringId] : null;
      const officials = (role) => (ids?.[role] || []).map((id) => {
        const judge = candidates.get(id);
        return { associationId: judge.associationId, name: judge.name, rank: judge.rank, certification: judge.certification };
      });
      res.json({
        type: 'tournament-judge-plan',
        schemaVersion: 1,
        eventName: state.eventName,
        eventDate: state.asOf,
        ringId,
        phase: phaseName,
        assignmentRevision: state.revision,
        sourceRevision: state.sourceRevision,
        replacementPinVerifier: state.replacementPinVerifier || null,
        replacementPinConfigured: Boolean(state.replacementPinVerifier),
        assigned: planned,
        positions: Object.fromEntries(POSITIONS.map((role) => [role, officials(role)])),
        arbitrators: checked.arbitrators.map((id) => {
          const judge = candidates.get(id);
          return { associationId: judge.associationId, name: judge.name, rank: judge.rank, certification: judge.certification };
        })
      });
    } catch (error) {
      if (!error.statusCode) console.error('Judge assignment plan slice failed:', error);
      res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Unable to access judge assignment plan. Check the server log.' });
    }
  });
  router.get('/judge-assignments', handle((_req, state) => payload(state)));
  router.post('/judge-assignments/auto', handle((req, state) => {
    writable(state, req);
    const phase = validatePhase({ ...req.body.phase, assignments: {} }, state.rings, state.judges);
    const candidates = state.judges.filter((judge) => phase.available.includes(judge.id) && !phase.arbitrators.includes(judge.id))
      .map((judge) => ({ ...judge, roles: Object.fromEntries(POSITIONS.map((role) => [role, canServe(judge, phase, role)])) }));
    return autoAssign(candidates, phase.rings, phase.discipline);
  }));
  router.put('/judge-assignments', handle(async (req, state) => {
    writable(state, req);
    if (!req.body.phases || Object.keys(req.body.phases).length !== 2) fail('Both phases are required.');
    if (Object.hasOwn(req.body, 'replacementPin') && typeof req.body.replacementPin !== 'string') {
      fail('The event replacement PIN must be text.');
    }
    const replacementPin = req.body.replacementPin || '';
    if (replacementPin && !/^[\x21-\x7e]{4}$/.test(replacementPin)) {
      fail('The event replacement PIN must contain exactly four visible ASCII characters.');
    }
    const next = { revision: crypto.randomUUID(), sourceRevision: state.sourceRevision,
      replacementPinVerifier: replacementPin ? createReplacementPinVerifier(replacementPin) : state.replacementPinVerifier,
      phases: Object.fromEntries(phases.map((phase) =>
      [phase, validatePhase(req.body.phases[phase], state.rings, state.judges)])) };
    const latest = await context(req);
    writable(latest, req);
    if (read(state.file).revision !== req.body.revision) fail('Assignments changed. Reload before saving.', 409);
    writeJsonAtomicSync(state.file, next);
    return payload({ ...latest, ...next });
  }));
  return router;
}
module.exports = { createJudgeAssignmentRouter, validatePhase, canServe };
