const { buildAvailableGroupDivisionNumbers } = require('./ringAvailability');
const { estimateDivisionTiming } = require('./simulatorTiming');
const { isDayBlocked, sortDivisionIds } = require('./tournamentSchedule');

const POLICY = Object.freeze({
  transitionMinutes: 0,
  uncertaintyPercent: 25,
  freshnessSeconds: 30,
  minimumRemainingMinutes: 2,
  minimumPaceProgressPercent: 10
});

function divisionDurationMs(group) {
  const count = group && Array.isArray(group.competitors) ? group.competitors.length : 0;
  return count > 0 ? estimateDivisionTiming(group).estimatedDurationMs : null;
}

function unavailable(reason) {
  return { status: 'unavailable', reason, window: null };
}

function windowAt(now, delayMs, uncertaintyMs) {
  return {
    earliestAt: new Date(now + Math.max(0, delayMs - uncertaintyMs)).toISOString(),
    expectedAt: new Date(now + delayMs).toISOString(),
    latestAt: new Date(now + delayMs + uncertaintyMs).toISOString()
  };
}

function currentProgress(ring, group) {
  const phases = ring.phasePlan && ring.phasePlan.phases;
  if (!Array.isArray(phases) || !phases.length) return null;
  const timing = estimateDivisionTiming(group);
  let sum = 0;
  let total = 0;
  let active = 0;
  for (const phase of phases) {
    const duration = timing.phaseDurationsMs[phase.key];
    if (!Number.isFinite(duration)) return null;
    total += duration;
    if (phase.state === 'complete') sum += duration;
    else if (phase.state === 'active') {
      active += 1;
      if (phase.progress == null || phase.progress === '' || !Number.isFinite(Number(phase.progress))) return null;
      sum += duration * Math.max(0, Math.min(100, Number(phase.progress))) / 100;
    } else if (!['upcoming', 'idle'].includes(phase.state)) return null;
  }
  if (active !== 1 && !phases.every((phase) => phase.state === 'complete')) return null;
  return total > 0 ? sum / total : null;
}

