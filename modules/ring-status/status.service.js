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
    assignmentStartedAt: '',
    checkInCount: 0,
    checkInTotal: 0,
    phaseCompletedCount: 0,
    phaseTotalCount: 0,
    phaseProgress: 0,
    assistanceType: '',
    assistanceRequestedAt: '',
    tabletLabel: '',
    lastHeartbeatAt: '',
    phaseStartedAt: '',
    currentPhaseStartTime: '',
    currentPhaseEndTime: null,
    phaseHistory: [],
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
  normalized.assignmentStartedAt = ringState.currentGroupId
    ? (ringState.assignmentStartedAt || ringState.phaseStartedAt || ringState.lastHeartbeatAt || '')
    : '';
  normalized.checkInCount = clampInt(ringState.checkInCount, 0, 0, 9999);
  normalized.checkInTotal = clampInt(ringState.checkInTotal, 0, 0, 9999);
  normalized.phaseCompletedCount = clampInt(ringState.phaseCompletedCount, 0, 0, 9999);
  normalized.phaseTotalCount = clampInt(ringState.phaseTotalCount, 0, 0, 9999);
  normalized.phaseProgress = clampInt(ringState.phaseProgress, 0, 0, 100);
  normalized.assistanceType = ringState.assistanceType || '';
  normalized.assistanceRequestedAt = ringState.assistanceRequestedAt || '';
  normalized.tabletLabel = ringState.tabletLabel || '';
  normalized.lastHeartbeatAt = ringState.lastHeartbeatAt || '';
  normalized.phase = ringState.phase || 'idle';
  normalized.phaseStartedAt = ringState.phaseStartedAt || (normalized.phase !== 'idle' ? normalized.lastHeartbeatAt || '' : '');
  normalized.currentPhaseStartTime = ringState.currentPhaseStartTime || normalized.phaseStartedAt || '';
  normalized.currentPhaseEndTime = typeof ringState.currentPhaseEndTime === 'string' ? ringState.currentPhaseEndTime : null;
  normalized.phaseHistory = Array.isArray(ringState.phaseHistory)
    ? ringState.phaseHistory.map((entry) => ({
      name: String(entry && entry.name ? entry.name : '').trim(),
      startTime: String(entry && entry.startTime ? entry.startTime : '').trim(),
      endTime: entry && entry.endTime ? String(entry.endTime).trim() : null,
      elapsed: String(entry && entry.elapsed ? entry.elapsed : '').trim(),
      estimated: String(entry && entry.estimated ? entry.estimated : '').trim()
    })).filter((entry) => entry.name && entry.startTime)
    : [];
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

function normalizePhaseName(phase) {
  const normalized = String(phase || 'idle').trim().toLowerCase();
  if (normalized === 'check-in') return 'setup';
  return normalized || 'idle';
}

