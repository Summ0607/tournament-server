const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const { appendDivisionTrace, summarizeGroupDivisionNumbers } = require('./groupDivisionAssignments');
const { buildAvailableGroupDivisionNumbers } = require('./ringAvailability');
const { sanitizePhaseHistory } = require('./resultPacket');
const { buildEstimates } = require('./ringEstimates');
const { buildAudienceMonitor } = require('./audienceMonitor');

function resolveGroupAnchorValue(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed)) {
    return String(parsed);
  }
  return String(value || '').trim();
}

function resolveRequestCorrelationId(req, packet) {
  const headerId = String(
    req.get('x-request-id') ||
    req.get('x-correlation-id') ||
    req.get('x-amzn-trace-id') ||
    ''
  ).trim();
  if (headerId) return headerId;
  if (packet && typeof packet.acknowledgementId === 'string' && packet.acknowledgementId.trim()) {
    return packet.acknowledgementId.trim();
  }
  return crypto.randomUUID();
}

function logResultPacketEvent(stage, details) {
}

function logCompletionDiagnostics(stage, details) {
}

function historyKey(entry) {
  return `${String(entry && entry.name ? entry.name : '').trim()}|${String(entry && entry.startTime ? entry.startTime : '').trim()}`;
}

function resolveCompletionPhaseHistory(packet, fallbackHistory) {
  const clientHistory = sanitizePhaseHistory(packet && packet.completionSnapshot && packet.completionSnapshot.phaseHistory);
  const serverHistory = sanitizePhaseHistory(fallbackHistory);

  if (!clientHistory.length) {
    return serverHistory;
  }

  if (!serverHistory.length) {
    return clientHistory;
  }

  const serverByKey = new Map();
  serverHistory.forEach((entry) => {
    serverByKey.set(historyKey(entry), entry);
  });

  return clientHistory.map((entry) => {
    const serverEntry = serverByKey.get(historyKey(entry)) ||
      serverHistory.find((candidate) => candidate && candidate.name === entry.name) ||
      null;
    return {
      name: entry.name,
      startTime: entry.startTime,
      endTime: entry.endTime,
      elapsed: entry.elapsed,
      estimated: entry.estimated && String(entry.estimated).trim()
        ? entry.estimated
        : (serverEntry && serverEntry.estimated ? serverEntry.estimated : '')
    };
  });
}

function buildAcknowledgementResponse(payload) {
  const response = {
    ok: Boolean(payload.ok),
    accepted: Boolean(payload.accepted != null ? payload.accepted : payload.ok),
    status: payload.status || (payload.ok ? 'accepted' : 'rejected'),
    acknowledgementId: payload.acknowledgementId || '',
    submissionId: payload.submissionId || ''
  };

  if (payload.serverRecordId) response.serverRecordId = payload.serverRecordId;
  if (payload.receivedAt) response.receivedAt = payload.receivedAt;
  if (payload.ringAssignment) response.ringAssignment = payload.ringAssignment;
  if (payload.groupDivisionNumber != null && payload.groupDivisionNumber !== '') response.groupDivisionNumber = payload.groupDivisionNumber;
  if (payload.reason) response.reason = payload.reason;
  if (payload.message) response.message = payload.message;
  if (payload.errors) response.errors = payload.errors;
  if (payload.details) response.details = payload.details;
  if (payload.reasonChain) response.reasonChain = payload.reasonChain;
  if (payload.packetSummary) response.packetSummary = payload.packetSummary;

  return response;
}

function countNestedBouts(rounds) {
  let boutCount = 0;
  if (!Array.isArray(rounds)) return boutCount;
  rounds.forEach((round) => {
    if (round && Array.isArray(round.bouts)) boutCount += round.bouts.length;
  });
  return boutCount;
}

function summarizeResultPacket(packet) {
  const source = packet && typeof packet === 'object' ? packet : {};
  const disciplines = source.disciplines && typeof source.disciplines === 'object' ? source.disciplines : {};
  const sparring = disciplines.sparring && typeof disciplines.sparring === 'object' ? disciplines.sparring : {};
  const participants = Array.isArray(source.participants) ? source.participants : [];
  const signatures = Array.isArray(source.signatures) ? source.signatures : [];
  const overallAwards = source.overallAwards && typeof source.overallAwards === 'object' ? source.overallAwards : {};

  return {
    submissionId: source.submissionId || '',
    ringId: source.ringId || '',
    ringLabel: source.ringLabel || '',
    groupId: source.groupId || '',
    groupDivisionNumber: source.groupDivisionNumber != null ? source.groupDivisionNumber : null,
    participantCount: participants.length,
    disciplineCount: Object.keys(disciplines).length,
    weaponsResultCount: Array.isArray(disciplines.weapons && disciplines.weapons.results) ? disciplines.weapons.results.length : 0,
    hyungsResultCount: Array.isArray(disciplines.hyungs && disciplines.hyungs.results) ? disciplines.hyungs.results.length : 0,
    sparringRoundCount: Array.isArray(sparring.rounds) ? sparring.rounds.length : 0,
    sparringBoutCount: countNestedBouts(sparring.rounds),
    signatureCount: signatures.length,
    overallAwardsCount: ['weapons', 'hyungs', 'sparring'].reduce((sum, key) => {
      return sum + (Array.isArray(overallAwards[key]) ? overallAwards[key].length : 0);
    }, 0)
  };
}