function buildEstimates({ eventName, rings, groups, now = Date.now(), heartbeatSeconds = 90, schedule = { tournamentDays: 1 } }) {
  const groupMap = new Map(groups.map((group) => [
    String(group.groupDivisionNumber ?? group.id ?? group.groupId), group
  ]));
  const transitionMs = POLICY.transitionMinutes * 60000;
  const floorMs = POLICY.minimumRemainingMinutes * 60000;
  const fraction = POLICY.uncertaintyPercent / 100;
  const heartbeatLimit = Number.isFinite(heartbeatSeconds) && heartbeatSeconds > 0 ? heartbeatSeconds : 90;
  let validUntil = now + POLICY.freshnessSeconds * 1000;
  const estimates = rings.map((ring) => {
    const queue = (ring.queuedGroupDivisionNumbers || []).map(String);
    const currentId = String(ring.groupDivisionNumber || '');
    let reason = !eventName ? 'No active event.' : '';
    const heartbeat = Date.parse(ring.lastHeartbeatAt);
    const connected = Boolean(ring.tabletLabel) && Number.isFinite(heartbeat)
      && heartbeat <= now + 5000 && now - heartbeat < heartbeatLimit * 1000;
    const planningOnly = !connected && !currentId && !queue.length && !ring.assistanceType;
    if (connected) {
      validUntil = Math.min(validUntil, heartbeat + heartbeatLimit * 1000);
    }
    if (!reason && !planningOnly && !ring.tabletLabel) reason = 'No tablet connected.';
    if (!reason && !planningOnly && !connected) {
      reason = 'Tablet heartbeat is missing or disconnected.';
    }
    if (!reason && ring.assistanceType) reason = 'Assistance request outstanding; delay is unknown.';
    let delayMs = 0;
    let uncertaintyMs = 0;
    let current = null;
    if (currentId) {
      const durationMs = divisionDurationMs(groupMap.get(currentId));
      const progress = currentProgress(ring, groupMap.get(currentId));
      const start = Date.parse(ring.assignmentStartedAt);
      if (!reason && !durationMs) reason = 'Current division has no saved competitor roster.';
      if (!reason && (!Number.isFinite(start) || start > now)) reason = 'Current division start time is unavailable.';
      if (!reason && progress == null) reason = 'Current phase progress is unavailable.';
      if (reason) current = { groupDivisionNumber: currentId, ...unavailable(reason) };
      else {
        const elapsedMs = now - start;
        const paceFactor = progress >= POLICY.minimumPaceProgressPercent / 100
          ? Math.max(1, elapsedMs / Math.max(1, durationMs * progress)) : 1;
        delayMs = Math.max(floorMs, durationMs * (1 - progress) * paceFactor);
        const overdueWithoutProgress = progress < POLICY.minimumPaceProgressPercent / 100 && elapsedMs > durationMs;
        uncertaintyMs = Math.max(floorMs, delayMs * fraction, overdueWithoutProgress ? elapsedMs - durationMs : 0);
        current = {
          groupDivisionNumber: currentId, status: 'estimated', reason: null,
          progressPercent: Math.round(progress * 100),
          remainingMs: Math.round(delayMs), durationMs,
          basis: paceFactor > 1 ? 'baseline-and-observed-pace' : 'baseline-and-reported-progress',
          confidence: 'low',
          completionWindow: windowAt(now, delayMs, uncertaintyMs)
        };
      }
    }
    const projectedQueue = queue.map((id, index) => {
      const durationMs = divisionDurationMs(groupMap.get(id));
      if (isDayBlocked(groupMap.get(id), schedule)) reason = 'Day 2 has not been started.';
      if (!reason && !durationMs) reason = `Queued division ${id} has no saved competitor roster.`;
      if (reason) return { groupDivisionNumber: id, position: index + 1, durationMs, ...unavailable(reason) };
      // Setup and discipline reviews are already included in the shared duration.
      delayMs += transitionMs;
      uncertaintyMs += transitionMs * fraction;
      const window = windowAt(now, delayMs, uncertaintyMs);
      delayMs += durationMs;
      uncertaintyMs += durationMs * fraction;
      return {
        groupDivisionNumber: id, position: index + 1, status: 'estimated', reason: null,
        durationMs, window, completionWindow: windowAt(now, delayMs, uncertaintyMs),
        confidence: 'low', basis: 'ring-queue-order'
      };
    });
    const availability = reason ? unavailable(reason) : {
      status: 'estimated', reason: null, confidence: 'low', planningOnly,
      window: windowAt(now, delayMs, uncertaintyMs)
    };
    return {
      ringId: ring.ringId, ringLabel: ring.ringLabel,
      connection: !ring.tabletLabel ? 'no-tablet' : connected ? 'connected' : 'disconnected',
      current, queue: projectedQueue, availability
    };
  });
  const availableIds = buildAvailableGroupDivisionNumbers(groups, Object.fromEntries(rings.map((ring) => [ring.ringId, ring])));
  const slots = estimates.filter((ring) => ring.availability.status === 'estimated')
    .sort((a, b) => a.ringLabel.localeCompare(b.ringLabel, undefined, { numeric: true }))
    .map((ring) => {
      const expected = Date.parse(ring.availability.window.expectedAt);
      return {
        ringId: ring.ringId, ringLabel: ring.ringLabel,
        working: Boolean(ring.current) || ring.queue.length > 0,
        planningOnly: ring.availability.planningOnly,
        delayMs: expected - now,
        uncertaintyMs: Date.parse(ring.availability.window.latestAt) - expected
      };
    });
  let projectionReason = '';
  const pending = sortDivisionIds(availableIds, groups);
  const unassigned = pending.map((id) => {
    const durationMs = divisionDurationMs(groupMap.get(id));
    if (isDayBlocked(groupMap.get(id), schedule)) return {
      groupDivisionNumber: id, durationMs, hypothetical: true, ...unavailable('Day 2 has not been started.')
    };
    const slot = slots.reduce((best, item) => !best || item.delayMs < best.delayMs ? item : best, null);
    if (!projectionReason && !durationMs) projectionReason = `Division ${id} has no saved competitor roster.`;
    if (!projectionReason && !slot) projectionReason = 'No ring has a reliable availability estimate.';
    if (projectionReason) return {
      groupDivisionNumber: id, durationMs, hypothetical: true,
      ...unavailable(projectionReason)
    };
    slot.delayMs += transitionMs;
    slot.uncertaintyMs += transitionMs * fraction;
    const window = windowAt(now, slot.delayMs, slot.uncertaintyMs);
    slot.delayMs += durationMs;
    slot.uncertaintyMs += durationMs * fraction;
    slot.working = true;
    return {
      groupDivisionNumber: id, durationMs, hypothetical: true, status: 'estimated', reason: null,
      planningOnly: slot.planningOnly,
      suggestedRingId: slot.ringId, suggestedRingLabel: slot.ringLabel, confidence: 'low',
      window, completionWindow: windowAt(now, slot.delayMs, slot.uncertaintyMs)
    };
  });
  const eventCompletion = buildEventCompletion({
    eventName, rings: estimates, availableIds, groupMap, now, slots,
    projectionReason: pending.some((id) => isDayBlocked(groupMap.get(id), schedule))
      ? 'Day 2 has not been started; tournament completion is not yet available.' : projectionReason,
    planningOnly: unassigned.some((entry) => entry.planningOnly)
  });
  return {
    version: 1, eventName: eventName || null,
    generatedAt: new Date(now).toISOString(),
    validUntil: new Date(validUntil).toISOString(),
    status: eventName ? 'ready' : 'unavailable',
    reason: eventName ? null : 'No active event.',
    advisory: 'Planning estimates only; subject to change. Not a guaranteed call time.',
    policy: POLICY,
    assumptions: [
      'Shared phase timing uses seven-minute setup, ten-minute awards, 1.5 minutes per weapons/hyungs entrant, two minutes per contested sparring bout and three-minute discipline reviews.',
      'Empty configured rings without connected tablets can contribute planning-only availability; operational readiness is not implied.',
      'Applicable phases are weighted by modeled duration; reported phase progress and slower observed pace adjust remaining time.',
      'Setup and reviews are included in division duration; queue order is unchanged and staff start queued work promptly.',
      'Windows allow 25 percent uncertainty, accumulating through the queue; confidence is low.',
      'Unassigned divisions use BB oldest first, then TT/SD youngest first, then Gup youngest first, ignoring gender; projections do not reserve or assign rings.',
      'Event completion follows the running order on the earliest available ring; an unreleased Day 2 has no predicted start or finish.',
      'Unknown breaks, future assistance, staffing and schedule changes cannot be predicted.'
    ],
    rings: estimates, unassigned, eventCompletion
  };
}

