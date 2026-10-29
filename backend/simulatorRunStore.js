const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { compareRunningOrder } = require('../assets/division-rules');
const { normalizeTournamentDays, isDayBlocked } = require('./tournamentSchedule');
const { writeJsonAtomicSync } = require('./atomicJsonFile');

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function normalizeEventName(value) {
  const eventName = String(value || '').trim();
  if (!eventName || eventName === '.' || eventName === '..' ||
      path.basename(eventName) !== eventName || /[<>:"/\\|?*\x00-\x1F]/.test(eventName)) {
    const error = new Error('eventName must identify an existing event');
    error.statusCode = 400;
    throw error;
  }
  return eventName;
}

function normalizeRingConfig(config) {
  const source = config && typeof config === 'object' ? config : {};
  const letterCount = source.letterCount;
  const numberCount = source.numberCount;
  if (!Number.isInteger(letterCount) || letterCount < 1 || letterCount > 26 ||
      !Number.isInteger(numberCount) || numberCount < 1 || numberCount > 50) {
    const error = new Error('Saved ring configuration must contain valid letterCount and numberCount');
    error.statusCode = 409;
    throw error;
  }
  return { letterCount, numberCount };
}

function ringLabel(letter, number) {
  return `${letter}${number}`;
}

function ringId(letter, number) {
  return `ring-${letter.toLowerCase()}-${number}`;
}

function stringGroupNumber(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? String(parsed) : String(value || '').trim();
}

function assignmentGroupNumbers(ringState) {
  const current = stringGroupNumber(
    ringState && (ringState.groupDivisionNumber || ringState.currentGroupDivisionNumber || ringState.currentGroupId)
  );
  const queued = Array.isArray(ringState && ringState.queuedGroupDivisionNumbers)
    ? ringState.queuedGroupDivisionNumbers
    : Array.isArray(ringState && ringState.queuedGroupIds)
      ? ringState.queuedGroupIds
      : [];
  const completed = new Set((Array.isArray(ringState && ringState.completedGroupDivisionNumbers)
    ? ringState.completedGroupDivisionNumbers
    : Array.isArray(ringState && ringState.completedGroupIds)
      ? ringState.completedGroupIds
      : []).map(stringGroupNumber));
  return [...new Set([current, ...queued.map(stringGroupNumber)].filter(Boolean))]
    .filter((groupNumber) => !completed.has(groupNumber));
}

function completedGroupNumbersForAssignments(assignments) {
  const rings = assignments && assignments.rings && typeof assignments.rings === 'object'
    ? Object.values(assignments.rings)
    : [];
  return new Set(rings.flatMap((ring) => (
    Array.isArray(ring && ring.completedGroupDivisionNumbers)
      ? ring.completedGroupDivisionNumbers
      : Array.isArray(ring && ring.completedGroupIds) ? ring.completedGroupIds : []
  )).map(stringGroupNumber));
}

function createFreshRingState(label, groupNumbers) {
  return {
    ringLabel: label,
    groupDivisionNumber: '',
    queuedGroupDivisionNumbers: groupNumbers.slice(),
    completedGroupDivisionNumbers: [],
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
    phase: 'idle'
  };
}

function buildFreshAssignments(sourceAssignments, groups, tournamentDays = 1) {
  const schedule = { tournamentDays: normalizeTournamentDays(tournamentDays), day2Started: false };
  groups = groups.slice().sort(compareRunningOrder);
  const config = normalizeRingConfig(sourceAssignments && sourceAssignments.config);
  const sourceRings = sourceAssignments && sourceAssignments.rings &&
    typeof sourceAssignments.rings === 'object'
    ? sourceAssignments.rings
    : {};
  const completedGroupNumbers = completedGroupNumbersForAssignments({ rings: sourceRings });
  const groupNumbers = new Set();
  for (const group of groups) {
    const groupNumber = stringGroupNumber(group && (group.groupDivisionNumber ?? group.id ?? group.groupId));
    if (!groupNumber) {
      const error = new Error('A saved group is missing its division number');
      error.statusCode = 409;
      throw error;
    }
    if (groupNumbers.has(groupNumber)) {
      const error = new Error(`Saved groups contain duplicate division number ${groupNumber}`);
      error.statusCode = 409;
      throw error;
    }
    groupNumbers.add(groupNumber);
  }
  const rings = {};
  const assigned = new Set();
  const manualQueues = {};

  for (let letterIndex = 0; letterIndex < config.letterCount; letterIndex += 1) {
    const letter = LETTERS[letterIndex];
    for (let number = 1; number <= config.numberCount; number += 1) {
      const id = ringId(letter, number);
      const label = ringLabel(letter, number);
      const sourceRing = sourceRings[id] || sourceRings[label] || {};
      const assignedGroupDivisionNumbers = assignmentGroupNumbers(sourceRing)
        .filter((groupNumber) => !completedGroupNumbers.has(groupNumber));
      for (const groupNumber of assignedGroupDivisionNumbers) {
        if (!groupNumbers.has(groupNumber)) {
          const error = new Error(`Ring ${label} references missing saved group ${groupNumber}`);
          error.statusCode = 409;
          throw error;
        }
        if (assigned.has(groupNumber)) {
          const error = new Error(`Saved group ${groupNumber} is assigned to more than one ring`);
          error.statusCode = 409;
          throw error;
        }
        assigned.add(groupNumber);
      }
      manualQueues[id] = assignedGroupDivisionNumbers;
      const firstGroup = groups.find((group) =>
        stringGroupNumber(group.groupDivisionNumber ?? group.id ?? group.groupId) === assignedGroupDivisionNumbers[0]);
      rings[id] = createFreshRingState(label, firstGroup && !isDayBlocked(firstGroup, schedule)
        ? assignedGroupDivisionNumbers.slice(0, 1) : []);
    }
  }
  const pendingGroupDivisionNumbers = [];
  for (const [id, groupNumbersForRing] of Object.entries(manualQueues)) {
    for (const groupNumber of groupNumbersForRing.filter((number) =>
      !rings[id].queuedGroupDivisionNumbers.includes(number))) {
      pendingGroupDivisionNumbers.push({ groupDivisionNumber: groupNumber, preferredRingId: null });
    }
  }
  const automaticGroupDivisionNumbers = [];
  for (const group of groups) {
    const groupNumber = stringGroupNumber(group && (group.groupDivisionNumber ?? group.id ?? group.groupId));
    if (completedGroupNumbers.has(groupNumber) || assigned.has(groupNumber)) continue;
    assigned.add(groupNumber);
    automaticGroupDivisionNumbers.push(groupNumber);
    pendingGroupDivisionNumbers.push({ groupDivisionNumber: groupNumber, preferredRingId: null });
  }
  const groupMap = new Map(groups.map((group) => [stringGroupNumber(group.groupDivisionNumber ?? group.id ?? group.groupId), group]));
  pendingGroupDivisionNumbers.sort((a, b) => compareRunningOrder(
    groupMap.get(a.groupDivisionNumber), groupMap.get(b.groupDivisionNumber)));
  for (const ring of Object.values(rings)) {
    if (ring.queuedGroupDivisionNumbers.length) continue;
    const index = pendingGroupDivisionNumbers.findIndex((entry) =>
      !isDayBlocked(groupMap.get(entry.groupDivisionNumber), schedule));
    if (index >= 0) ring.queuedGroupDivisionNumbers.push(pendingGroupDivisionNumbers.splice(index, 1)[0].groupDivisionNumber);
  }
  return {
    config,
    tournamentDays: schedule.tournamentDays,
    day2StartedAt: '',
    sourceCompletedGroupDivisionNumbers: [...completedGroupNumbers],
    eventStartedAt: '',
    rings,
    pendingGroupDivisionNumbers,
    automaticGroupDivisionNumbers
  };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
}

function createSimulatorRunStore({ runsRoot }) {
  if (!runsRoot) throw new Error('runsRoot is required');

  function runDirectoryFor(runId) {
    const normalizedRunId = String(runId || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(normalizedRunId)) return null;
    return path.join(runsRoot, normalizedRunId);
  }

  function createRun({ eventName: sourceEventName, groups, assignments, tournamentDays = 1, now = () => new Date() }) {
    const eventName = normalizeEventName(sourceEventName);
    if (!Array.isArray(groups) || groups.length === 0) {
      const error = new Error(`Event has no saved groups to simulate: ${eventName}`);
      error.statusCode = 409;
      throw error;
    }
    if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) {
      const error = new Error(`Event has no valid saved ring assignments: ${eventName}`);
      error.statusCode = 409;
      throw error;
    }
    if (typeof now !== 'function') throw new Error('now must be a function');
    const createdAt = now().toISOString();
    const runId = crypto.randomUUID();
    const runDirectory = path.join(runsRoot, runId);
    const temporaryDirectory = path.join(runsRoot, `.creating-${runId}`);
    const freshAssignments = buildFreshAssignments(assignments, groups, tournamentDays);
    const groupSnapshot = JSON.parse(JSON.stringify(groups));
    const assignmentSnapshot = JSON.parse(JSON.stringify(freshAssignments));
    const completedGroupNumbers = completedGroupNumbersForAssignments(assignments);
    const eligibleGroupCount = groupSnapshot.filter((group) =>
      !completedGroupNumbers.has(
        stringGroupNumber(group.groupDivisionNumber ?? group.id ?? group.groupId)
      )).length;
    const inputSnapshotSha256 = crypto.createHash('sha256')
      .update(JSON.stringify({
        sourceEventName: eventName,
        groups: groupSnapshot,
        assignments: assignmentSnapshot
      }))
      .digest('hex');
    const manifest = {
      schemaVersion: 1,
      runId,
      sourceEventName: eventName,
      createdAt,
      status: 'created',
      speed: 600,
      groupCount: groupSnapshot.length,
      ringCount: Object.keys(assignmentSnapshot.rings).length,
      inputSnapshotSha256,
      assignedGroupCount: eligibleGroupCount,
      autoAssignedGroupCount: assignmentSnapshot.automaticGroupDivisionNumbers.length
    };
    if (!manifest.assignedGroupCount) {
      const error = new Error(`Event has no incomplete saved divisions to simulate: ${eventName}`);
      error.statusCode = 409;
      throw error;
    }

    fs.mkdirSync(runsRoot, { recursive: true });
    fs.mkdirSync(temporaryDirectory);
    try {
      fs.mkdirSync(path.join(temporaryDirectory, 'results'));
      writeJson(path.join(temporaryDirectory, 'manifest.json'), manifest);
      writeJson(path.join(temporaryDirectory, 'groups.json'), groupSnapshot);
      writeJson(path.join(temporaryDirectory, 'ring-assignments.json'), assignmentSnapshot);
      writeJson(path.join(temporaryDirectory, 'initial-ring-assignments.json'), assignmentSnapshot);
      fs.renameSync(temporaryDirectory, runDirectory);
    } catch (error) {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
    return {
      ...manifest
    };
  }

  function getRun(runId) {
    const runDirectory = runDirectoryFor(runId);
    if (!runDirectory) return null;
    const manifestPath = path.join(runDirectory, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return null;
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }

  function listRuns() {
    if (!fs.existsSync(runsRoot)) return [];
    return fs.readdirSync(runsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => getRun(entry.name))
      .filter(Boolean)
      .map(({ runId, sourceEventName, createdAt, status, speed }) => ({
        runId, sourceEventName, createdAt, status, speed
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  function getRunWorkspace(runId) {
    const runDirectory = runDirectoryFor(runId);
    if (!runDirectory || !fs.existsSync(path.join(runDirectory, 'manifest.json'))) return null;
    return {
      runDirectory,
      manifest: JSON.parse(fs.readFileSync(path.join(runDirectory, 'manifest.json'), 'utf8')),
      groups: JSON.parse(fs.readFileSync(path.join(runDirectory, 'groups.json'), 'utf8')),
      assignments: JSON.parse(fs.readFileSync(path.join(runDirectory, 'ring-assignments.json'), 'utf8'))
    };
  }

  function updateRun(runId, updates) {
    const workspace = getRunWorkspace(runId);
    if (!workspace) return null;
    const nextManifest = { ...workspace.manifest, ...updates };
    const manifestPath = path.join(workspace.runDirectory, 'manifest.json');
    writeJsonAtomicSync(manifestPath, nextManifest);
    return nextManifest;
  }

  function resetRun(runId) {
    const workspace = getRunWorkspace(runId);
    if (!workspace || workspace.manifest.runId !== String(runId)) return null;
    const initialAssignmentsPath = path.join(workspace.runDirectory, 'initial-ring-assignments.json');
    const initialAssignments = JSON.parse(fs.readFileSync(initialAssignmentsPath, 'utf8'));
    const assignmentsPath = path.join(workspace.runDirectory, 'ring-assignments.json');
    writeJsonAtomicSync(assignmentsPath, initialAssignments);

    const resultsPath = path.join(workspace.runDirectory, 'results');
    fs.rmSync(resultsPath, { recursive: true, force: true });
    fs.mkdirSync(resultsPath);

    const resetManifest = {
      schemaVersion: workspace.manifest.schemaVersion,
      runId: workspace.manifest.runId,
      sourceEventName: workspace.manifest.sourceEventName,
      createdAt: workspace.manifest.createdAt,
      status: 'created',
      speed: workspace.manifest.speed,
      groupCount: workspace.manifest.groupCount,
      ringCount: workspace.manifest.ringCount,
      assignedGroupCount: workspace.manifest.assignedGroupCount,
      autoAssignedGroupCount: workspace.manifest.autoAssignedGroupCount || 0,
      inputSnapshotSha256: workspace.manifest.inputSnapshotSha256
    };
    const manifestPath = path.join(workspace.runDirectory, 'manifest.json');
    writeJsonAtomicSync(manifestPath, resetManifest);
    return resetManifest;
  }

  function deleteRun(runId) {
    const workspace = getRunWorkspace(runId);
    if (!workspace || workspace.manifest.runId !== String(runId)) return false;
    fs.rmSync(workspace.runDirectory, { recursive: true, force: false });
    return true;
  }

  return { createRun, getRun, listRuns, getRunWorkspace, updateRun, resetRun, deleteRun };
}

module.exports = {
  createSimulatorRunStore,
  normalizeEventName,
  buildFreshAssignments
};
