const { buildAvailableGroupDivisionNumbers } = require('./ringAvailability');

const POLICY = Object.freeze({
  baselineMinutesPerCompetitor: 7,
  transitionMinutes: 2,
  uncertaintyPercent: 25,
  freshnessSeconds: 30,
  minimumRemainingMinutes: 2,
  minimumPaceProgressPercent: 10
});

function divisionDurationMs(group) {
  const count = group && Array.isArray(group.competitors) ? group.competitors.length : 0;
  return count > 0 ? count * POLICY.baselineMinutesPerCompetitor * 60000 : null;
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

function currentProgress(ring) {
  const phases = ring.phasePlan && ring.phasePlan.phases;
  if (!Array.isArray(phases) || !phases.length) return null;
  let sum = 0;
  let active = 0;
  for (const phase of phases) {
    if (phase.state === 'complete') sum += 1;
    else if (phase.state === 'active') {
      active += 1;
      if (phase.progress == null || phase.progress === '' || !Number.isFinite(Number(phase.progress))) return null;
      sum += Math.max(0, Math.min(100, Number(phase.progress))) / 100;
    } else if (!['upcoming', 'idle'].includes(phase.state)) return null;
  }
  if (active !== 1 && !phases.every((phase) => phase.state === 'complete')) return null;
  return sum / phases.length;
}

function buildEstimates({ eventName, rings, groups, now = Date.now(), heartbeatSeconds = 90 }) {
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
      const progress = currentProgress(ring);
      const start = Date.parse(ring.assignmentStartedAt);
      if (!reason && !durationMs) reason = 'Current division has no saved competitor roster.';
      if (!reason && (!Number.isFinite(start) || start > now)) reason = 'Current division start time is unavailable.';
      if (!reason && progress == null) reason = 'Current phase progress is unavailable.';
      if (reason) current = { groupDivisionNumber: currentId, ...unavailable(reason) };
      else {
        const elapsedMs = now - start;
        // Equal phase shares match the progression pill; they are not measured phase durations.
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
      if (!reason && !durationMs) reason = `Queued division ${id} has no saved competitor roster.`;
      if (reason) return { groupDivisionNumber: id, position: index + 1, durationMs, ...unavailable(reason) };
      // Include a transition before every start, including a queued division on an idle ring.
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
  const candidates = estimates.filter((ring) => ring.availability.status === 'estimated').sort((a, b) =>
    Date.parse(a.availability.window.expectedAt) - Date.parse(b.availability.window.expectedAt)
      || a.ringLabel.localeCompare(b.ringLabel, undefined, { numeric: true }));
  const unassigned = availableIds.map((id) => {
    const durationMs = divisionDurationMs(groupMap.get(id));
    const ring = candidates[0];
    if (!durationMs || !ring) return {
      groupDivisionNumber: id, durationMs, hypothetical: true,
      ...unavailable(!durationMs ? 'Division has no saved competitor roster.' : 'No ring has a reliable availability estimate.')
    };
    const availability = ring.availability.window;
    return {
      groupDivisionNumber: id, durationMs, hypothetical: true, status: 'estimated', reason: null,
      planningOnly: ring.availability.planningOnly,
      suggestedRingId: ring.ringId, suggestedRingLabel: ring.ringLabel, confidence: 'low',
      window: {
        earliestAt: new Date(Date.parse(availability.earliestAt) + transitionMs * (1 - fraction)).toISOString(),
        expectedAt: new Date(Date.parse(availability.expectedAt) + transitionMs).toISOString(),
        latestAt: new Date(Date.parse(availability.latestAt) + transitionMs * (1 + fraction)).toISOString()
      }
    };
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
      'Seven minutes per saved competitor is the existing planning baseline, not a learned tournament average.',
      'Total division duration assumes every saved competitor participates in all applicable disciplines; it is not a per-discipline calculation.',
      'Empty configured rings without connected tablets can contribute planning-only availability; operational readiness is not implied.',
      'Applicable phases use equal work shares; reported phase progress and slower observed pace adjust remaining time.',
      'Two minutes between divisions; queue order is unchanged and staff start queued work promptly.',
      'Windows allow 25 percent uncertainty, accumulating through the queue; confidence is low.',
      'Unassigned suggestions are independent what-if scenarios, not simultaneous reservations or automatic assignments.',
      'Unknown breaks, future assistance, staffing and schedule changes cannot be predicted.'
    ],
    rings: estimates, unassigned
  };
}

module.exports = { buildEstimates, divisionDurationMs };
