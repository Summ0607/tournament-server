function normalizeCompetitor(competitor, fallbackId) {
  return {
    ...competitor,
    id: String(competitor.id),
    competitorId: String(competitor.competitorId ?? competitor.id),
    firstName: competitor.firstName,
    lastName: competitor.lastName,
    fullName: competitor.fullName,
    gender: competitor.gender,
    rank: competitor.rank,
    age: competitor.age,
    groupDivisionNumber: competitor.groupDivisionNumber,
    competitionDivisionNumber: competitor.competitionDivisionNumber
  };
}

function normalizeGroup(group) {
  return {
    ...group,
    groupId: String(group.groupId),
    id: String(group.groupId),
    name: group.name,
    groupDivisionNumber: group.groupDivisionNumber,
    competitors: Array.isArray(group.competitors) ? group.competitors : []
  };
}

function normalizeGroups(groups) {
  return Array.isArray(groups) ? groups : [];
}

module.exports = {
  normalizeCompetitor,
  normalizeGroup,
  normalizeGroups
};