function splitValidationErrors(validationErrors) {
  const schemaErrors = [];
  const businessRuleErrors = [];
  (Array.isArray(validationErrors) ? validationErrors : []).forEach((error) => {
    const text = String(error || '');
    const pathName = text.split(':')[0];
    if (pathName === 'eventName' || pathName === 'ringId' || pathName === 'groupDivisionNumber') {
      businessRuleErrors.push(text);
    } else {
      schemaErrors.push(text);
    }
  });
  return {
    schemaErrors,
    businessRuleErrors
  };
}

function normalizeRingAssignmentState(ringState) {
  if (!ringState || typeof ringState !== 'object') {
    return ringState;
  }

  if (!Array.isArray(ringState.queuedGroupDivisionNumbers)) {
    ringState.queuedGroupDivisionNumbers = [];
  }
  if (!ringState.queuedGroupDivisionNumbers.length && Array.isArray(ringState.queuedGroupIds) && ringState.queuedGroupIds.length) {
    ringState.queuedGroupDivisionNumbers = ringState.queuedGroupIds.map(resolveGroupAnchorValue);
  }
  if (!Array.isArray(ringState.completedGroupDivisionNumbers)) {
    ringState.completedGroupDivisionNumbers = [];
  }
  if (!ringState.completedGroupDivisionNumbers.length && Array.isArray(ringState.completedGroupIds) && ringState.completedGroupIds.length) {
    ringState.completedGroupDivisionNumbers = ringState.completedGroupIds.map(resolveGroupAnchorValue);
  }

  ringState.queuedGroupIds = Array.isArray(ringState.queuedGroupIds)
    ? ringState.queuedGroupIds
    : ringState.queuedGroupDivisionNumbers;
  ringState.completedGroupIds = Array.isArray(ringState.completedGroupIds)
    ? ringState.completedGroupIds
    : ringState.completedGroupDivisionNumbers;

  const currentGroupDivisionNumber = String(
    ringState.groupDivisionNumber != null && ringState.groupDivisionNumber !== ''
      ? ringState.groupDivisionNumber
      : (ringState.currentGroupDivisionNumber != null && ringState.currentGroupDivisionNumber !== ''
        ? ringState.currentGroupDivisionNumber
        : (ringState.currentGroupId || ''))
  ).trim();
  ringState.groupDivisionNumber = currentGroupDivisionNumber;
  ringState.currentGroupDivisionNumber = currentGroupDivisionNumber;
  ringState.currentGroupId = currentGroupDivisionNumber;

  return ringState;
}

function buildRejectionResponse(payload) {
  return buildAcknowledgementResponse({
    ok: false,
    accepted: false,
    status: payload.status || 'rejected',
    acknowledgementId: payload.acknowledgementId || '',
    submissionId: payload.submissionId || '',
    reason: payload.reason || 'rejected',
    message: payload.message || '',
    details: payload.details || [],
    errors: payload.errors || undefined,
    reasonChain: payload.reasonChain || [],
    packetSummary: payload.packetSummary || undefined,
    groupDivisionNumber: payload.groupDivisionNumber || '',
    receivedAt: payload.receivedAt || ''
  });
}

