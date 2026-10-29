const { estimateDivisionTiming } = require('./simulatorTiming');
const { remainingSimulatorDivisionMs } = require('./simulatorRunTiming');
const { displayDivisionName } = require('../assets/division-rules');

function buildAudienceMonitor({ eventName, rings, groups, estimates }) {
  const descriptions = new Map(groups.map((group) => [
    String(group.groupDivisionNumber ?? group.id ?? group.groupId), displayDivisionName(group.name)
  ]));
  const publicRings = eventName ? rings.map((ring) => {
    const prediction = estimates.rings.find((entry) => entry.ringId === ring.ringId);
    const active = Boolean(ring.groupDivisionNumber);
    const connected = prediction && prediction.connection === 'connected';
    const queued = !active ? ring.queuedPhasePlan : null;
    return {
      ringId: ring.ringId, ringLabel: ring.ringLabel,
      divisionNumber: active ? String(ring.groupDivisionNumber) : null,
      description: active ? descriptions.get(String(ring.groupDivisionNumber)) || '' : '',
      status: ring.assistanceType ? 'paused' : active ? connected ? 'active' : 'updates-unavailable' : 'waiting',
      phases: active ? (ring.phasePlan?.phases || []).map((phase) => ({
        key: phase.key, label: phase.label, state: phase.state, progress: phase.progress
      })) : (queued?.phases || []).map((phase) => ({
        key: phase.key, label: phase.label, state: 'upcoming', progress: 0
      })),
      queuedDivisionNumber: queued ? String(queued.groupDivisionNumber) : null,
      queuedDescription: queued ? descriptions.get(String(queued.groupDivisionNumber)) || '' : '',
      completionWindow: prediction?.current?.status === 'estimated' ? prediction.current.completionWindow : null
    };
  }) : [];
  const upcoming = eventName ? rings.flatMap((ring) => {
    const prediction = estimates.rings.find((entry) => entry.ringId === ring.ringId);
    return (ring.queuedGroupDivisionNumbers || []).map((number, index) => {
      const item = prediction?.queue.find((entry) => entry.groupDivisionNumber === String(number));
      return {
        ringId: ring.ringId, ringLabel: ring.ringLabel, divisionNumber: String(number),
        description: descriptions.get(String(number)) || '',
        position: index + 1,
        startWindow: item?.status === 'estimated' ? item.window : null
      };
    });
  }) : [];
  return {
    version: 1, eventName: eventName || null,
    generatedAt: estimates.generatedAt, validUntil: estimates.validUntil,
    status: eventName ? 'ready' : 'unavailable',
    message: eventName ? 'Approximate planning windows, not call times. Subject to change.' : 'Waiting for an active event.',
    rings: publicRings, upcoming
  };
}

const SIMULATOR_PHASES = Object.freeze([
  { key: 'setup', label: 'Setup' },
  { key: 'weapons', label: 'Weapons' },
  { key: 'hyungs', label: 'Hyungs' },
  { key: 'sparring', label: 'Sparring' },
  { key: 'awards', label: 'Awards' }
]);

function simulatorPhases(group) {
  const phases = estimateDivisionTiming(group).phases;
  return SIMULATOR_PHASES.filter((phase) => phases.includes(phase.key));
}

function simulatorStartWindow(currentGroup, state, isRunning, speed, now) {
  if (!isRunning) return null;
  const startMs = now;
  if (!currentGroup) {
    const at = new Date(startMs).toISOString();
    return { earliestAt: at, expectedAt: at, latestAt: at };
  }
  if (!state) return null;

  const durations = Object.values(state.phaseDurationsMs || {});
  if (!durations.length || durations.some((duration) => !Number.isFinite(duration) || duration < 0)) return null;
  const remainingMs = remainingSimulatorDivisionMs(currentGroup, state, now) + 30_000;
  const runSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const wallClockRemainingMs = remainingMs / runSpeed;
  const uncertaintyMs = Math.round(wallClockRemainingMs * 0.1);
  const expectedMs = startMs + wallClockRemainingMs;
  return {
    earliestAt: new Date(startMs + Math.max(0, wallClockRemainingMs - uncertaintyMs)).toISOString(),
    expectedAt: new Date(expectedMs).toISOString(),
    latestAt: new Date(expectedMs + uncertaintyMs).toISOString()
  };
}

