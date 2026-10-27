const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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

function buildFreshAssignments(sourceAssignments, groups) {
  const config = normalizeRingConfig(sourceAssignments && sourceAssignments.config);
  const sourceRings = sourceAssignments && sourceAssignments.rings &&
    typeof sourceAssignments.rings === 'object'
    ? sourceAssignments.rings
    : {};
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

  for (let letterIndex = 0; letterIndex < config.letterCount; letterIndex += 1) {
    const letter = LETTERS[letterIndex];
    for (let number = 1; number <= config.numberCount; number += 1) {
      const id = ringId(letter, number);
      const label = ringLabel(letter, number);
      const sourceRing = sourceRings[id] || sourceRings[label] || {};
      const assignedGroupDivisionNumbers = assignmentGroupNumbers(sourceRing);
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
      rings[id] = createFreshRingState(label, assignedGroupDivisionNumbers);
    }
  }
  return {
    config,
    eventStartedAt: '',
    rings
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

  function createRun({ eventName: sourceEventName, groups, assignments, now = () => new Date() }) {
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
    const freshAssignments = buildFreshAssignments(assignments, groups);
    const groupSnapshot = JSON.parse(JSON.stringify(groups));
    const assignmentSnapshot = JSON.parse(JSON.stringify(freshAssignments));
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
      speed: 10,
      groupCount: groupSnapshot.length,
      ringCount: Object.keys(assignmentSnapshot.rings).length,
      inputSnapshotSha256,
      assignedGroupCount: Object.values(assignmentSnapshot.rings)
        .reduce((count, ring) => count + ring.queuedGroupDivisionNumbers.length, 0)
    };
    if (!manifest.assignedGroupCount) {
      const error = new Error(`Event has no assigned, incomplete groups to simulate: ${eventName}`);
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
    const temporaryPath = `${manifestPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(nextManifest, null, 2), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporaryPath, manifestPath);
    return nextManifest;
  }

  function resetRun(runId) {
    const workspace = getRunWorkspace(runId);
    if (!workspace || workspace.manifest.runId !== String(runId)) return null;
    const initialAssignmentsPath = path.join(workspace.runDirectory, 'initial-ring-assignments.json');
    const initialAssignments = JSON.parse(fs.readFileSync(initialAssignmentsPath, 'utf8'));
    const assignmentsPath = path.join(workspace.runDirectory, 'ring-assignments.json');
    const temporaryAssignmentsPath = `${assignmentsPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporaryAssignmentsPath, JSON.stringify(initialAssignments, null, 2), {
      encoding: 'utf8',
      flag: 'wx'
    });
    fs.renameSync(temporaryAssignmentsPath, assignmentsPath);

    const resultsPath = path.join(workspace.runDirectory, 'results');
    fs.rmSync(resultsPath, { recursive: true, force: true });
    fs.mkdirSync(resultsPath);

    const resetManifest = {
      schemaVersion: workspace.manifest.schemaVersion,
      runId: workspace.manifest.runId,
      sourceEventName: workspace.manifest.sourceEventName,
      createdAt: workspace.manifest.createdAt,
      status: 'created',
      speed: 10,
      groupCount: workspace.manifest.groupCount,
      ringCount: workspace.manifest.ringCount,
      assignedGroupCount: workspace.manifest.assignedGroupCount,
      inputSnapshotSha256: workspace.manifest.inputSnapshotSha256
    };
    const manifestPath = path.join(workspace.runDirectory, 'manifest.json');
    const temporaryManifestPath = `${manifestPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporaryManifestPath, JSON.stringify(resetManifest, null, 2), {
      encoding: 'utf8',
      flag: 'wx'
    });
    fs.renameSync(temporaryManifestPath, manifestPath);
    return resetManifest;
  }

  function deleteRun(runId) {
    const workspace = getRunWorkspace(runId);
    if (!workspace || workspace.manifest.runId !== String(runId)) return false;
    fs.rmSync(workspace.runDirectory, { recursive: true, force: false });
    return true;
  }

  return { createRun, getRun, getRunWorkspace, updateRun, resetRun, deleteRun };
}

module.exports = {
  createSimulatorRunStore,
  normalizeEventName,
  buildFreshAssignments
};
