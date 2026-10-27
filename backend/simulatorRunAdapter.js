const fs = require('fs');
const path = require('path');
const { createResultPacketStore } = require('./resultPacket');

function createSimulatorRunClientFactory({ simulatorRunStore }) {
  if (!simulatorRunStore || typeof simulatorRunStore.getRunWorkspace !== 'function') {
    throw new Error('simulatorRunStore must implement getRunWorkspace()');
  }

  const workspaces = new Map();

  function loadWorkspace(runId, eventName) {
    const cached = workspaces.get(runId);
    if (cached) {
      if (cached.manifest.sourceEventName !== eventName) {
        throw new Error(`Simulator run ${runId} does not belong to event ${eventName}`);
      }
      return cached;
    }

    const persisted = simulatorRunStore.getRunWorkspace(runId);
    if (!persisted) throw new Error(`Simulator run not found: ${runId}`);
    if (persisted.manifest.sourceEventName !== eventName) {
      throw new Error(`Simulator run ${runId} does not belong to event ${eventName}`);
    }
    const workspace = {
      ...persisted,
      results: createResultPacketStore({
        getResultsDirectory: () => path.join(persisted.runDirectory, 'results')
      })
    };
    workspaces.set(runId, workspace);
    return workspace;
  }

  function persistAssignments(workspace) {
    const target = path.join(workspace.runDirectory, 'ring-assignments.json');
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(workspace.assignments, null, 2), {
      encoding: 'utf8',
      flag: 'wx'
    });
    fs.renameSync(temporary, target);
  }

  function ringState(workspace, ringId) {
    const ring = workspace.assignments.rings[ringId];
    if (!ring) throw new Error(`Invalid simulator ring '${ringId}'`);
    return ring;
  }

  function groupFor(workspace, groupNumber) {
    return workspace.groups.find((group) =>
      String(group.groupDivisionNumber ?? group.id ?? group.groupId) === String(groupNumber)
    ) || null;
  }

  function createRunClient({ runId, eventName, ringId, ringLabel }) {
    const workspace = loadWorkspace(runId, eventName);
    const assignments = ringState(workspace, ringId);
    if (assignments.ringLabel !== ringLabel) {
      throw new Error(`Simulator ring label mismatch for ${ringId}`);
    }

    return {
      simulationScope: { kind: 'simulator-run', runId, eventName, ringId },

      async queue(groupDivisionNumber) {
        const groupNumber = String(groupDivisionNumber);
        const assigned = [
          assignments.groupDivisionNumber,
          ...assignments.queuedGroupDivisionNumbers
        ].filter(Boolean).map(String);
        if (!assigned.includes(groupNumber)) {
          throw new Error(`Group ${groupNumber} is not assigned to simulator ring ${ringId}`);
        }
        if (!groupFor(workspace, groupNumber)) {
          throw new Error(`Assigned simulator group ${groupNumber} is missing`);
        }
      },

      async bootstrap({ tabletLabel }) {
        if (!assignments.groupDivisionNumber) {
          assignments.groupDivisionNumber = assignments.queuedGroupDivisionNumbers.shift() || '';
        }
        assignments.currentGroupDivisionNumber = assignments.groupDivisionNumber;
        assignments.tabletLabel = String(tabletLabel || '');
        assignments.phase = assignments.groupDivisionNumber ? 'check-in' : 'idle';
        assignments.lastHeartbeatAt = new Date().toISOString();
        persistAssignments(workspace);
        return {
          ringId,
          ringLabel,
          currentGroupDivisionNumber: assignments.groupDivisionNumber,
          currentGroup: groupFor(workspace, assignments.groupDivisionNumber)
        };
      },

      async heartbeat({ tabletLabel, phase, checkInCount, checkInTotal, phaseCompletedCount, phaseTotalCount }) {
        if (!assignments.groupDivisionNumber) {
          throw new Error(`Simulator ring ${ringId} has no active group`);
        }
        if (assignments.tabletLabel !== String(tabletLabel || '')) {
          throw new Error(`Simulator tablet identity mismatch for ring ${ringId}`);
        }
        assignments.phase = phase === 'setup' ? 'check-in' : phase;
        assignments.lastHeartbeatAt = new Date().toISOString();
        assignments.checkInCount = Number.isFinite(checkInCount) ? checkInCount : assignments.checkInCount;
        assignments.checkInTotal = Number.isFinite(checkInTotal) ? checkInTotal : assignments.checkInTotal;
        assignments.phaseCompletedCount = Number.isFinite(phaseCompletedCount)
          ? phaseCompletedCount
          : assignments.phaseCompletedCount;
        assignments.phaseTotalCount = Number.isFinite(phaseTotalCount)
          ? phaseTotalCount
          : assignments.phaseTotalCount;
        assignments.phaseProgress = assignments.phaseTotalCount
          ? Math.min(100, (assignments.phaseCompletedCount / assignments.phaseTotalCount) * 100)
          : 0;
        persistAssignments(workspace);
      },

      async complete(packet) {
        if (!assignments.groupDivisionNumber ||
            String(packet.groupDivisionNumber ?? packet.groupId) !== String(assignments.groupDivisionNumber)) {
          throw new Error(`Result packet does not match active simulator group on ring ${ringId}`);
        }
        const existing = packet.submissionId
          ? workspace.results.findBySubmissionId(packet.submissionId)
          : null;
        if (!existing) {
          const validationErrors = workspace.results.validate(packet, ringId, eventName);
          if (validationErrors.length) {
            throw new Error(`Simulator result packet validation failed: ${validationErrors.join('; ')}`);
          }
          workspace.results.store(packet, { receivedAt: packet.completedAt });
        } else if (existing.groupDivisionNumber !== packet.groupDivisionNumber) {
          throw new Error(`Simulator submission ID was reused for a different group`);
        }

        const completedGroup = String(assignments.groupDivisionNumber);
        assignments.completedGroupDivisionNumbers.push(completedGroup);
        assignments.completedGroupIds = assignments.completedGroupDivisionNumbers;
        assignments.groupDivisionNumber = assignments.queuedGroupDivisionNumbers.shift() || '';
        assignments.currentGroupDivisionNumber = assignments.groupDivisionNumber;
        assignments.phase = assignments.groupDivisionNumber ? 'check-in' : 'idle';
        assignments.checkInCount = 0;
        assignments.checkInTotal = 0;
        assignments.phaseCompletedCount = 0;
        assignments.phaseTotalCount = 0;
        assignments.phaseProgress = 0;
        assignments.lastHeartbeatAt = new Date().toISOString();
        persistAssignments(workspace);
        return {
          serverRecordId: existing ? existing.serverRecordId : workspace.results.findBySubmissionId(packet.submissionId).serverRecordId,
          currentGroupDivisionNumber: assignments.groupDivisionNumber,
          currentGroup: groupFor(workspace, assignments.groupDivisionNumber)
        };
      }
    };
  }

  createRunClient.invalidateRun = (runId) => workspaces.delete(String(runId));
  return createRunClient;
}

module.exports = { createSimulatorRunClientFactory };
