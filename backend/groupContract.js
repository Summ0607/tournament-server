function normalizeCompetitor(competitor, fallbackId) {
  const value = competitor && typeof competitor === 'object' ? competitor : {};
  const idValue = value.id != null ? value.id : (value.competitorId != null ? value.competitorId : fallbackId);
  const groupDivisionNumber = Number.parseInt(value.groupDivisionNumber, 10);
  const competitionDivisionNumber = Number.parseInt(value.competitionDivisionNumber, 10);

  return {
    ...value,
    id: String(idValue),
    firstName: String(value.firstName || '').trim(),
    lastName: String(value.lastName || '').trim(),
    fullName: String(value.fullName || [value.firstName, value.lastName].filter(Boolean).join(' ')).trim(),
    gender: String(value.gender || 'Unknown').trim() || 'Unknown',
    rank: String(value.rank || '').trim(),
    age: Number.isFinite(Number(value.age)) ? Number(value.age) : 0,
    groupDivisionNumber: Number.isFinite(groupDivisionNumber) ? groupDivisionNumber : undefined,
    competitionDivisionNumber: Number.isFinite(competitionDivisionNumber) ? competitionDivisionNumber : undefined
  };
}

function normalizeGroup(group, index) {
  const value = group && typeof group === 'object' ? group : {};
  const groupId = String(value.groupId || value.id || `group-${index + 1}`);
  const competitors = Array.isArray(value.competitors) ? value.competitors : [];
  const groupDivisionNumber = Number.parseInt(value.groupDivisionNumber, 10);

  return {
    groupId,
    id: groupId,
    name: String(value.name || groupId),
    groupDivisionNumber: Number.isFinite(groupDivisionNumber) ? groupDivisionNumber : undefined,
    competitors: competitors.map((competitor, competitorIndex) =>
      normalizeCompetitor(competitor, `${groupId}-competitor-${competitorIndex + 1}`)
    )
  };
}

function normalizeGroups(groups) {
  if (!Array.isArray(groups)) return [];
  return groups.map(normalizeGroup);
}

module.exports = {
  normalizeCompetitor,
  normalizeGroup,
  normalizeGroups
};