function formatDurationMs(ms) {
  const duration = Math.max(0, Math.floor(Number(ms) || 0));
  const totalSeconds = Math.floor(duration / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function getRingStartTime(ringState, state = {}) {
  const candidates = [
    ringState.assignmentStartedAt,
    ringState.currentPhaseStartTime,
    ringState.phaseStartedAt,
    ringState.lastHeartbeatAt,
    state.eventStartedAt
  ].filter(Boolean);
  for (const candidate of candidates) {
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return '';
}

function buildRingEstimateMs(currentGroup) {
  const competitorCount = currentGroup && Array.isArray(currentGroup.competitors) ? currentGroup.competitors.length : 0;
  if (competitorCount <= 0) return 0;
  return competitorCount * 7 * 60 * 1000;
}

function buildPhaseEstimateMs(phaseName, ringState, currentGroup) {
  const phase = normalizePhaseName(phaseName);
  const competitorCount = currentGroup && Array.isArray(currentGroup.competitors) ? currentGroup.competitors.length : 0;
  const setupTotal = Number.isFinite(Number(ringState.checkInTotal)) ? Number(ringState.checkInTotal) : competitorCount;
  const phaseTotal = Number.isFinite(Number(ringState.phaseTotalCount)) ? Number(ringState.phaseTotalCount) : competitorCount;
  const sparringByes = competitorCount % 2;
  const sparringActualBoutCount = Math.max(0, Math.floor((competitorCount - sparringByes) / 2));
  const unitByPhase = {
    setup: 7 * 60 * 1000,
    weapons: 5 * 60 * 1000,
    hyungs: 5 * 60 * 1000,
    sparring: 120 * 1000,
    awards: 2 * 60 * 1000
  };

  if (phase === 'setup') return Math.max(1, setupTotal || competitorCount || 1) * unitByPhase.setup;
  if (phase === 'sparring') return Math.max(1, sparringActualBoutCount || 1) * unitByPhase.sparring;
  if (phase === 'weapons' || phase === 'hyungs' || phase === 'awards') {
    return Math.max(1, phaseTotal || competitorCount || 1) * unitByPhase[phase];
  }
  return Math.max(1, competitorCount || 1) * unitByPhase.setup;
}

function buildSparringMetrics(currentGroup, ringState) {
  const competitorCount = currentGroup && Array.isArray(currentGroup.competitors) ? currentGroup.competitors.length : 0;
  const sparringByeCount = competitorCount % 2;
  const sparringActualBoutCount = Math.max(0, Math.floor((competitorCount - sparringByeCount) / 2));
  const sparringCompletedBoutCount = normalizePhaseName(ringState.phase) === 'sparring'
    ? Math.max(0, Number.parseInt(ringState.phaseCompletedCount, 10) || 0)
    : 0;
  return {
    sparringByeCount,
    sparringActualBoutCount,
    sparringCompletedBoutCount
  };
}

function buildPhaseHistory(ringState, currentGroup) {
  const now = Date.now();
  const currentPhaseName = normalizePhaseName(ringState.phase);
  const phaseHistory = Array.isArray(ringState.phaseHistory) ? ringState.phaseHistory : [];
  const sanitized = phaseHistory
    .map((entry) => ({
      name: normalizePhaseName(entry && entry.name),
      startTime: String(entry && entry.startTime ? entry.startTime : '').trim(),
      endTime: entry && entry.endTime ? String(entry.endTime).trim() : null,
      elapsed: String(entry && entry.elapsed ? entry.elapsed : '').trim(),
      estimated: String(entry && entry.estimated ? entry.estimated : '').trim()
    }))
    .filter((entry) => entry.name && entry.startTime);

  if (currentPhaseName !== 'idle') {
    const currentStart = ringState.currentPhaseStartTime || ringState.phaseStartedAt || ringState.lastHeartbeatAt || '';
    const estimatedMs = buildPhaseEstimateMs(currentPhaseName, ringState, currentGroup);
    const elapsedMs = currentStart && Number.isFinite(Date.parse(currentStart))
      ? Math.max(0, now - Date.parse(currentStart))
      : 0;
    const currentEntry = {
      name: currentPhaseName,
      startTime: currentStart,
      endTime: ringState.currentPhaseEndTime || null,
      elapsed: formatDurationMs(elapsedMs),
      estimated: formatDurationMs(estimatedMs)
    };
    if (currentEntry.startTime) {
      const last = sanitized[sanitized.length - 1];
      if (!last || last.name !== currentEntry.name || last.startTime !== currentEntry.startTime) {
        sanitized.push(currentEntry);
      } else {
        sanitized[sanitized.length - 1] = currentEntry;
      }
    }
  }

  return sanitized;
}

function buildRingTimingData(ringState, state = {}, currentGroup) {
  const currentPhaseName = normalizePhaseName(ringState.phase);
  const currentPhaseStartTime = currentPhaseName === 'idle'
    ? ''
    : (ringState.currentPhaseStartTime || ringState.phaseStartedAt || ringState.lastHeartbeatAt || '');
  const currentPhaseEndTime = currentPhaseName === 'idle'
    ? (ringState.currentPhaseEndTime || null)
    : null;
  const currentPhaseElapsed = currentPhaseStartTime && Number.isFinite(Date.parse(currentPhaseStartTime))
    ? formatDurationMs(Date.now() - Date.parse(currentPhaseStartTime))
    : '0:00';
  const currentPhaseEstimatedMs = buildPhaseEstimateMs(currentPhaseName, ringState, currentGroup);
  const currentPhaseEstimated = formatDurationMs(currentPhaseEstimatedMs);
  const currentPhaseCompletedCount = Math.max(0, Number.parseInt(
    currentPhaseName === 'setup' ? (ringState.checkInCount ?? ringState.phaseCompletedCount) : ringState.phaseCompletedCount,
    10
  ) || 0);
  const currentPhaseTotalCount = Math.max(0, Number.parseInt(
    currentPhaseName === 'setup' ? (ringState.checkInTotal ?? ringState.phaseTotalCount) : ringState.phaseTotalCount,
    10
  ) || 0);
  const sparringMetrics = buildSparringMetrics(currentGroup, ringState);
  const ringStartTime = getRingStartTime(ringState, state);
  const ringStartMs = ringStartTime && Number.isFinite(Date.parse(ringStartTime)) ? Date.parse(ringStartTime) : 0;
  const ringElapsedMs = ringStartMs > 0 ? Math.max(0, Date.now() - ringStartMs) : 0;
  const ringElapsed = formatDurationMs(ringElapsedMs);
  const ringEstimatedMs = buildRingEstimateMs(currentGroup);
  const ringEstimated = formatDurationMs(ringEstimatedMs);
  const ringPacePercent = ringStartMs > 0 && ringEstimatedMs > 0
    ? Math.round(((ringElapsedMs - ringEstimatedMs) / ringEstimatedMs) * 100)
    : 0;

  return {
    currentPhaseName,
    currentPhaseStartTime,
    currentPhaseEndTime,
    currentPhaseElapsed,
    currentPhaseEstimated,
    currentPhaseCompletedCount,
    currentPhaseTotalCount,
    sparringByeCount: sparringMetrics.sparringByeCount,
    sparringActualBoutCount: sparringMetrics.sparringActualBoutCount,
    sparringCompletedBoutCount: sparringMetrics.sparringCompletedBoutCount,
    ringElapsed,
    ringEstimated,
    ringPacePercent,
    phaseHistory: buildPhaseHistory(ringState, currentGroup)
  };
}

function touchHeartbeat(ringState) {
  ringState.lastHeartbeatAt = new Date().toISOString();
}

function setRingPhase(ringState, phase) {
  const nextPhase = phase || 'idle';
  const now = new Date().toISOString();
  const currentPhase = normalizePhaseName(ringState.phase);
  const nextPhaseName = normalizePhaseName(nextPhase);

  if (currentPhase !== 'idle' && currentPhase !== nextPhaseName && ringState.currentPhaseStartTime) {
    const history = Array.isArray(ringState.phaseHistory) ? ringState.phaseHistory.slice() : [];
    const lastEntry = history.length ? history[history.length - 1] : null;
    if (lastEntry && normalizePhaseName(lastEntry.name) === currentPhase && !lastEntry.endTime) {
      const elapsed = Date.parse(now) - Date.parse(lastEntry.startTime);
      lastEntry.endTime = now;
      lastEntry.elapsed = formatDurationMs(Number.isFinite(elapsed) ? elapsed : 0);
      history[history.length - 1] = lastEntry;
    }
    ringState.phaseHistory = history;
    ringState.currentPhaseEndTime = now;
  }

  ringState.phase = nextPhase;
  if (nextPhaseName === 'idle') {
    ringState.phaseStartedAt = '';
    ringState.currentPhaseStartTime = '';
    ringState.currentPhaseEndTime = ringState.currentPhaseEndTime || null;
    return;
  }

  if (!ringState.currentPhaseStartTime || currentPhase !== nextPhaseName) {
    ringState.currentPhaseStartTime = now;
    ringState.currentPhaseEndTime = null;
    ringState.phaseStartedAt = now;
    const history = Array.isArray(ringState.phaseHistory) ? ringState.phaseHistory.slice() : [];
    history.push({
      name: nextPhaseName,
      startTime: now,
      endTime: null,
      elapsed: '0:00',
      estimated: formatDurationMs(buildPhaseEstimateMs(nextPhaseName, ringState, loadGroup(ringState.currentGroupId)))
    });
    ringState.phaseHistory = history;
    return;
  }

  ringState.phaseStartedAt = ringState.currentPhaseStartTime;
}

function resetRingToScratch(ringState) {
  ringState.currentGroupId = '';
  ringState.queuedGroupIds = [];
  ringState.completedGroupIds = [];
  ringState.assignmentStartedAt = '';
  ringState.checkInCount = 0;
  ringState.checkInTotal = 0;
  ringState.phaseCompletedCount = 0;
  ringState.phaseTotalCount = 0;
  ringState.phaseProgress = 0;
  ringState.assistanceType = '';
  ringState.assistanceRequestedAt = '';
  ringState.tabletLabel = '';
  ringState.lastHeartbeatAt = '';
  ringState.phaseStartedAt = '';
  ringState.currentPhaseStartTime = '';
  ringState.currentPhaseEndTime = null;
  ringState.phaseHistory = [];
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
  const currentGroup = loadGroup(ringState.currentGroupId);
  const timingData = buildRingTimingData(ringState, {}, currentGroup);
  return {
    ringId,
    ringLabel: ringState.ringLabel,
    serverBaseUrl: serverBaseUrlForRequest(req),
    assignmentStartedAt: ringState.assignmentStartedAt,
    currentGroupId: ringState.currentGroupId,
    queuedGroupIds: ringState.queuedGroupIds,
    completedGroupIds: ringState.completedGroupIds,
    checkInCount: ringState.checkInCount,
    checkInTotal: ringState.checkInTotal,
    phaseCompletedCount: ringState.phaseCompletedCount,
    phaseTotalCount: ringState.phaseTotalCount,
    phaseProgress: ringState.phaseProgress,
    assistanceType: ringState.assistanceType,
    assistanceRequestedAt: ringState.assistanceRequestedAt,
    tabletLabel: ringState.tabletLabel,
    lastHeartbeatAt: ringState.lastHeartbeatAt,
    phaseStartedAt: ringState.phaseStartedAt,
    phase: ringState.phase,
    currentGroup,
    currentPhaseName: timingData.currentPhaseName,
    currentPhaseStartTime: timingData.currentPhaseStartTime,
    currentPhaseEndTime: timingData.currentPhaseEndTime,
    currentPhaseElapsed: timingData.currentPhaseElapsed,
    currentPhaseEstimated: timingData.currentPhaseEstimated,
    currentPhaseCompletedCount: timingData.currentPhaseCompletedCount,
    currentPhaseTotalCount: timingData.currentPhaseTotalCount,
    sparringByeCount: timingData.sparringByeCount,
    sparringActualBoutCount: timingData.sparringActualBoutCount,
    sparringCompletedBoutCount: timingData.sparringCompletedBoutCount,
    ringElapsed: timingData.ringElapsed,
    ringEstimated: timingData.ringEstimated,
    ringPacePercent: timingData.ringPacePercent,
    phaseHistory: timingData.phaseHistory
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
