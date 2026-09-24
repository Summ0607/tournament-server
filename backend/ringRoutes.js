const express = require('express');
const fs = require('fs');
const path = require('path');
const { appendDivisionTrace, summarizeGroupDivisionNumbers } = require('./groupDivisionAssignments');

const HEARTBEAT_TRACE_PATH = path.join(__dirname, 'ring-progress-trace.log');

function appendHeartbeatTrace(ringId, snapshot) {
  const line = `${new Date().toISOString()} ring=${ringId} ${JSON.stringify(snapshot)}\n`;
  try {
    fs.appendFileSync(HEARTBEAT_TRACE_PATH, line, 'utf8');
  } catch (error) {
    console.error('Failed to write heartbeat trace:', error);
  }
}

function createRingRouter(deps) {
  const router = express.Router();
  const {
    readAssignmentsState,
    writeAssignmentsState,
    applyHeartbeatPolicy,
    setRingConfig,
    getRingState,
    listAllowedRingLabels,
    buildRingResponse,
    touchHeartbeat,
    setRingPhase,
    resetRingToScratch,
    resetAssignments,
    groupExists,
    findGroupUsageAcrossRings,
    loadGroup,
    serverBaseUrlForRequest,
    DISCONNECT_AFTER_MS,
    saveUploadedDivisionPacket
  } = deps;

  function touchEventStart(state) {
    if (!state.eventStartedAt) {
      state.eventStartedAt = new Date().toISOString();
      return true;
    }
    return false;
  }

  function phaseDefinitionsForGroup(group) {
    const competitors = group && Array.isArray(group.competitors) ? group.competitors : [];
    const hasWeapons = competitors.some((competitor) => {
      if (competitor && competitor.weaponsEligible) return true;
      const division = String(competitor && competitor.weaponsDivision ? competitor.weaponsDivision : '').trim().toLowerCase();
      return division && division !== 'unassigned';
    });

    return [
      { key: 'setup', label: 'Setup', visible: true },
      { key: 'weapons', label: 'Weapons', visible: hasWeapons },
      { key: 'hyungs', label: 'Hyungs', visible: true },
      { key: 'sparring', label: 'Sparring', visible: true },
      { key: 'awards', label: 'Awards', visible: true }
    ].filter((phase) => phase.visible);
  }

  function touchAssignmentStart(ringState) {
    if (!ringState.assignmentStartedAt) {
      ringState.assignmentStartedAt = new Date().toISOString();
    }
  }

  function phaseOrder(key) {
    const order = { setup: 0, weapons: 1, hyungs: 2, sparring: 3, awards: 4 };
    return Object.prototype.hasOwnProperty.call(order, key) ? order[key] : 99;
  }

  function normalizeProgressValue(value) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return 0;
    if (parsed <= 1) return Math.max(0, Math.min(1, parsed)) * 100;
    return Math.max(0, Math.min(100, parsed));
  }

  function buildPhasePlan(ringState, currentGroup) {
    const defs = phaseDefinitionsForGroup(currentGroup);
    const currentPhase = String(ringState.phase || 'idle').trim().toLowerCase();
    const normalizedPhase = currentPhase === 'check-in' ? 'setup' : currentPhase;
    const setupCompleted = Number.parseInt(ringState.checkInCount, 10);
    const setupTotal = Number.parseInt(ringState.checkInTotal, 10);
    const phaseCompletedCount = Number.parseInt(ringState.phaseCompletedCount, 10);
    const phaseTotalCount = Number.parseInt(ringState.phaseTotalCount, 10);
    const currentIndex = defs.findIndex((item) => item.key === normalizedPhase);

    function currentProgress() {
      if (Number.isFinite(phaseCompletedCount) && Number.isFinite(phaseTotalCount) && phaseTotalCount > 0) {
        return Math.max(0, Math.min(100, (phaseCompletedCount / phaseTotalCount) * 100));
      }
      return normalizeProgressValue(ringState.phaseProgress);
    }

    const phases = defs.map((phase, index) => {
      const phaseIndex = index;
      const isCurrent = phase.key === normalizedPhase;
      const isComplete = currentIndex > phaseIndex;
      const isUpcoming = currentIndex < phaseIndex && currentIndex !== -1;
      let progress = 0;
      let completedCount = 0;
      let totalCount = 0;

      if (phase.key === 'setup') {
        if (Number.isFinite(setupCompleted) && Number.isFinite(setupTotal) && setupTotal > 0) {
          completedCount = Math.max(0, setupCompleted);
          totalCount = Math.max(0, setupTotal);
          progress = Math.max(0, Math.min(100, (completedCount / totalCount) * 100));
        } else if (isCurrent) {
          completedCount = Number.isFinite(phaseCompletedCount) ? Math.max(0, phaseCompletedCount) : 0;
          totalCount = Number.isFinite(phaseTotalCount) ? Math.max(0, phaseTotalCount) : 0;
          progress = currentProgress();
        } else if (isComplete) {
          progress = 100;
        }
      } else if (isComplete) {
        progress = 100;
      } else if (isCurrent) {
        completedCount = Number.isFinite(phaseCompletedCount) ? Math.max(0, phaseCompletedCount) : 0;
        totalCount = Number.isFinite(phaseTotalCount) ? Math.max(0, phaseTotalCount) : 0;
        progress = currentProgress();
      }

      return {
        key: phase.key,
        label: phase.label,
        state: isComplete ? 'complete' : (isCurrent ? 'active' : (isUpcoming ? 'upcoming' : 'idle')),
        progress,
        completedCount,
        totalCount
      };
    });

    return {
      phases,
      currentPhase: normalizedPhase,
      currentPhaseIndex: defs.findIndex((item) => item.key === normalizedPhase),
      totalPhases: phases.length
    };
  }

  function attachProgressData(response, ringState) {
    const currentGroup = response.currentGroup || loadGroup(ringState.currentGroupId);
    response.phasePlan = buildPhasePlan(ringState, currentGroup);
    response.currentPhase = response.phasePlan.currentPhase;
    response.checkInCount = ringState.checkInCount || 0;
    response.checkInTotal = ringState.checkInTotal || 0;
    response.phaseCompletedCount = ringState.phaseCompletedCount || 0;
    response.phaseTotalCount = ringState.phaseTotalCount || 0;
    response.phaseProgress = ringState.phaseProgress || 0;
    response.currentGroup = currentGroup;
    return response;
  }

  function handleRequestGroup(req, res) {
    const state = readAssignmentsState();
    if (applyHeartbeatPolicy(state)) writeAssignmentsState(state);
    const ringId = String(req.params.ringId || '').trim();
    const ringState = getRingState(state, ringId);
    if (!ringState) {
      return res.status(400).json({
        error: `Invalid ring '${ringId}'. Allowed rings: ${listAllowedRingLabels(state).join(', ')}`
      });
    }

    const tabletLabel = String((req.body && req.body.tabletLabel) || req.query.tabletLabel || '').trim();
    const checkInCount = Number.parseInt(req.body && (req.body.checkInCount ?? req.body.checkedInCount), 10);
    const checkInTotal = Number.parseInt(req.body && (req.body.checkInTotal ?? req.body.checkedInTotal), 10);
    const phaseCompletedCount = Number.parseInt(req.body && (req.body.phaseCompletedCount ?? req.body.completedCount), 10);
    const phaseTotalCount = Number.parseInt(req.body && (req.body.phaseTotalCount ?? req.body.totalCount), 10);
    const phaseProgress = Number.parseFloat(req.body && (req.body.phaseProgress ?? req.body.progress));
    const isConnectRequest = req.method === 'POST';
    if (tabletLabel) {
      ringState.tabletLabel = tabletLabel;
      touchHeartbeat(ringState);
      touchEventStart(state);
      if (!ringState.phase || ringState.phase === 'idle') {
        setRingPhase(ringState, 'check-in');
      }
    }

    if (isConnectRequest && !ringState.currentGroupId && ringState.queuedGroupIds.length > 0) {
      ringState.currentGroupId = ringState.queuedGroupIds.shift() || '';
      if (ringState.currentGroupId) {
        touchAssignmentStart(ringState);
        setRingPhase(ringState, 'check-in');
        touchHeartbeat(ringState);
        touchEventStart(state);
        appendDivisionTrace('ring-activate', {
          ringId,
          ringLabel: ringState.ringLabel,
          source: 'bootstrap',
          groupId: ringState.currentGroupId,
          group: summarizeGroupDivisionNumbers([loadGroup(ringState.currentGroupId)])[0] || null
        });
      }
    }

    if (ringState.currentGroupId) {
      touchAssignmentStart(ringState);
    }

    if (Number.isFinite(checkInCount)) ringState.checkInCount = Math.max(0, checkInCount);
    if (Number.isFinite(checkInTotal)) ringState.checkInTotal = Math.max(0, checkInTotal);
    if (Number.isFinite(phaseCompletedCount)) ringState.phaseCompletedCount = Math.max(0, phaseCompletedCount);
    if (Number.isFinite(phaseTotalCount)) ringState.phaseTotalCount = Math.max(0, phaseTotalCount);
    if (Number.isFinite(phaseProgress)) {
      ringState.phaseProgress = Math.max(0, Math.min(100, phaseProgress > 1 ? phaseProgress : phaseProgress * 100));
    }

    writeAssignmentsState(state);
    return res.json(attachProgressData(buildRingResponse(req, ringId, ringState, state), ringState));
  }

  router.post('/rings/:ringId/complete', (req, res) => {
    const state = readAssignmentsState();
    if (applyHeartbeatPolicy(state)) writeAssignmentsState(state);
    const ringId = String(req.params.ringId || '').trim();
    const ringState = getRingState(state, ringId);
    if (!ringState) {
      return res.status(400).json({
        error: `Invalid ring '${ringId}'. Allowed rings: ${listAllowedRingLabels(state).join(', ')}`
      });
    }

    saveUploadedDivisionPacket(ringId, req.body);

    if (ringState.currentGroupId) {
      ringState.completedGroupIds.push(ringState.currentGroupId);
    }
    ringState.currentGroupId = ringState.queuedGroupIds.shift() || '';
    setRingPhase(ringState, ringState.currentGroupId ? 'check-in' : 'idle');
    if (ringState.currentGroupId) {
      touchAssignmentStart(ringState);
      appendDivisionTrace('ring-activate', {
        ringId,
        ringLabel: ringState.ringLabel,
        source: 'complete',
        groupId: ringState.currentGroupId,
        group: summarizeGroupDivisionNumbers([loadGroup(ringState.currentGroupId)])[0] || null
      });
    } else {
      ringState.assignmentStartedAt = '';
    }
    touchHeartbeat(ringState);
    touchEventStart(state);
    writeAssignmentsState(state);

    return res.json(attachProgressData(buildRingResponse(req, ringId, ringState, state), ringState));
  });

  router.post('/rings/:ringId/queue', (req, res) => {
    const groupId = String(req.body.groupId || '').trim();
    if (!groupId) {
      return res.status(400).json({ error: 'groupId is required' });
    }
    if (!groupExists(groupId)) {
      return res.status(404).json({ error: `Group not found: ${groupId}` });
    }

    const state = readAssignmentsState();
    if (applyHeartbeatPolicy(state)) writeAssignmentsState(state);
    const ringId = String(req.params.ringId || '').trim();
    const ringState = getRingState(state, ringId);
    if (!ringState) {
      return res.status(400).json({
        error: `Invalid ring '${ringId}'. Allowed rings: ${listAllowedRingLabels(state).join(', ')}`
      });
    }

    if (ringState.currentGroupId === groupId || ringState.queuedGroupIds.includes(groupId)) {
      return res.status(409).json({ error: `Group already assigned or queued: ${groupId}` });
    }
    const usage = findGroupUsageAcrossRings(state, groupId, ringId);
    if (usage) {
      return res.status(409).json({
        error: `Group ${groupId} is already assigned or queued in ${usage.ringLabel}. Remove it there before reassigning.`
      });
    }

    ringState.queuedGroupIds.push(groupId);
    touchHeartbeat(ringState);
    const queuedGroup = loadGroup(groupId);
    appendDivisionTrace('ring-queue', {
      ringId,
      groupId,
      ringLabel: ringState.ringLabel,
      group: queuedGroup ? summarizeGroupDivisionNumbers([queuedGroup])[0] : null
    });
    writeAssignmentsState(state);
    return res.json(attachProgressData(buildRingResponse(req, ringId, ringState, state), ringState));
  });

  return router;
}

module.exports = {
  createRingRouter
};
