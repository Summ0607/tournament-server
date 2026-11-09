const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeJsonAtomicSync } = require('./atomicJsonFile');
const { createEventConfigStore } = require('./eventConfig');
const { assignmentCandidates } = require('./judgeAssignmentCandidates');
const { DEFAULT_JUDGE_DATABASE } = require('../db/judgeManagement');
const { POSITIONS, preferred, autoAssign } = require('./judgeAssignmentAlgorithm');
const { buildRingLabel } = require('../group-server-helpers');
const phases = ['P1', 'P2'];
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const emptyPhase = (discipline) => ({ discipline, rings: [], available: [], arbitrators: [], assignments: {} });
function read(file) {
  if (!fs.existsSync(file)) return { revision: null, phases: { P1: emptyPhase('black-belt'), P2: emptyPhase('gup') } };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data || typeof data.revision !== 'string' || !data.phases || phases.some((phase) => !data.phases[phase])) throw new Error('Invalid saved judge assignment phases.');
  return data;
}
function canServe(judge, phase, role) {
  return Boolean(judge?.roles[role] && !(phase.discipline === 'black-belt' && judge.sources.includes('competitor') && /^D[1-8]$/.test(judge.rank)));
}
function validatePhase(phase, rings, judges) {
  if (!phase || !['black-belt', 'gup'].includes(phase.discipline)) fail('Select Black Belt or Gup for each phase.');
  const byId = new Map(judges.map((judge) => [judge.id, judge]));
  const distinct = (list, allowed, label) => {
    if (!Array.isArray(list) || new Set(list).size !== list.length || list.some((id) => !allowed.has(id))) fail(`Invalid ${label}. Reload and correct the draft.`);
  };
  distinct(phase.rings, new Set(rings), 'rings');
  distinct(phase.available, new Set(byId.keys()), 'availability');
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
function createJudgeAssignmentRouter({ eventsRoot, judgeFile = DEFAULT_JUDGE_DATABASE }) {
  const router = express.Router();
  const { readEventConfig, configurationStatus } = createEventConfigStore(eventsRoot);
  async function context(req) {
    const name = req.query.eventName;
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
    return { eventName: name, file, rings, judges: candidates.judges, sourceRevision, asOf: config.date,
      ...read(file), ...configurationStatus(name) };
  }
  const payload = ({ file, ...data }) => data;
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
    const next = { revision: crypto.randomUUID(), phases: Object.fromEntries(phases.map((phase) =>
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
