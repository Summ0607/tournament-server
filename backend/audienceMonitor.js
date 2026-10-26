function buildAudienceMonitor({ eventName, rings, groups, estimates }) {
  const descriptions = new Map(groups.map((group) => [
    String(group.groupDivisionNumber ?? group.id ?? group.groupId), String(group.name || '')
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

module.exports = { buildAudienceMonitor };
