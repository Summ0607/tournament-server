const { scheduleCategory, compareRunningOrder } = require('../assets/division-rules');

function normalizeTournamentDays(value) {
  const days = value == null || value === '' ? 1 : Number(value);
  if (![1, 2].includes(days) || typeof value === 'boolean') {
    const error = new Error('tournamentDays must be 1 or 2');
    error.statusCode = 400;
    throw error;
  }
  return days;
}

function scheduleState(groups, assignments, tournamentDays = assignments.tournamentDays) {
  const days = normalizeTournamentDays(tournamentDays);
  const completed = new Set(Object.values(assignments.rings || {}).flatMap((ring) =>
    ring.completedGroupDivisionNumbers || ring.completedGroupIds || []).map(String));
  for (const id of assignments.sourceCompletedGroupDivisionNumbers || []) completed.add(String(id));
  const day1Complete = groups.filter((group) => scheduleCategory(group) === 'BB')
    .every((group) => completed.has(String(group.groupDivisionNumber ?? group.id ?? group.groupId)));
  const day2Started = Boolean(assignments.day2StartedAt);
  return { tournamentDays: days, currentDay: days === 2 && day2Started ? 2 : 1,
    day1Complete, day2Started };
}

function isDayBlocked(group, schedule) {
  return schedule.tournamentDays === 2 && !schedule.day2Started && scheduleCategory(group) !== 'BB';
}

function sortDivisionIds(ids, groups) {
  const map = new Map(groups.map((group) => [String(group.groupDivisionNumber ?? group.id ?? group.groupId), group]));
  return ids.slice().sort((a, b) => compareRunningOrder(map.get(String(a)), map.get(String(b))));
}

module.exports = { normalizeTournamentDays, scheduleState, isDayBlocked, sortDivisionIds };