function buildSimulatorAudienceMonitor(workspace, now = Date.now()) {
  const { manifest, groups } = workspace;
  const groupMap = new Map(groups.map((group) => [
    String(group.groupDivisionNumber ?? group.id ?? group.groupId),
    group
  ]));
  const stateByRing = new Map(((manifest.state && manifest.state.rings) || []).map((ring) => [ring.ringId, ring]));
  const startWindowsByRing = new Map();
  const rings = Object.entries(workspace.assignments.rings).map(([ringId, assignment]) => {
    const state = stateByRing.get(ringId);
    const currentNumber = String(state && state.currentGroupNumber ||
      assignment.groupDivisionNumber || assignment.currentGroupDivisionNumber || '');
    const currentGroup = groupMap.get(currentNumber);
    const queuedNumbers = [
      ...(assignment.queuedGroupDivisionNumbers || []),
      ...(assignment.groupDivisionNumber || assignment.currentGroupDivisionNumber
        ? [assignment.groupDivisionNumber || assignment.currentGroupDivisionNumber] : [])
    ].map(String).filter((number) => number && number !== currentNumber);
    const uniqueQueued = [...new Set(queuedNumbers)];
    const queuedGroup = groupMap.get(uniqueQueued[0]);
    const startWindow = simulatorStartWindow(
      currentGroup,
      state,
      manifest.status === 'running',
      manifest.speed,
      now
    );
    startWindowsByRing.set(ringId, startWindow);
    const phases = currentGroup ? simulatorPhases(currentGroup) : [];
    const currentPhase = state && state.currentPhase;
    const currentPhaseIndex = phases.findIndex((phase) => phase.key === currentPhase);
    const currentProgress = Number(state && state.currentPhaseProgress) || 0;
    const publicPhases = currentGroup ? phases.map((phase, index) => ({
      ...phase,
      state: currentPhase === 'uploading-report' ? 'complete' : currentPhaseIndex < 0
        ? 'upcoming'
        : index < currentPhaseIndex ? 'complete'
          : index === currentPhaseIndex ? 'active' : 'upcoming',
      progress: currentPhase === 'uploading-report' ? 100
        : index === currentPhaseIndex ? currentProgress : index < currentPhaseIndex ? 100 : 0
    })) : (groupMap.has(uniqueQueued[0]) ? simulatorPhases(groupMap.get(uniqueQueued[0])).map((phase) => ({
      ...phase, state: 'upcoming', progress: 0
    })) : []);
    const paused = ['paused', 'stopped'].includes(manifest.status);
    return {
      ringId,
      ringLabel: assignment.ringLabel,
      divisionNumber: currentGroup ? currentNumber : null,
      description: currentGroup ? displayDivisionName(currentGroup.name) : '',
      status: currentGroup
        ? paused ? 'paused' : state && state.state === 'failed' ? 'updates-unavailable' : 'active'
        : 'waiting',
      phases: publicPhases,
      queuedDivisionNumber: uniqueQueued[0] || null,
      queuedDescription: displayDivisionName((queuedGroup || {}).name),
      completionWindow: currentGroup ? startWindow : null
    };
  });
  const upcoming = Object.entries(workspace.assignments.rings).flatMap(([ringId, assignment]) => {
    const numbers = (assignment.queuedGroupDivisionNumbers || []).map(String).filter(Boolean);
    const uniqueNumbers = [...new Set(numbers)];
    return uniqueNumbers.slice(0, 1).map((number, index) => ({
      ringId,
      ringLabel: assignment.ringLabel,
      divisionNumber: number,
      description: displayDivisionName((groupMap.get(number) || {}).name),
      position: index + 1,
      startWindow: startWindowsByRing.get(ringId) || null
    }));
  });
  const generatedAt = new Date(now).toISOString();
  return {
    version: 1,
    eventName: `SIMULATION · ${manifest.sourceEventName} · ${manifest.runId.slice(0, 8)}`,
    generatedAt,
    validUntil: new Date(now + 30000).toISOString(),
    status: 'ready',
    message: 'Simulated ring activity. Not connected to the active event.',
    source: 'simulator',
    runId: manifest.runId,
    simulatorStatus: manifest.status,
    simulatedAt: manifest.state && manifest.state.simulatedAt || manifest.startAt || null,
    rings,
    upcoming
  };
}

module.exports = { buildAudienceMonitor, buildSimulatorAudienceMonitor };
