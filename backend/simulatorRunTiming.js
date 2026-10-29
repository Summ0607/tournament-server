const { estimateDivisionTiming } = require('./simulatorTiming');
const { scheduleState, isDayBlocked, sortDivisionIds } = require('./tournamentSchedule');

function remainingSimulatorOperationMs(state, now) {
  const pending = state && state.pendingOperationMs || 0;
  const start = Date.parse(state && state.operationWaitStartedAt);
  const speed = state && state.operationWaitSpeed;
  return Math.max(0, pending - (Number.isFinite(start) && Number.isFinite(speed)
    ? Math.max(0, now - start) * speed : 0));
}

function remainingSimulatorDivisionMs(group, state, now) {
  const phases = Object.entries(state && state.phaseDurationsMs || {});
  if (!phases.length) return estimateDivisionTiming(group).estimatedDurationMs +
    remainingSimulatorOperationMs(state, now);
  const phaseIndex = phases.findIndex(([key]) => key === state.currentPhase);
  const remaining = state.currentPhase === 'loading-division'
    ? phases.reduce((sum, [, milliseconds]) => sum + milliseconds, 0)
    : phaseIndex < 0 ? 0
    : phases.slice(phaseIndex).reduce((sum, [, milliseconds], index) =>
      sum + milliseconds * (index === 0
        ? 1 - Math.max(0, Math.min(100, state.currentPhaseProgress || 0)) / 100 : 1), 0);
  return remaining + remainingSimulatorOperationMs(state, now);
}

function buildSimulatorRunTiming({ manifest, assignments, groups }, now = Date.now()) {
  const timing = {
    startedAt: manifest.wallClockStartedAt || null,
    completedAt: manifest.wallClockCompletedAt || null,
    estimatedCompletionAt: null
  };
  const schedule = scheduleState(groups, assignments);
  if ((assignments.pendingGroupDivisionNumbers || []).some((entry) =>
    isDayBlocked(groups.find((group) => String(group.groupDivisionNumber ?? group.id ?? group.groupId) === String(entry.groupDivisionNumber)), schedule))) return timing;
  if (manifest.status !== 'running' || !Number.isFinite(manifest.speed) || manifest.speed <= 0 ||
      (manifest.state && manifest.state.errors || []).length) return timing;

  const states = new Map((manifest.state && manifest.state.rings || []).map((ring) => [ring.ringId, ring]));
  const groupMap = new Map(groups.map((group) => [
    String(group.groupDivisionNumber ?? group.id ?? group.groupId), group
  ]));
  const durationFor = (number) => {
    const group = groupMap.get(String(number));
    if (!group) return null;
    return estimateDivisionTiming(group).estimatedDurationMs;
  };
  const loads = [];
  for (const [ringId, assignment] of Object.entries(assignments.rings)) {
    const state = states.get(ringId);
    if (state && state.state === 'failed') return timing;
    let remaining = remainingSimulatorOperationMs(state, now);
    const current = assignment.groupDivisionNumber || assignment.currentGroupDivisionNumber;
    if (current) {
      const duration = durationFor(current, ringId);
      if (duration == null) return timing;
      remaining = remainingSimulatorDivisionMs(groupMap.get(String(current)), state, now);
      remaining += 30_000;
    }
    for (const number of assignment.queuedGroupDivisionNumbers || []) {
      const duration = durationFor(number, ringId);
      if (duration == null) return timing;
      remaining += duration + 90_000;
    }
    loads.push({ ringId, remaining });
  }
  if (!loads.length) return timing;
  for (const entry of assignments.pendingGroupDivisionNumbers || []) {
    loads.sort((a, b) => a.remaining - b.remaining || a.ringId.localeCompare(b.ringId));
    const duration = durationFor(entry.groupDivisionNumber, loads[0].ringId);
    if (duration == null) return timing;
    loads[0].remaining += duration + 90_000;
  }
  timing.estimatedCompletionAt = new Date(now +
    Math.max(...loads.map((ring) => ring.remaining)) / manifest.speed).toISOString();
  return timing;
}

