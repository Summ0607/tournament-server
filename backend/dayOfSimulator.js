const crypto = require('crypto');
const { selectEligibleSparringCompetitors, simulateSparringDivision } = require('./dayOfSparring');
const { TIMING_MODEL_VERSION, estimateDivisionTiming } = require('./simulatorTiming');

const DEFAULT_START_AT = '2000-01-01T00:00:00.000Z';
const DEFAULT_STEP_DURATION_MS = 60_000;

function groupNumber(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? String(parsed) : String(value || '').trim();
}

function activeGroupNumber(response) {
  const currentGroup = response && response.currentGroup;
  return groupNumber(
    (response && (response.currentGroupDivisionNumber || response.currentGroupId)) ||
    (currentGroup && (currentGroup.groupDivisionNumber || currentGroup.id || currentGroup.groupId))
  );
}

function phasesFor(group) {
  return estimateDivisionTiming(group).phases;
}

function responseForCurrentGroup(response) {
  if (!response || typeof response !== 'object') return '';
  return activeGroupNumber(response);
}

function seedValue(seed) {
  return crypto.createHash('sha256').update(String(seed)).digest().readUInt32LE(0);
}

function createSeededRandom(seed) {
  let state = seedValue(seed);
  return function random() {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function canonicalScenario(eventName, rings, seed, groups) {
  return JSON.stringify({
    eventName,
    seed,
    rings: rings.map((ring) => ({
      ringId: String(ring.ringId).trim(),
      ringLabel: String(ring.ringLabel).trim(),
      groupDivisionNumbers: ring.groupDivisionNumbers.map(groupNumber)
    })),
    groups: stableValue(groups)
  });
}

function createDayOfSimulator({
  runId,
  eventName,
  rings,
  groups,
  createRingClient,
  buildResultPacket,
  scenarioSeed,
  scenarioId,
  startAt = DEFAULT_START_AT,
  stepDurationMs = DEFAULT_STEP_DURATION_MS
}) {
  const normalizedRunId = String(runId || '').trim();
  const normalizedEventName = String(eventName || '').trim();
  if (!normalizedRunId) throw new Error('runId is required');
  if (!normalizedEventName) throw new Error('eventName is required');
  if (!Array.isArray(rings) || rings.length === 0) throw new Error('At least one ring is required');
  if (!groups || typeof groups !== 'object') throw new Error('Prebuilt groups are required');
  if (typeof createRingClient !== 'function') throw new Error('createRingClient is required');
  if (typeof buildResultPacket !== 'function') throw new Error('buildResultPacket is required');
  const normalizedStartAt = new Date(startAt);
  if (!Number.isFinite(normalizedStartAt.getTime())) throw new Error('startAt must be a valid timestamp');
  if (!Number.isInteger(stepDurationMs) || stepDurationMs < 1) {
    throw new Error('stepDurationMs must be a positive integer');
  }

  const groupByNumber = new Map(Object.entries(groups).map(([key, group]) => [
    groupNumber((group && (group.groupDivisionNumber ?? group.id ?? group.groupId)) ?? key),
    group
  ]));
  const actors = new Map();
  const assignedGroups = new Set();
  const normalizedRings = rings.map((ring) => ({
    ...ring,
    ringId: String(ring && ring.ringId || '').trim(),
    ringLabel: String(ring && ring.ringLabel || '').trim(),
    groupDivisionNumbers: (Array.isArray(ring && ring.groupDivisionNumbers) ? ring.groupDivisionNumbers : [])
      .map(groupNumber).filter(Boolean)
  }));
  const normalizedSeed = String(scenarioSeed ?? normalizedRunId);
  const normalizedScenarioId = String(scenarioId || crypto.createHash('sha256')
    .update(canonicalScenario(normalizedEventName, normalizedRings, normalizedSeed, groups))
    .digest('hex').slice(0, 16));
  const random = createSeededRandom(normalizedSeed);
  const runStartedAt = normalizedStartAt.toISOString();
  let clockMs = normalizedStartAt.getTime();
  let operationCount = 0;
  const events = [];
  const errors = [];

  function simulatedAt(actor) {
    return new Date(actor ? actor.virtualTimeMs : clockMs).toISOString();
  }

  function recordEvent(type, actor, details = {}, durationMs = 1000) {
    const event = {
      sequence: events.length + 1,
      type,
      ringId: actor.ringId,
      ringLabel: actor.ringLabel,
      simulatedAt: simulatedAt(actor),
      occurredAt: new Date().toISOString(),
      durationMs,
      groupDivisionNumber: actor.currentGroupNumber || null,
      ...details
    };
    events.push(event);
    operationCount += 1;
    actor.lastOperationDurationMs = durationMs;
    actor.virtualTimeMs += durationMs;
    clockMs = Math.max(clockMs, actor.virtualTimeMs);
    return event;
  }

  for (const ring of normalizedRings) {
    const ringId = ring.ringId;
    const ringLabel = ring.ringLabel;
    if (!ringId || !ringLabel || actors.has(ringId)) {
      throw new Error('Each ring requires a unique ringId and a ringLabel');
    }
    const assignedGroupNumbers = ring.groupDivisionNumbers;
    if (new Set(assignedGroupNumbers).size !== assignedGroupNumbers.length) {
      throw new Error(`Ring ${ringId} contains duplicate group assignments`);
    }
    for (const assignedGroupNumber of assignedGroupNumbers) {
      if (!groupByNumber.has(assignedGroupNumber)) {
        throw new Error(`Prebuilt group ${assignedGroupNumber} is missing for ring ${ringId}`);
      }
      if (assignedGroups.has(assignedGroupNumber)) {
        throw new Error(`Prebuilt group ${assignedGroupNumber} is assigned to more than one simulator ring`);
      }
      assignedGroups.add(assignedGroupNumber);
    }

    const client = createRingClient({
      runId: normalizedRunId,
      eventName: normalizedEventName,
      ringId,
      ringLabel
    });
    const scope = client && client.simulationScope;
    if (!scope || scope.kind !== 'simulator-run' || scope.runId !== normalizedRunId ||
        scope.eventName !== normalizedEventName || scope.ringId !== ringId) {
      throw new Error(`Ring client for ${ringId} is not scoped to simulator run ${normalizedRunId}`);
    }
    for (const method of ['queue', 'bootstrap', 'heartbeat', 'complete']) {
      if (typeof client[method] !== 'function') {
        throw new Error(`Ring client for ${ringId} must implement ${method}()`);
      }
    }

    actors.set(ringId, {
      ringId,
      ringLabel,
      tabletLabel: `Simulator-${normalizedRunId}-${ringLabel}`,
      client,
      assignedGroupNumbers,
      queuedGroupCount: 0,
      completedGroupNumbers: [],
      currentGroupNumber: '',
      currentPhaseIndex: 0,
      operationPhase: '',
      phaseProgressPercent: 0,
      phases: [],
      timing: null,
      virtualTimeMs: normalizedStartAt.getTime(),
      lastOperationDurationMs: 1000,
      pendingGroupNumbers: assignedGroupNumbers.slice(),
      state: 'ready',
      error: null
    });
  }

  function groupFor(actor) {
    const group = groupByNumber.get(actor.currentGroupNumber);
    if (!group || !Array.isArray(group.competitors)) {
      throw new Error(`Group ${actor.currentGroupNumber} for ring ${actor.ringId} is missing competitor data`);
    }
    return group;
  }

  async function registerDynamicAssignments(actor, response) {
    const newNumbers = [
      response && response.newlyAssignedGroupDivisionNumber,
      response && response.newlyQueuedGroupDivisionNumber
    ].map(groupNumber).filter(Boolean);
    for (const number of newNumbers) {
      if (actor.assignedGroupNumbers.includes(number)) {
        throw new Error(`Ring ${actor.ringId} was assigned simulator group ${number} more than once`);
      }
      if (!groupByNumber.has(number)) {
        throw new Error(`Rolling assignment selected missing group ${number}`);
      }
      await actor.client.queue(number, simulationContext(actor));
      actor.assignedGroupNumbers.push(number);
      actor.pendingGroupNumbers.push(number);
      actor.pendingGroupNumbers = actor.pendingGroupNumbers.filter((pending, index, list) =>
        list.indexOf(pending) === index);
      recordEvent('group_queued', actor, { groupDivisionNumber: number }, 30_000);
    }
  }

  function setCurrentGroup(actor, response) {
    const nextGroupNumber = responseForCurrentGroup(response);
    if (!nextGroupNumber) {
      actor.currentGroupNumber = '';
      actor.phases = [];
      actor.currentPhaseIndex = 0;
      actor.phaseProgressPercent = 0;
      actor.timing = null;
      actor.operationPhase = 'idle';
      return;
    }
    if (!actor.assignedGroupNumbers.includes(nextGroupNumber)) {
      throw new Error(`Ring ${actor.ringId} activated unassigned group ${nextGroupNumber}`);
    }
    if (actor.completedGroupNumbers.includes(nextGroupNumber)) {
      throw new Error(`Ring ${actor.ringId} reactivated completed group ${nextGroupNumber}`);
    }
    actor.currentGroupNumber = nextGroupNumber;
    actor.pendingGroupNumbers = actor.pendingGroupNumbers.filter((number) => number !== nextGroupNumber);
    actor.phases = phasesFor(groupFor(actor));
    actor.timing = estimateDivisionTiming(groupFor(actor), {
      scenarioSeed: normalizedSeed,
      ringId: actor.ringId
    });
    actor.currentPhaseIndex = 0;
    actor.phaseProgressPercent = 0;
    actor.operationPhase = '';
  }

  async function step(ringId) {
    const actor = actors.get(String(ringId || '').trim());
    if (!actor) throw new Error(`Unknown simulator ring: ${ringId}`);
    if (actor.state === 'complete') return snapshotActor(actor);
    if (actor.state === 'failed') throw new Error(`Simulator ring ${actor.ringId} has failed: ${actor.error}`);

    try {
      if (actor.state === 'ready') {
        if (actor.queuedGroupCount < actor.assignedGroupNumbers.length) {
          const groupDivisionNumber = actor.assignedGroupNumbers[actor.queuedGroupCount];
          await actor.client.queue(groupDivisionNumber, simulationContext(actor));
          actor.queuedGroupCount += 1;
          actor.pendingGroupNumbers = actor.pendingGroupNumbers.filter((number) => number !== groupDivisionNumber);
          recordEvent('group_queued', actor, { groupDivisionNumber }, 30_000);
          return snapshotActor(actor);
        }
        const response = await actor.client.bootstrap({
          tabletLabel: actor.tabletLabel,
          simulation: simulationContext(actor)
        });
        await registerDynamicAssignments(actor, response);
        setCurrentGroup(actor, response);
        if (!actor.currentGroupNumber && actor.assignedGroupNumbers.length) {
          throw new Error(`Ring ${actor.ringId} did not activate its assigned groups during bootstrap`);
        }
        actor.state = actor.currentGroupNumber ? 'running' : 'complete';
        recordEvent('tablet_bootstrapped', actor, { state: actor.state }, 60_000);
        return snapshotActor(actor);
      }

      if (actor.operationPhase === 'loading-division') {
        actor.operationPhase = '';
        recordEvent('division_loaded', actor, {}, 1000);
        return snapshotActor(actor);
      }

        if (actor.currentPhaseIndex < actor.phases.length) {
          const group = groupFor(actor);
        const phase = actor.phases[actor.currentPhaseIndex];
        const competitorCount = phase === 'sparring' ? actor.timing.sparringBoutCount
          : actor.timing.entrantCounts[phase] ?? group.competitors.length;
        const progress = Math.min(100, actor.phaseProgressPercent + 25);
        const isComplete = progress >= 100;
        const completedCount = Math.round(competitorCount * progress / 100);
        const phaseDurationMs = actor.timing.phaseDurationsMs[phase];
        const operationDurationMs = Math.ceil(phaseDurationMs / 4);
        await actor.client.heartbeat({
          tabletLabel: actor.tabletLabel,
          phase,
          checkInCount: phase === 'setup' ? completedCount : undefined,
          checkInTotal: phase === 'setup' ? competitorCount : undefined,
          phaseCompletedCount: completedCount,
          phaseTotalCount: competitorCount,
          simulation: simulationContext(actor)
        });
        recordEvent('phase_progress', actor, {
          phase,
          completedCount,
          totalCount: competitorCount,
          progress,
          phaseDurationMs,
          divisionEstimatedDurationMs: actor.timing.estimatedDurationMs
        }, operationDurationMs);
        if (isComplete) {
          actor.currentPhaseIndex += 1;
          actor.phaseProgressPercent = 0;
        } else {
          actor.phaseProgressPercent = progress;
        }
        return snapshotActor(actor);
      }

      if (actor.operationPhase !== 'uploading-report') {
        actor.operationPhase = 'uploading-report';
        recordEvent('report_upload_started', actor, {}, 30_000);
        return snapshotActor(actor);
      }

      const group = groupFor(actor);
      const completedAt = simulatedAt(actor);
      const packet = await buildResultPacket({
        runId: normalizedRunId,
        scenarioId: normalizedScenarioId,
        scenarioSeed: normalizedSeed,
        timingModelVersion: TIMING_MODEL_VERSION,
        eventName: normalizedEventName,
        ringId: actor.ringId,
        ringLabel: actor.ringLabel,
        tabletLabel: actor.tabletLabel,
        group,
        completedAt,
        random,
        simulatedAt: completedAt,
        selectEligibleSparringCompetitors,
        simulateSparring: (competitors) => simulateSparringDivision(competitors, { random })
      });
      if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
        throw new Error(`Result packet builder returned no packet for group ${actor.currentGroupNumber}`);
      }
      if (packet.eventName !== normalizedEventName || packet.ringId !== actor.ringId ||
          String(packet.groupDivisionNumber ?? packet.groupId) !== actor.currentGroupNumber) {
        throw new Error(`Result packet does not match active simulator assignment ${actor.ringId}/${actor.currentGroupNumber}`);
      }
      packet.simulation = {
        runId: normalizedRunId,
        scenarioId: normalizedScenarioId,
        seed: normalizedSeed,
        simulatedAt: completedAt
      };
      const completedGroupNumber = actor.currentGroupNumber;
      const completedTiming = actor.timing;
      const response = await actor.client.complete(packet);
      actor.completedGroupNumbers.push(completedGroupNumber);
      await registerDynamicAssignments(actor, response);
      setCurrentGroup(actor, response);
      if (actor.currentGroupNumber) actor.operationPhase = 'loading-division';
      if (!actor.currentGroupNumber) {
        const remaining = actor.assignedGroupNumbers.filter((number) =>
          !actor.completedGroupNumbers.includes(number));
        if (remaining.length) {
          throw new Error(`Ring ${actor.ringId} ended with assigned groups still incomplete: ${remaining.join(', ')}`);
        }
        actor.state = 'complete';
      }
      recordEvent('division_completed', actor, {
        groupDivisionNumber: completedGroupNumber,
        serverRecordId: response && response.serverRecordId || null,
        durationMs: completedTiming.estimatedDurationMs,
        estimatedDurationMinutes: completedTiming.estimatedDurationMinutes
      }, 30_000);
      return snapshotActor(actor);
    } catch (error) {
      actor.state = 'failed';
      actor.error = error && error.message ? error.message : String(error);
      const failure = {
        ringId: actor.ringId,
        ringLabel: actor.ringLabel,
        groupDivisionNumber: actor.currentGroupNumber || null,
        simulatedAt: simulatedAt(actor),
        occurredAt: new Date().toISOString(),
        message: actor.error
      };
      errors.push(failure);
      events.push({
        sequence: events.length + 1,
        type: 'operation_failed',
        ...failure
      });
      operationCount += 1;
      actor.virtualTimeMs += stepDurationMs;
      clockMs = Math.max(clockMs, actor.virtualTimeMs);
      throw error;
    }
  }

  async function runRingToCompletion(ringId) {
    const normalizedRingId = String(ringId || '').trim();
    if (!actors.has(normalizedRingId)) throw new Error(`Unknown simulator ring: ${ringId}`);
    let current = snapshotActor(actors.get(normalizedRingId));
    while (current && current.state !== 'complete') {
      current = await step(normalizedRingId);
    }
    return current;
  }

  async function runToCompletion() {
    while (Array.from(actors.values()).some((actor) => !['complete', 'failed'].includes(actor.state))) {
      const nextActors = Array.from(actors.values()).sort((left, right) =>
        left.virtualTimeMs - right.virtualTimeMs || left.ringId.localeCompare(right.ringId));
      for (const actor of nextActors) {
        if (['complete', 'failed'].includes(actor.state)) continue;
        try {
          await step(actor.ringId);
        } catch (error) {
          const message = error && error.message ? error.message : String(error);
          if (actor.state !== 'failed' || actor.error !== message) throw error;
        }
      }
    }
    return getState();
  }

  function simulationContext(actor) {
    return {
      runId: normalizedRunId,
      scenarioId: normalizedScenarioId,
      seed: normalizedSeed,
      simulatedAt: simulatedAt(actor),
      ringId: actor.ringId
    };
  }

  function snapshotActor(actor) {
    if (!actor) return null;
    const queuedGroupNumbers = actor.assignedGroupNumbers.filter((number) =>
      number !== actor.currentGroupNumber && !actor.completedGroupNumbers.includes(number) &&
      !actor.pendingGroupNumbers.includes(number));
    return {
      ringId: actor.ringId,
      ringLabel: actor.ringLabel,
      state: actor.state,
      currentGroupNumber: actor.currentGroupNumber,
      currentPhase: actor.operationPhase || actor.phases[actor.currentPhaseIndex] ||
        (actor.currentGroupNumber ? 'awards' : 'idle'),
      currentPhaseProgress: actor.operationPhase ? 0
        : actor.currentPhaseIndex >= actor.phases.length && actor.currentGroupNumber ? 100 : actor.phaseProgressPercent,
      queuedGroupNumbers,
      pendingGroupNumbers: actor.pendingGroupNumbers.slice(),
      completedGroupNumbers: actor.completedGroupNumbers.slice(),
      completedCount: actor.completedGroupNumbers.length,
      totalGroupCount: actor.assignedGroupNumbers.length,
      error: actor.error,
      estimatedDivisionDurationMs: actor.timing ? actor.timing.estimatedDurationMs : null,
      phaseDurationsMs: actor.timing ? { ...actor.timing.phaseDurationsMs } : {},
      recommendedDelayMs: actor.lastOperationDurationMs
    };
  }

  function getState() {
    const ringStates = Array.from(actors.values(), snapshotActor);
    const status = ringStates.some((ring) => ring.state === 'failed')
      ? 'failed'
      : (ringStates.every((ring) => ring.state === 'complete')
        ? 'complete'
        : (ringStates.some((ring) => ring.state === 'running') ? 'running' : 'ready'));
    return {
      runId: normalizedRunId,
      scenarioId: normalizedScenarioId,
      scenarioSeed: normalizedSeed,
      timingModelVersion: TIMING_MODEL_VERSION,
      eventName: normalizedEventName,
      status,
      startedAt: runStartedAt,
      simulatedAt: simulatedAt(),
      stepDurationMs,
      operationCount,
      rings: ringStates,
      errors: errors.map((error) => ({ ...error })),
      events: events.map((event) => ({ ...event }))
    };
  }

  return { getState, step, runRingToCompletion, runToCompletion };
}

function createSimulatorRunId() {
  return crypto.randomUUID();
}

module.exports = { createDayOfSimulator, createSimulatorRunId };