function buildEventCompletion({ eventName, rings, availableIds, groupMap, now, slots, projectionReason, planningOnly }) {
  if (!eventName) return unavailable('No active event.');
  const hasWork = (ring) => Boolean(ring.current) || ring.queue.length > 0;
  const blocked = rings.find((ring) => hasWork(ring) && ring.availability.status !== 'estimated');
  if (blocked) return unavailable(`Ring ${blocked.ringLabel}: ${blocked.availability.reason}`);
  if (projectionReason) return unavailable(projectionReason);
  const working = slots.filter((slot) => slot.working);
  if (!working.length) {
    return groupMap.size
      ? { status: 'complete', reason: null, window: null }
      : unavailable('No saved divisions for the active event.');
  }
  const expectedMs = Math.max(...working.map((slot) => slot.delayMs));
  return {
    status: 'estimated', reason: null, confidence: 'low', planningOnly,
    remainingDivisions: availableIds.length,
    window: {
      earliestAt: new Date(now + Math.max(0, ...working.map((slot) => slot.delayMs - slot.uncertaintyMs))).toISOString(),
      expectedAt: new Date(now + expectedMs).toISOString(),
      latestAt: new Date(now + Math.max(...working.map((slot) => slot.delayMs + slot.uncertaintyMs))).toISOString()
    }
  };
}

module.exports = { buildEstimates, divisionDurationMs };
