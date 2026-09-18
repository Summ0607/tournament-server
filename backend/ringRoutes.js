const express = require('express');

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

  router.get('/rings/config', (req, res) => {
    const state = readAssignmentsState();
    if (applyHeartbeatPolicy(state)) writeAssignmentsState(state);
    return res.json({
      config: state.config,
      heartbeatPolicy: {
        disconnectAfterSeconds: DISCONNECT_AFTER_MS / 1000,
        resetMode: 'manual'
      },
      allowedRings: Object.entries(state.rings).map(([ringId, ringState]) => ({
        ringId,
        ringLabel: ringState.ringLabel
      }))
    });
  });

  router.post('/rings/config', (req, res) => {
    const state = readAssignmentsState();
    if (applyHeartbeatPolicy(state)) writeAssignmentsState(state);
    const { letterCount, numberCount } = req.body || {};
    setRingConfig(state, letterCount, numberCount);
    writeAssignmentsState(state);
    return res.json({
      ok: true,
      config: state.config,
      message: 'Ring configuration applied. All rings reset to unassigned.'
    });
  });

  router.get('/rings', (req, res) => {
    const state = readAssignmentsState();
    if (applyHeartbeatPolicy(state)) writeAssignmentsState(state);
    const rings = Object.entries(state.rings).map(([ringId, ringState]) => ({
      ringId,
      ringLabel: ringState.ringLabel,
      currentGroupId: ringState.currentGroupId,
      queuedGroupIds: ringState.queuedGroupIds,
      completedGroupIds: ringState.completedGroupIds,
      assistanceType: ringState.assistanceType,
      assistanceRequestedAt: ringState.assistanceRequestedAt,
      tabletLabel: ringState.tabletLabel,
      lastHeartbeatAt: ringState.lastHeartbeatAt,
      phaseStartedAt: ringState.phaseStartedAt,
      phase: ringState.phase,
      currentGroupName: (loadGroup(ringState.currentGroupId) || {}).name || ''
    }));

    return res.json({
      serverBaseUrl: serverBaseUrlForRequest(req),
      ringConfig: state.config,
      heartbeatPolicy: {
        disconnectAfterSeconds: DISCONNECT_AFTER_MS / 1000,
        resetMode: 'manual'
      },
      rings
    });
  });

  router.get('/rings/:ringId/bootstrap', (req, res) => {
    const state = readAssignmentsState();
    if (applyHeartbeatPolicy(state)) writeAssignmentsState(state);
    const ringId = String(req.params.ringId || '').trim();
    const ringState = getRingState(state, ringId);
    if (!ringState) {
      return res.status(400).json({
        error: `Invalid ring '${ringId}'. Allowed rings: ${listAllowedRingLabels(state).join(', ')}`
      });
    }

    const tabletLabel = String(req.query.tabletLabel || '').trim();
    if (tabletLabel) {
      ringState.tabletLabel = tabletLabel;
      touchHeartbeat(ringState);
      if (!ringState.phase || ringState.phase === 'idle') {
        setRingPhase(ringState, 'check-in');
      }
    }

    writeAssignmentsState(state);
    return res.json(buildRingResponse(req, ringId, ringState));
  });

  router.get('/rings/:ringId/current', (req, res) => {
    const state = readAssignmentsState();
    if (applyHeartbeatPolicy(state)) writeAssignmentsState(state);
    const ringId = String(req.params.ringId || '').trim();
    const ringState = getRingState(state, ringId);
    if (!ringState) {
      return res.status(400).json({
        error: `Invalid ring '${ringId}'. Allowed rings: ${listAllowedRingLabels(state).join(', ')}`
      });
    }
    return res.json(buildRingResponse(req, ringId, ringState));
  });

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
    touchHeartbeat(ringState);
    writeAssignmentsState(state);

    return res.json(buildRingResponse(req, ringId, ringState));
  });

  router.post('/rings/:ringId/reset', (req, res) => {
    const state = readAssignmentsState();
    if (applyHeartbeatPolicy(state)) writeAssignmentsState(state);
    const ringId = String(req.params.ringId || '').trim();
    const ringState = getRingState(state, ringId);
    if (!ringState) {
      return res.status(400).json({
        error: `Invalid ring '${ringId}'. Allowed rings: ${listAllowedRingLabels(state).join(', ')}`
      });
    }

    resetRingToScratch(ringState);
    writeAssignmentsState(state);
    return res.json(buildRingResponse(req, ringId, ringState));
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
    writeAssignmentsState(state);
    return res.json(buildRingResponse(req, ringId, ringState));
  });

  router.post('/rings/:ringId/heartbeat', (req, res) => {
    const state = readAssignmentsState();
    if (applyHeartbeatPolicy(state)) writeAssignmentsState(state);
    const ringId = String(req.params.ringId || '').trim();
    const ringState = getRingState(state, ringId);
    if (!ringState) {
      return res.status(400).json({
        error: `Invalid ring '${ringId}'. Allowed rings: ${listAllowedRingLabels(state).join(', ')}`
      });
    }

    const tabletLabel = String(req.body.tabletLabel || '').trim();
    const phase = String(req.body.phase || '').trim();
    if (tabletLabel) ringState.tabletLabel = tabletLabel;
    if (phase) setRingPhase(ringState, phase);
    touchHeartbeat(ringState);
    writeAssignmentsState(state);
    return res.json(buildRingResponse(req, ringId, ringState));
  });

  router.post('/rings/:ringId/assistance', (req, res) => {
    const state = readAssignmentsState();
    if (applyHeartbeatPolicy(state)) writeAssignmentsState(state);
    const ringId = String(req.params.ringId || '').trim();
    const ringState = getRingState(state, ringId);
    if (!ringState) {
      return res.status(400).json({
        error: `Invalid ring '${ringId}'. Allowed rings: ${listAllowedRingLabels(state).join(', ')}`
      });
    }

    const assistanceType = String(req.body.type || '').trim().toLowerCase();
    if (!['medical', 'arbitrator', 'general'].includes(assistanceType)) {
      return res.status(400).json({ error: 'type must be one of: medical, arbitrator, general' });
    }

    ringState.assistanceType = assistanceType;
    ringState.assistanceRequestedAt = new Date().toISOString();
    touchHeartbeat(ringState);
    writeAssignmentsState(state);
    return res.json(buildRingResponse(req, ringId, ringState));
  });

  router.post('/rings/:ringId/assistance/clear', (req, res) => {
    const state = readAssignmentsState();
    if (applyHeartbeatPolicy(state)) writeAssignmentsState(state);
    const ringId = String(req.params.ringId || '').trim();
    const ringState = getRingState(state, ringId);
    if (!ringState) {
      return res.status(400).json({
        error: `Invalid ring '${ringId}'. Allowed rings: ${listAllowedRingLabels(state).join(', ')}`
      });
    }

    ringState.assistanceType = '';
    ringState.assistanceRequestedAt = '';
    writeAssignmentsState(state);
    return res.json(buildRingResponse(req, ringId, ringState));
  });

  router.post('/reset', (req, res) => {
    const state = readAssignmentsState();
    if (applyHeartbeatPolicy(state)) writeAssignmentsState(state);
    resetAssignments(state);
    writeAssignmentsState(state);
    return res.json({ ok: true, message: 'Tournament reset. All rings cleared.' });
  });

  router.delete('/rings/:ringId/queue/:groupId', (req, res) => {
    const { ringId, groupId } = req.params;
    const state = readAssignmentsState();
    if (applyHeartbeatPolicy(state)) writeAssignmentsState(state);
    const ringState = getRingState(state, ringId);
    if (!ringState) {
      return res.status(400).json({
        error: `Invalid ring '${ringId}'. Allowed rings: ${listAllowedRingLabels(state).join(', ')}`
      });
    }

    const before = ringState.queuedGroupIds.length;
    ringState.queuedGroupIds = ringState.queuedGroupIds.filter((id) => id !== groupId);
    if (ringState.queuedGroupIds.length === before) {
      return res.status(404).json({ error: `Group not in queue: ${groupId}` });
    }

    writeAssignmentsState(state);
    return res.json(buildRingResponse(req, ringId, ringState));
  });

  return router;
}

module.exports = {
  createRingRouter
};