function buildSimulatorAssignmentEstimates({ manifest, groups }, board, now = Date.now()) {
  const speedValid = Number.isFinite(manifest.speed) && manifest.speed > 0;
  const speed = speedValid ? manifest.speed : 1;
  const states = new Map((manifest.state && manifest.state.rings || []).map((ring) => [ring.ringId, ring]));
  const groupMap = new Map(groups.map((group) => [
    String(group.groupDivisionNumber ?? group.id ?? group.groupId), group
  ]));
  const failure = manifest.failure ||
    (manifest.state && manifest.state.errors || []).map((error) => error.message || String(error)).join('; ') ||
    [...states.values()].find((ring) => ring.state === 'failed')?.error;
  const failedRing = [...states.values()].some((ring) => ring.state === 'failed');
  const reason = failure || failedRing ? `Simulator run failed: ${failure || 'a ring failed'}.`
    : manifest.status !== 'running' ? `Simulator run is ${manifest.status}; clock predictions are unavailable.`
      : !speedValid ? 'Simulator speed is invalid; clock predictions are unavailable.' : null;
  const unavailable = (message) => ({ status: 'unavailable', reason: message, window: null });
  const windowAt = (delayMs, uncertaintyMs) => ({
    earliestAt: new Date(now + Math.max(0, delayMs - uncertaintyMs)).toISOString(),
    expectedAt: new Date(now + delayMs).toISOString(),
    latestAt: new Date(now + delayMs + uncertaintyMs).toISOString()
  });
  const durationFor = (id) => {
    const group = groupMap.get(String(id));
    return group && Array.isArray(group.competitors) && group.competitors.length
      ? estimateDivisionTiming(group).estimatedDurationMs / speed : null;
  };
  const uncertaintyFraction = 0.25;
  const bootstrapMs = 60_000 / speed;
  const completionMs = 30_000 / speed;
  const slots = [];
  const rings = board.rings.map((ring) => {
    const state = states.get(ring.ringId);
    let blocked = reason;
    let delayMs = remainingSimulatorOperationMs(state, now) / speed;
    let current = null;
    if (ring.groupDivisionNumber) {
      const durationMs = durationFor(ring.groupDivisionNumber);
      if (!blocked && durationMs == null) blocked = 'Current division has no saved competitor roster.';
      if (blocked) {
        current = {
          groupDivisionNumber: ring.groupDivisionNumber, durationMs,
          ...unavailable(blocked), completionWindow: null
        };
      } else {
        delayMs = remainingSimulatorDivisionMs(groupMap.get(ring.groupDivisionNumber), state, now) / speed +
          completionMs;
        const phaseRemainingMs = remainingSimulatorDivisionMs(groupMap.get(ring.groupDivisionNumber), {
          ...state, pendingOperationMs: 0
        }, now) / speed;
        current = {
          groupDivisionNumber: ring.groupDivisionNumber, status: 'estimated', reason: null,
          durationMs, remainingMs: Math.round(delayMs),
          progressPercent: Math.round(Math.max(0, Math.min(1, 1 - phaseRemainingMs / durationMs)) * 100),
          basis: 'simulator-phase-progress-and-pending-wait', confidence: 'low',
          completionWindow: windowAt(delayMs, delayMs * uncertaintyFraction)
        };
      }
    }
    const queue = (ring.queuedGroupDivisionNumbers || []).map((id, index) => {
      const durationMs = durationFor(id);
      if (!blocked && durationMs == null) blocked = `Queued division ${id} has no saved competitor roster.`;
      if (blocked) return {
        groupDivisionNumber: id, position: index + 1, durationMs,
        ...unavailable(blocked), completionWindow: null
      };
      delayMs += bootstrapMs;
      const window = windowAt(delayMs, delayMs * uncertaintyFraction);
      delayMs += durationMs + completionMs;
      return {
        groupDivisionNumber: id, position: index + 1, durationMs,
        status: 'estimated', reason: null, confidence: 'low', basis: 'simulator-ring-queue-order',
        window, completionWindow: windowAt(delayMs, delayMs * uncertaintyFraction)
      };
    });
    const availability = blocked ? unavailable(blocked) : {
      status: 'estimated', reason: null, confidence: 'low', planningOnly: false,
      window: windowAt(delayMs, delayMs * uncertaintyFraction)
    };
    if (!blocked) slots.push({
      ringId: ring.ringId, ringLabel: ring.ringLabel, delayMs,
      working: Boolean(current) || queue.length > 0 || delayMs > 0
    });
    return {
      ringId: ring.ringId, ringLabel: ring.ringLabel, connection: 'simulated',
      current, queue, availability
    };
  });
  slots.sort((a, b) => a.ringLabel.localeCompare(b.ringLabel, undefined, { numeric: true }));
  let projectionReason = reason;
  const pending = sortDivisionIds(board.availableGroupDivisionNumbers, groups);
  const unassigned = pending.map((id) => {
    const durationMs = durationFor(id);
    if (isDayBlocked(groupMap.get(String(id)), board.schedule || { tournamentDays: 1 })) return {
      groupDivisionNumber: id, durationMs, hypothetical: true,
      ...unavailable('Day 2 has not been started.'), completionWindow: null
    };
    const slot = slots.reduce((best, item) => !best || item.delayMs < best.delayMs ? item : best, null);
    if (!projectionReason && durationMs == null) projectionReason = `Division ${id} has no saved competitor roster.`;
    if (!projectionReason && !slot) projectionReason = 'No simulator ring has a reliable availability estimate.';
    if (projectionReason) return {
      groupDivisionNumber: id, durationMs, hypothetical: true,
      ...unavailable(projectionReason), completionWindow: null
    };
    slot.delayMs += bootstrapMs;
    const window = windowAt(slot.delayMs, slot.delayMs * uncertaintyFraction);
    slot.delayMs += durationMs + completionMs;
    slot.working = true;
    return {
      groupDivisionNumber: id, durationMs, hypothetical: true, planningOnly: false,
      status: 'estimated', reason: null, confidence: 'low',
      suggestedRingId: slot.ringId, suggestedRingLabel: slot.ringLabel,
      window, completionWindow: windowAt(slot.delayMs, slot.delayMs * uncertaintyFraction)
    };
  });
  const blockedRing = rings.find((ring) => ring.availability.status !== 'estimated');
  const completionReason = pending.some((id) => isDayBlocked(groupMap.get(String(id)), board.schedule || { tournamentDays: 1 }))
    ? 'Day 2 has not been started; tournament completion is not yet available.' : projectionReason || (blockedRing &&
    `Ring ${blockedRing.ringLabel}: ${blockedRing.availability.reason}`);
  const working = slots.filter((slot) => slot.working);
  const completionDelayMs = Math.max(0, ...working.map((slot) => slot.delayMs));
  const eventCompletion = completionReason ? unavailable(completionReason)
    : !working.length ? { status: 'complete', reason: null, window: null } : {
      status: 'estimated', reason: null, confidence: 'low', planningOnly: false,
      remainingDivisions: pending.length,
      window: windowAt(completionDelayMs, completionDelayMs * uncertaintyFraction)
    };
  return {
    version: 1, eventName: board.eventName,
    generatedAt: new Date(now).toISOString(),
    validUntil: new Date(now + 30_000).toISOString(),
    status: reason ? 'unavailable' : 'ready', reason,
    advisory: 'Read-only simulator projections; no live assignments or tablets are used.',
    policy: { uncertaintyPercent: 25, freshnessSeconds: 30, simulatorSpeed: manifest.speed },
    assumptions: [
      'Shared division timing and remaining phase progress are scaled to the local wall clock by simulator speed.',
      'Unconsumed operation waits are included; future divisions allow sixty seconds for bootstrap and thirty seconds for completion before speed scaling.',
      'Pending divisions follow BB oldest first, TT/SD youngest first, then Gup youngest first on the earliest available ring, ignoring gender; an unreleased Day 2 has no predicted start.',
      'Windows allow 25 percent uncertainty; paused or inactive runs have durations but no clock predictions.'
    ],
    rings, unassigned, eventCompletion
  };
}

module.exports = {
  buildSimulatorRunTiming, buildSimulatorAssignmentEstimates,
  remainingSimulatorDivisionMs, remainingSimulatorOperationMs
};
