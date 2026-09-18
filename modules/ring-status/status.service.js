const fs = require('fs');
const path = require('path');

const { clampInt, buildRingId, buildRingLabel } = require('../../group-server-helpers'); // if you have helpers later

const RING_ASSIGNMENTS_FILE = path.join(__dirname, '../../ring-assignments.json');
const GROUPS_DIR = path.join(__dirname, '../../groups');
const MAX_LETTERS = 26;
const MAX_NUMBERS = 50;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function createEmptyRingState(ringLabel) {
  return {
    ringLabel,
    currentGroupId: '',
    queuedGroupIds: [],
    completedGroupIds: [],
    assistanceType: '',
    assistanceRequestedAt: '',
    tabletLabel: '',
    lastHeartbeatAt: '',
    phaseStartedAt: '',
    phase: 'idle'
  };
}

function normalizeRingState(ringState, ringLabel) {
  const normalized = createEmptyRingState(ringLabel);
  if (!ringState || typeof ringState !== 'object') {
    return normalized;
  }
  normalized.ringLabel = ringState.ringLabel || ringLabel;
  normalized.currentGroupId = ringState.currentGroupId || '';
  normalized.queuedGroupIds = Array.isArray(ringState.queuedGroupIds) ? ringState.queuedGroupIds : [];
  normalized.completedGroupIds = Array.isArray(ringState.completedGroupIds) ? ringState.completedGroupIds : [];
  normalized.assistanceType = ringState.assistanceType || '';
  normalized.assistanceRequestedAt = ringState.assistanceRequestedAt || '';
  normalized.tabletLabel = ringState.tabletLabel || '';
  normalized.lastHeartbeatAt = ringState.lastHeartbeatAt || '';
  normalized.phase = ringState.phase || 'idle';
  normalized.phaseStartedAt = ringState.phaseStartedAt || (normalized.phase !== 'idle' ? normalized.lastHeartbeatAt || '' : '');
  return normalized;
}

function normalizeConfig(rawConfig) {
  const defaults = { letterCount: 1, numberCount: 2 };
  if (!rawConfig || typeof rawConfig !== 'object') return defaults;
  return {
    letterCount: clampInt(rawConfig.letterCount, defaults.letterCount, 1, MAX_LETTERS),
    numberCount: clampInt(rawConfig.numberCount, defaults.numberCount, 1, MAX_NUMBERS)
  };
}

function generateRings(config, existingRings = {}) {
  const rings = {};
  for (let letterIndex = 0; letterIndex < config.letterCount; letterIndex += 1) {
    const letter = LETTERS[letterIndex];
    for (let number = 1; number <= config.numberCount; number += 1) {
      const ringId = buildRingId(letter, number);
      const ringLabel = buildRingLabel(letter, number);
      rings[ringId] = normalizeRingState(existingRings[ringId], ringLabel);
    }
  }
  return rings;
}

function createDefaultAssignments() {
  const config = { letterCount: 1, numberCount: 2 };
  return {
    config,
    rings: generateRings(config)
  };
}

function ensureStateStructure(rawState) {
  const state = rawState && typeof rawState === 'object' ? rawState : {};
  const config = normalizeConfig(state.config);
  return {
    config,
    rings: generateRings(config, state.rings || {})
  };
}

function readAssignmentsState() {
  if (!fs.existsSync(RING_ASSIGNMENTS_FILE)) {
    const defaults = createDefaultAssignments();
    fs.writeFileSync(RING_ASSIGNMENTS_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  const raw = JSON.parse(fs.readFileSync(RING_ASSIGNMENTS_FILE, 'utf8'));
  const normalized = ensureStateStructure(raw);
  fs.writeFileSync(RING_ASSIGNMENTS_FILE, JSON.stringify(normalized, null, 2));
  return normalized;
}

function writeAssignmentsState(state) {
  fs.writeFileSync(RING_ASSIGNMENTS_FILE, JSON.stringify(state, null, 2));
}

function getRingState(state, ringId) {
  return state.rings[ringId] || null;
}

function listAllowedRingLabels(state) {
  return Object.values(state.rings).map((ring) => ring.ringLabel);
}

function touchHeartbeat(ringState) {
  ringState.lastHeartbeatAt = new Date().toISOString();
}

function setRingPhase(ringState, phase) {
  const nextPhase = phase || 'idle';
  if (ringState.phase !== nextPhase || !ringState.phaseStartedAt) {
    ringState.phase = nextPhase;
    ringState.phaseStartedAt = new Date().toISOString();
    return;
  }
  ringState.phase = nextPhase;
}

function resetRingToScratch(ringState) {
  ringState.currentGroupId = '';
  ringState.queuedGroupIds = [];
  ringState.completedGroupIds = [];
  ringState.assistanceType = '';
  ringState.assistanceRequestedAt = '';
  ringState.tabletLabel = '';
  ringState.lastHeartbeatAt = '';
  ringState.phaseStartedAt = '';
  ringState.phase = 'idle';
}

function applyHeartbeatPolicy(state) {
  // Manual per-ring reset keeps a disconnected ring recoverable until an operator clears it.
  return false;
}

function resetAssignments(state) {
  state.rings = generateRings(state.config);
}

function setRingConfig(state, letterCount, numberCount) {
  state.config = normalizeConfig({ letterCount, numberCount });
  state.rings = generateRings(state.config);
}

function buildRingResponse(req, ringId, ringState) {
  return {
    ringId,
    ringLabel: ringState.ringLabel,
    serverBaseUrl: serverBaseUrlForRequest(req),
    currentGroupId: ringState.currentGroupId,
    queuedGroupIds: ringState.queuedGroupIds,
    completedGroupIds: ringState.completedGroupIds,
    assistanceType: ringState.assistanceType,
    assistanceRequestedAt: ringState.assistanceRequestedAt,
    tabletLabel: ringState.tabletLabel,
    lastHeartbeatAt: ringState.lastHeartbeatAt,
    phaseStartedAt: ringState.phaseStartedAt,
    phase: ringState.phase,
    currentGroup: loadGroup(ringState.currentGroupId)
  };
}

function serverBaseUrlForRequest(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function loadGroup(groupId) {
  if (!groupId) return null;
  const filePath = path.join(GROUPS_DIR, `${groupId}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

module.exports = {
  createEmptyRingState,
  normalizeRingState,
  normalizeConfig,
  generateRings,
  createDefaultAssignments,
  ensureStateStructure,
  readAssignmentsState,
  writeAssignmentsState,
  getRingState,
  listAllowedRingLabels,
  touchHeartbeat,
  setRingPhase,
  resetRingToScratch,
  applyHeartbeatPolicy,
  resetAssignments,
  setRingConfig,
  buildRingResponse,
  serverBaseUrlForRequest,
  loadGroup
};
