function resolveDivisionNumber(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed)) {
    return String(parsed);
  }
  return String(value || '').trim();
}

function buildAvailableGroupDivisionNumbers(groups, rings) {
  const blocked = new Set();

  Object.values(rings || {}).forEach((ringState) => {
    if (!ringState || typeof ringState !== 'object') return;
    const current = resolveDivisionNumber(ringState.groupDivisionNumber);
    if (current) blocked.add(current);

    const queued = Array.isArray(ringState.queuedGroupDivisionNumbers) ? ringState.queuedGroupDivisionNumbers : [];
    queued.forEach((groupId) => {
      const normalized = resolveDivisionNumber(groupId);
      if (normalized) blocked.add(normalized);
    });

    const completed = Array.isArray(ringState.completedGroupDivisionNumbers) ? ringState.completedGroupDivisionNumbers : [];
    completed.forEach((groupId) => {
      const normalized = resolveDivisionNumber(groupId);
      if (normalized) blocked.add(normalized);
    });
  });

  return (Array.isArray(groups) ? groups : [])
    .map((group) => resolveDivisionNumber(group && group.groupDivisionNumber != null ? group.groupDivisionNumber : (group && (group.groupId || group.id))))
    .filter(Boolean)
    .filter((groupId) => !blocked.has(groupId));
}

module.exports = {
  buildAvailableGroupDivisionNumbers
};