function appendHeartbeatTrace(ringId, snapshot) {
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
    loadGroups,
    serverBaseUrlForRequest,
    DISCONNECT_AFTER_MS,
    saveUploadedDivisionPacket,
    resultPacketStore,
    readActiveEvent
  } = deps;

  router.use('/rings', (req, res, next) => {
    const requestedEvent = String(req.query.eventName || '').trim();
    if (requestedEvent && requestedEvent !== readActiveEvent()) {
      return res.status(409).json({ error: 'The active event changed. Refresh the active-event view before continuing.' });
    }
    next();
  });

  // The event starts only when a ring with a named tablet is active; bare heartbeats or tests without a tablet never start it.
  function touchEventStart(state, ringState) {
    if (!state.eventStartedAt && ringState && String(ringState.tabletLabel || '').trim()) {
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

  function promoteQueuedGroupIfIdle(state, ringId, ringState, source) {
    normalizeRingAssignmentState(ringState);
    if (ringState.currentGroupId || ringState.queuedGroupDivisionNumbers.length === 0) return false;
    ringState.currentGroupId = ringState.queuedGroupDivisionNumbers.shift() || '';
    ringState.currentGroupDivisionNumber = ringState.currentGroupId;
    ringState.groupDivisionNumber = ringState.currentGroupId;
    ringState.queuedGroupIds = ringState.queuedGroupDivisionNumbers;
    if (!ringState.currentGroupId) return false;
    touchAssignmentStart(ringState);
    setRingPhase(ringState, 'check-in');
    touchHeartbeat(ringState);
    touchEventStart(state, ringState);
    appendDivisionTrace('ring-activate', {
      ringId,
      ringLabel: ringState.ringLabel,
      source,
      groupId: ringState.currentGroupId,
      group: summarizeGroupDivisionNumbers([loadGroup(ringState.currentGroupId)])[0] || null
    });
    return true;
  }

  function applyPhaseProgressFromCounts(ringState, currentGroup, incoming = {}) {
    const competitorCount = currentGroup && Array.isArray(currentGroup.competitors) ? currentGroup.competitors.length : 0;
    const phaseName = String(ringState.phase || '').trim().toLowerCase();
    const isSetupPhase = phaseName === 'check-in' || phaseName === 'setup';

    const setupCompleted = Number.isFinite(incoming.checkInCount)
      ? incoming.checkInCount
      : (isSetupPhase && Number.isFinite(incoming.phaseCompletedCount) ? incoming.phaseCompletedCount : ringState.checkInCount);
    const setupTotal = Number.isFinite(incoming.checkInTotal)
      ? incoming.checkInTotal
      : (isSetupPhase && Number.isFinite(incoming.phaseTotalCount) ? incoming.phaseTotalCount : ringState.checkInTotal || competitorCount);

    const phaseCompletedCount = isSetupPhase
      ? setupCompleted
      : (Number.isFinite(incoming.phaseCompletedCount) ? incoming.phaseCompletedCount : (Number.isFinite(incoming.checkInCount) ? incoming.checkInCount : ringState.phaseCompletedCount));
    const phaseTotalCount = isSetupPhase
      ? setupTotal
      : (Number.isFinite(incoming.phaseTotalCount) ? incoming.phaseTotalCount : (Number.isFinite(incoming.checkInTotal) ? incoming.checkInTotal : ringState.phaseTotalCount || competitorCount));

    if (isSetupPhase) {
      ringState.checkInCount = Math.max(0, Number.isFinite(setupCompleted) ? setupCompleted : 0);
      ringState.checkInTotal = Math.max(0, Number.isFinite(setupTotal) ? setupTotal : competitorCount);
    }

    ringState.phaseCompletedCount = Math.max(0, Number.isFinite(phaseCompletedCount) ? phaseCompletedCount : 0);
    ringState.phaseTotalCount = Math.max(0, Number.isFinite(phaseTotalCount) ? phaseTotalCount : competitorCount);
    if (ringState.phaseTotalCount > 0) {
      ringState.phaseProgress = Math.max(0, Math.min(100, (ringState.phaseCompletedCount / ringState.phaseTotalCount) * 100));
    } else if (Number.isFinite(incoming.phaseProgress)) {
      ringState.phaseProgress = Math.max(0, Math.min(100, incoming.phaseProgress > 1 ? incoming.phaseProgress : incoming.phaseProgress * 100));
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
    const competitorCount = currentGroup && Array.isArray(currentGroup.competitors) ? currentGroup.competitors.length : 0;
    if (competitorCount > 0) {
      const phaseName = String(ringState.phase || '').trim().toLowerCase();
      if (phaseName === 'check-in' || phaseName === 'setup') {
        if (!Number.isFinite(response.checkInTotal) || response.checkInTotal <= 0) {
          response.checkInTotal = competitorCount;
        }
        if (!Number.isFinite(response.phaseTotalCount) || response.phaseTotalCount <= 0) {
          response.phaseTotalCount = response.checkInTotal;
        }
        if (!Number.isFinite(response.checkInCount)) {
          response.checkInCount = ringState.checkInCount || 0;
        }
        if (!Number.isFinite(response.phaseCompletedCount)) {
          response.phaseCompletedCount = response.checkInCount || 0;
        }
      } else if (!Number.isFinite(response.phaseTotalCount) || response.phaseTotalCount <= 0) {
        response.phaseTotalCount = competitorCount;
      }
    }
    response.phasePlan = buildPhasePlan(ringState, currentGroup);
    response.currentPhase = response.phasePlan.currentPhase;
    response.currentPhaseName = response.currentPhaseName || response.phasePlan.currentPhase;
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
      touchEventStart(state, ringState);
      if (!ringState.phase || ringState.phase === 'idle') {
        setRingPhase(ringState, 'check-in');
      }
    }

    if (isConnectRequest) {
      promoteQueuedGroupIfIdle(state, ringId, ringState, 'bootstrap');
    }

    if (ringState.currentGroupId) {
      touchAssignmentStart(ringState);
    }

    applyPhaseProgressFromCounts(ringState, loadGroup(ringState.currentGroupId), {
      checkInCount,
      checkInTotal,
      phaseCompletedCount,
      phaseTotalCount,
      phaseProgress
    });

    writeAssignmentsState(state);
    return res.json(attachProgressData(buildRingResponse(req, ringId, ringState, state), ringState));
  }

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

  function ringBoard(req, res) {
    const state = readAssignmentsState();
    if (applyHeartbeatPolicy(state)) writeAssignmentsState(state);
    const rings = Object.entries(state.rings).map(([ringId, ringState]) => {
      const response = buildRingResponse(req, ringId, ringState, state);
      response.phasePlan = buildPhasePlan(ringState, response.currentGroup);
      const nextDivision = (ringState.queuedGroupDivisionNumbers || [])[0];
      const nextGroup = nextDivision ? loadGroup(nextDivision) : null;
      response.queuedPhasePlan = nextGroup ? {
        groupDivisionNumber: String(nextDivision),
        phases: phaseDefinitionsForGroup(nextGroup)
      } : null;
      response.currentPhase = response.phasePlan.currentPhase;
      response.currentGroupName = (response.currentGroup || {}).name || '';
      return response;
    });
    const availableGroupDivisionNumbers = buildAvailableGroupDivisionNumbers(
      typeof loadGroups === 'function' ? loadGroups() : [],
      state.rings
    );

    const estimates = buildEstimates({
      eventName: readActiveEvent(), rings,
      groups: typeof loadGroups === 'function' ? loadGroups() : [],
      heartbeatSeconds: DISCONNECT_AFTER_MS / 1000
    });
    res.set('Cache-Control', 'no-store');
    if (req.path.endsWith('/monitor')) return res.json(buildAudienceMonitor({
      eventName: readActiveEvent(), rings,
      groups: typeof loadGroups === 'function' ? loadGroups() : [], estimates
    }));
    if (req.path.endsWith('/estimates')) return res.json(estimates);
    return res.json({
      serverBaseUrl: serverBaseUrlForRequest(req),
      ringConfig: state.config,
      eventStartedAt: state.eventStartedAt || '',
      availableGroupDivisionNumbers,
      heartbeatPolicy: {
        disconnectAfterSeconds: DISCONNECT_AFTER_MS / 1000,
        resetMode: 'manual'
      },
      rings,
      estimates
    });
  }

  async function loadRingBoard(req, res) {
    res.set('Cache-Control', 'no-store');
    const eventName = readActiveEvent();
    try {
      if (eventName && typeof deps.loadSavedGroups === 'function') await deps.loadSavedGroups(eventName);
      if (readActiveEvent() !== eventName) {
        return res.status(409).json({ error: 'The active event changed. Refresh estimates before continuing.' });
      }
      return ringBoard(req, res);
    } catch (error) {
      console.error('Failed to load ring estimates:', error);
      return res.status(500).json({ error: 'Unable to load saved divisions for estimation.' });
    }
  }
  router.get('/rings', loadRingBoard);
  router.get('/rings/estimates', loadRingBoard);
  router.get('/rings/monitor', loadRingBoard);

  router.get('/rings/:ringId/bootstrap', handleRequestGroup);
  router.post('/rings/:ringId/request-group', handleRequestGroup);

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
    return res.json(attachProgressData(buildRingResponse(req, ringId, ringState, state), ringState));
  });

  router.post('/rings/:ringId/complete', (req, res) => {
    const state = readAssignmentsState();
    if (applyHeartbeatPolicy(state)) writeAssignmentsState(state);
    const ringId = String(req.params.ringId || '').trim();
    const ringState = getRingState(state, ringId);
    const packet = req.body;
    const acknowledgementId = resolveRequestCorrelationId(req, packet);
    const packetSummary = summarizeResultPacket(packet);
    const submittedGroupDivisionNumber = resolveGroupAnchorValue(packet && packet.groupDivisionNumber != null ? packet.groupDivisionNumber : packet && packet.groupId);
    const submissionId = packet && typeof packet.submissionId === 'string'
      ? packet.submissionId.trim()
      : '';
    const activeEventName = readActiveEvent();
    let processingStage = 'validation';

    logResultPacketEvent('received', {
      acknowledgementId,
      submissionId,
      ringId,
      ringLabel: ringState ? ringState.ringLabel : '',
      activeEventName,
      packetSummary
    });

    try {
      if (!ringState) {
        const reason = `Invalid ring '${ringId}'. Allowed rings: ${listAllowedRingLabels(state).join(', ')}`;
        const response = buildRejectionResponse({
          acknowledgementId,
          submissionId,
          reason: 'invalid-ring',
          message: reason,
          details: {
            validationType: 'routing',
            allowedRings: listAllowedRingLabels(state)
          },
          reasonChain: ['routing', 'ring-lookup'],
          packetSummary
        });
        logResultPacketEvent('rejected', {
          acknowledgementId,
          submissionId,
          ringId,
          ringLabel: '',
          reason: 'invalid-ring',
          reasonChain: response.reasonChain,
          packetSummary,
          details: response.details
        });
        return res.status(400).json(response);
      }

      const existingSubmission = submissionId ? resultPacketStore.findBySubmissionId(submissionId) : null;
      if (existingSubmission) {
        const acknowledgement = {};
        acknowledgement.acknowledgementId = acknowledgementId || existingSubmission.serverRecordId || submissionId;
        acknowledgement.ok = true;
        acknowledgement.accepted = true;
        acknowledgement.status = 'accepted';
        acknowledgement.submissionId = submissionId;
        acknowledgement.serverRecordId = existingSubmission.serverRecordId || '';
        acknowledgement.receivedAt = existingSubmission.receivedAt || '';
        acknowledgement.packetSummary = packetSummary;
        logResultPacketEvent('duplicate', {
          acknowledgementId: acknowledgement.acknowledgementId,
          submissionId,
          ringId,
          ringLabel: ringState.ringLabel,
          status: 'replayed',
          serverRecordId: existingSubmission.serverRecordId || '',
          currentGroupDivisionNumber: ringState.currentGroupDivisionNumber || ringState.currentGroupId || '',
          packetSummary
        });
        return res.json(buildAcknowledgementResponse(acknowledgement));
      }

      const validationErrors = resultPacketStore.validate(packet, ringId, activeEventName);
      if (validationErrors.length) {
        const splitErrors = splitValidationErrors(validationErrors);
        const validationDetails = {
          validationType: splitErrors.schemaErrors.length && splitErrors.businessRuleErrors.length
            ? 'schema-and-business-rule'
            : (splitErrors.businessRuleErrors.length ? 'business-rule' : 'schema'),
          schemaErrors: splitErrors.schemaErrors,
          businessRuleErrors: splitErrors.businessRuleErrors
        };
        logResultPacketEvent('validation_failed', {
          acknowledgementId,
          submissionId,
          ringId,
          ringLabel: ringState.ringLabel,
          reason: 'validation_failed',
          reasonChain: ['validation', validationDetails.validationType],
          packetSummary,
          details: validationDetails
        });
        return res.status(400).json(buildRejectionResponse({
          acknowledgementId,
          submissionId,
          reason: 'validation_failed',
          message: 'Result packet validation failed',
          details: validationDetails,
          errors: validationErrors,
          reasonChain: ['validation', validationDetails.validationType],
          packetSummary
        }));
      }
      logResultPacketEvent('validated', {
        acknowledgementId,
        submissionId,
        ringId,
        ringLabel: ringState.ringLabel,
        packetSummary,
        status: 'accepted'
      });

      processingStage = 'business-rule';
      logCompletionDiagnostics('received', {
        acknowledgementId,
        submissionId,
        ringId,
        ringLabel: ringState.ringLabel,
        packetCompletionSnapshot: packet && packet.completionSnapshot ? packet.completionSnapshot : null,
        packetPhaseHistory: packet && packet.completionSnapshot && Array.isArray(packet.completionSnapshot.phaseHistory)
          ? packet.completionSnapshot.phaseHistory
          : [],
        ringPhaseHistoryBeforeUpdate: Array.isArray(ringState.phaseHistory) ? ringState.phaseHistory : []
      });
      normalizeRingAssignmentState(ringState);
      const currentGroupDivisionNumber = String(ringState.currentGroupDivisionNumber || ringState.currentGroupId || '').trim();
      const currentGroupId = currentGroupDivisionNumber;
      const packetGroupAnchor = submittedGroupDivisionNumber;
      const existingGroupRecords = packet && packet.groupId ? resultPacketStore.findByGroupId(packet.groupId) : [];
      if (existingGroupRecords.length) {
        const existingRecord = existingGroupRecords[existingGroupRecords.length - 1];
        const response = buildRejectionResponse({
          acknowledgementId,
          submissionId,
          reason: 'duplicate-group-result',
          message: `Group already has an accepted result: ${packet.groupId}`,
          groupDivisionNumber: currentGroupId,
          details: {
            duplicateGroupId: packet.groupId,
            existingServerRecordId: existingRecord ? existingRecord.serverRecordId || '' : '',
            existingReceivedAt: existingRecord ? existingRecord.receivedAt || '' : ''
          },
          reasonChain: ['business-rule', 'duplicate-group-result'],
          packetSummary
        });
        logResultPacketEvent('rejected', {
          acknowledgementId,
          submissionId,
          ringId,
          ringLabel: ringState.ringLabel,
          reason: 'duplicate-group-result',
          reasonChain: response.reasonChain,
          packetSummary,
          details: response.details
        });
        return res.status(409).json(response);
      }
      if (!currentGroupId || packetGroupAnchor !== currentGroupId) {
        const response = buildRejectionResponse({
          acknowledgementId,
          submissionId,
          reason: 'ring-group-mismatch',
          message: `Packet group does not match the active group for ring ${ringId}`,
          groupDivisionNumber: currentGroupId,
          details: {
            activeGroupDivisionNumber: currentGroupId,
            packetGroupDivisionNumber: packetGroupAnchor,
            ringId
          },
          reasonChain: ['business-rule', 'ring-group-mismatch'],
          packetSummary
        });
        logResultPacketEvent('rejected', {
          acknowledgementId,
          submissionId,
          ringId,
          ringLabel: ringState.ringLabel,
          reason: 'ring-group-mismatch',
          reasonChain: response.reasonChain,
          packetSummary,
          details: response.details
        });
        return res.status(409).json(response);
      }

      if (currentGroupId) {
        ringState.completedGroupDivisionNumbers.push(currentGroupId);
        ringState.completedGroupIds = ringState.completedGroupDivisionNumbers;
      }
      const authoritativePhaseHistory = resolveCompletionPhaseHistory(packet, ringState.phaseHistory);
      if (!packet.completionSnapshot || typeof packet.completionSnapshot !== 'object' || Array.isArray(packet.completionSnapshot)) {
        packet.completionSnapshot = {};
      }
      packet.completionSnapshot.phaseHistory = authoritativePhaseHistory;
      logCompletionDiagnostics('resolved', {
        acknowledgementId,
        submissionId,
        ringId,
        ringLabel: ringState.ringLabel,
        authoritativePhaseHistory
      });
      ringState.currentGroupDivisionNumber = ringState.queuedGroupDivisionNumbers.shift() || '';
      ringState.currentGroupId = ringState.currentGroupDivisionNumber;
      ringState.groupDivisionNumber = ringState.currentGroupDivisionNumber;
      ringState.queuedGroupIds = ringState.queuedGroupDivisionNumbers;
      setRingPhase(ringState, ringState.currentGroupDivisionNumber ? 'check-in' : 'idle');
      if (ringState.currentGroupDivisionNumber) {
        touchAssignmentStart(ringState);
        appendDivisionTrace('ring-activate', {
          ringId,
          ringLabel: ringState.ringLabel,
          source: 'complete',
          groupId: ringState.currentGroupDivisionNumber,
          group: summarizeGroupDivisionNumbers([loadGroup(ringState.currentGroupDivisionNumber)])[0] || null
        });
      } else {
        ringState.assignmentStartedAt = '';
      }
      touchHeartbeat(ringState);
      touchEventStart(state, ringState);
      const ringAssignment = attachProgressData(buildRingResponse(req, ringId, ringState, state), ringState);
      const receipt = {
        receivedAt: new Date().toISOString(),
        status: 'ACCEPTED',
        acknowledgement: {
          ok: true,
          accepted: true,
          status: 'accepted',
          acknowledgementId,
          serverRecordId: null,
          submissionId: packet.submissionId,
          receivedAt: null,
          ringAssignment
        }
      };

      let record;
      try {
        processingStage = 'persistence';
        record = resultPacketStore.store(packet, receipt);
        logCompletionDiagnostics('persisted', {
          acknowledgementId: receipt.acknowledgement.acknowledgementId,
          submissionId,
          ringId,
          ringLabel: ringState.ringLabel,
          storedPhaseHistory: record && record.completionSnapshot && Array.isArray(record.completionSnapshot.phaseHistory)
            ? record.completionSnapshot.phaseHistory
            : [],
          storedCompletionSnapshotPhaseHistory: record && record.completionSnapshot && Array.isArray(record.completionSnapshot.phaseHistory)
            ? record.completionSnapshot.phaseHistory
            : []
        });
      } catch (error) {
        console.error('Failed to persist division result packet:', error);
        logResultPacketEvent('failed', {
          acknowledgementId,
          submissionId,
          ringId,
          ringLabel: ringState.ringLabel,
          reason: 'persistence-failed',
          reasonChain: ['persistence'],
          packetSummary,
          details: {
            stage: 'persistence',
            error: error && error.message ? error.message : String(error)
          }
        });
        return res.status(500).json(buildRejectionResponse({
          acknowledgementId,
          submissionId,
          reason: 'persistence-failed',
          message: 'Failed to persist division result packet',
          details: {
            stage: 'persistence',
            error: error && error.message ? error.message : String(error)
          },
          reasonChain: ['persistence'],
          packetSummary
        }));
      }

      receipt.acknowledgement.serverRecordId = record.serverRecordId;
      receipt.acknowledgement.receivedAt = receipt.receivedAt;
      receipt.acknowledgement.acknowledgementId = receipt.acknowledgement.acknowledgementId || acknowledgementId;
      logResultPacketEvent('persisted', {
        acknowledgementId: receipt.acknowledgement.acknowledgementId,
        submissionId,
        ringId,
        ringLabel: ringState.ringLabel,
        status: 'stored',
        serverRecordId: record.serverRecordId,
        filePath: record.filePath,
        packetSummary
      });

      try {
        processingStage = 'commit';
        writeAssignmentsState(state);
      } catch (error) {
        console.error('Failed to commit division result packet state:', error);
        logResultPacketEvent('failed', {
          acknowledgementId: receipt.acknowledgement.acknowledgementId,
          submissionId,
          ringId,
          ringLabel: ringState.ringLabel,
          reason: 'commit-failed',
          reasonChain: ['commit'],
          packetSummary,
          details: {
            stage: 'commit',
            error: error && error.message ? error.message : String(error),
            serverRecordId: record.serverRecordId
          }
        });
        return res.status(500).json(buildRejectionResponse({
          acknowledgementId: receipt.acknowledgement.acknowledgementId,
          submissionId,
          reason: 'commit-failed',
          message: 'Failed to commit division result packet state',
          details: {
            stage: 'commit',
            error: error && error.message ? error.message : String(error),
            serverRecordId: record.serverRecordId
          },
          reasonChain: ['commit'],
          packetSummary
        }));
      }

      logResultPacketEvent('committed', {
        acknowledgementId: receipt.acknowledgement.acknowledgementId,
        submissionId,
        ringId,
        ringLabel: ringState.ringLabel,
        status: 'accepted',
        serverRecordId: record.serverRecordId,
        groupDivisionNumber: ringState.currentGroupDivisionNumber || '',
        packetSummary
      });

      return res.json(buildAcknowledgementResponse(receipt.acknowledgement));
    } catch (error) {
      console.error('Failed to process division result packet:', error);
      logResultPacketEvent('failed', {
        acknowledgementId,
        submissionId,
        ringId,
        ringLabel: ringState ? ringState.ringLabel : '',
        reason: 'processing-failed',
        reasonChain: [processingStage, 'processing-failed'],
        packetSummary,
        details: {
          stage: processingStage,
          error: error && error.message ? error.message : String(error)
        }
      });
      return res.status(500).json(buildRejectionResponse({
        acknowledgementId,
        submissionId,
        reason: 'processing-failed',
        message: 'Failed to process division result packet',
        details: {
          stage: processingStage,
          error: error && error.message ? error.message : String(error)
        },
        reasonChain: [processingStage, 'processing-failed'],
        packetSummary
      }));
    }
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
    return res.json(attachProgressData(buildRingResponse(req, ringId, ringState, state), ringState));
  });

  router.post('/rings/:ringId/queue', (req, res) => {
    const groupId = resolveGroupAnchorValue(req.body.groupDivisionNumber != null ? req.body.groupDivisionNumber : req.body.groupId);
    if (!groupId) {
      return res.status(400).json({ error: 'groupDivisionNumber is required' });
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
    normalizeRingAssignmentState(ringState);

    if (ringState.currentGroupId === groupId || ringState.queuedGroupDivisionNumbers.includes(groupId)) {
      return res.status(409).json({ error: `Group already assigned or queued: ${groupId}` });
    }
    const usage = findGroupUsageAcrossRings(state, groupId, ringId);
    if (usage) {
      return res.status(409).json({
        error: `Group ${groupId} is already assigned or queued in ${usage.ringLabel}. Remove it there before reassigning.`
      });
    }

    ringState.queuedGroupDivisionNumbers.push(groupId);
    ringState.queuedGroupIds = ringState.queuedGroupDivisionNumbers;
    touchHeartbeat(ringState);
    const queuedGroup = loadGroup(groupId);
    appendDivisionTrace('ring-queue', {
      ringId,
      groupId,
      ringLabel: ringState.ringLabel,
      group: queuedGroup ? summarizeGroupDivisionNumbers([queuedGroup])[0] : null
    });
    // A tablet is already attached and idle, so activate immediately instead of waiting for a reconnect.
    if (ringState.tabletLabel) {
      promoteQueuedGroupIfIdle(state, ringId, ringState, 'queue');
    }
    writeAssignmentsState(state);
    return res.json(attachProgressData(buildRingResponse(req, ringId, ringState, state), ringState));
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
    normalizeRingAssignmentState(ringState);

    const tabletLabel = String(req.body.tabletLabel || '').trim();
    const phase = String(req.body.phase || '').trim();
    const checkInCount = Number.parseInt(req.body && (req.body.checkInCount ?? req.body.checkedInCount ?? ''), 10);
    const checkInTotal = Number.parseInt(req.body && (req.body.checkInTotal ?? req.body.checkedInTotal ?? ''), 10);
    const phaseCompletedCount = Number.parseInt(req.body && (req.body.phaseCompletedCount ?? req.body.completedCount ?? ''), 10);
    const phaseTotalCount = Number.parseInt(req.body && (req.body.phaseTotalCount ?? req.body.totalCount ?? ''), 10);
    const phaseProgress = Number.parseFloat(req.body && (req.body.phaseProgress ?? req.body.progress ?? ''));
    if (tabletLabel) ringState.tabletLabel = tabletLabel;
    const promoted = promoteQueuedGroupIfIdle(state, ringId, ringState, 'heartbeat');
    if (phase && !promoted) setRingPhase(ringState, phase);
    applyPhaseProgressFromCounts(ringState, loadGroup(ringState.currentGroupId), {
      checkInCount,
      checkInTotal,
      phaseCompletedCount,
      phaseTotalCount,
      phaseProgress
    });
    touchHeartbeat(ringState);
    appendHeartbeatTrace(ringId, {
      phase: ringState.phase,
      checkInCount: ringState.checkInCount,
      checkInTotal: ringState.checkInTotal,
      phaseCompletedCount: ringState.phaseCompletedCount,
      phaseTotalCount: ringState.phaseTotalCount,
      phaseProgress: ringState.phaseProgress,
      lastHeartbeatAt: ringState.lastHeartbeatAt,
      body: {
        phase,
        checkInCount,
        checkInTotal,
        phaseCompletedCount,
        phaseTotalCount,
        phaseProgress
      }
    });
    touchEventStart(state, ringState);
    writeAssignmentsState(state);
    return res.json(attachProgressData(buildRingResponse(req, ringId, ringState, state), ringState));
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
    normalizeRingAssignmentState(ringState);

    const assistanceType = String(req.body.type || '').trim().toLowerCase();
    if (!['medical', 'arbitrator', 'general'].includes(assistanceType)) {
      return res.status(400).json({ error: 'type must be one of: medical, arbitrator, general' });
    }

    ringState.assistanceType = assistanceType;
    ringState.assistanceRequestedAt = new Date().toISOString();
    touchHeartbeat(ringState);
    writeAssignmentsState(state);
    return res.json(attachProgressData(buildRingResponse(req, ringId, ringState, state), ringState));
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
    normalizeRingAssignmentState(ringState);

    const expectedRequestedAt = req.body && req.body.expectedAssistanceRequestedAt;
    if (expectedRequestedAt !== undefined && expectedRequestedAt !== (ringState.assistanceRequestedAt || '')) {
      return res.status(409).json({ error: 'The assistance request changed. Refresh Head Table before clearing it.' });
    }
    ringState.assistanceType = '';
    ringState.assistanceRequestedAt = '';
    writeAssignmentsState(state);
    return res.json(attachProgressData(buildRingResponse(req, ringId, ringState, state), ringState));
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
    const normalizedGroupId = resolveGroupAnchorValue(groupId);
    const state = readAssignmentsState();
    if (applyHeartbeatPolicy(state)) writeAssignmentsState(state);
    const ringState = getRingState(state, ringId);
    if (!ringState) {
      return res.status(400).json({
        error: `Invalid ring '${ringId}'. Allowed rings: ${listAllowedRingLabels(state).join(', ')}`
      });
    }
    normalizeRingAssignmentState(ringState);

    const before = ringState.queuedGroupDivisionNumbers.length;
    ringState.queuedGroupDivisionNumbers = ringState.queuedGroupDivisionNumbers.filter((id) => resolveGroupAnchorValue(id) !== normalizedGroupId);
    ringState.queuedGroupIds = ringState.queuedGroupDivisionNumbers;
    if (ringState.queuedGroupDivisionNumbers.length === before) {
      return res.status(404).json({ error: `Group not in queue: ${normalizedGroupId}` });
    }

    writeAssignmentsState(state);
    return res.json(attachProgressData(buildRingResponse(req, ringId, ringState, state), ringState));
  });

  return router;
}

module.exports = {
  createRingRouter
};
