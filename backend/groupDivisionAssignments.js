const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const TRACE_PATH = path.join(__dirname, 'group-division-trace.log');

function parseOptionalInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function appendDivisionTrace(event, payload) {
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    ...payload
  };

  try {
    fs.appendFileSync(TRACE_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    console.error('Failed to write division trace:', error);
  }
}

function assignDivisionNumbers(groups, startingDivisionNumber = 20) {
  const sourceGroups = Array.isArray(groups) ? groups : [];
  let nextDivisionNumber = parseOptionalInt(startingDivisionNumber);
  if (nextDivisionNumber == null) nextDivisionNumber = 20;

  return sourceGroups.map((group) => {
    const value = group && typeof group === 'object' ? group : {};
    const competitors = Array.isArray(value.competitors) ? value.competitors : [];
    let groupDivisionNumber = parseOptionalInt(value.groupDivisionNumber);
    if (groupDivisionNumber == null) {
      groupDivisionNumber = nextDivisionNumber;
    }

    let nextCompetitionNumber = groupDivisionNumber;
    const assignedCompetitors = competitors.map((competitor) => {
      const competitorValue = competitor && typeof competitor === 'object' ? competitor : {};
      let competitionDivisionNumber = parseOptionalInt(competitorValue.competitionDivisionNumber);
      if (competitionDivisionNumber == null) {
        competitionDivisionNumber = nextCompetitionNumber;
      }
      nextCompetitionNumber = competitionDivisionNumber + 1;

      return {
        ...competitorValue,
        groupDivisionNumber,
        competitionDivisionNumber
      };
    });

    if (assignedCompetitors.length > 0) {
      nextDivisionNumber = Math.max(nextDivisionNumber, nextCompetitionNumber);
    } else {
      nextDivisionNumber = Math.max(nextDivisionNumber, groupDivisionNumber);
    }

    return {
      ...value,
      groupDivisionNumber,
      competitors: assignedCompetitors
    };
  });
}

function summarizeGroupDivisionNumbers(groups) {
  return (Array.isArray(groups) ? groups : []).map((group) => ({
    groupId: group && group.groupId ? String(group.groupId) : '',
    groupDivisionNumber: parseOptionalInt(group && group.groupDivisionNumber),
    competitorCount: Array.isArray(group && group.competitors) ? group.competitors.length : 0,
    weaponsAssignedCount: Array.isArray(group && group.competitors)
      ? group.competitors.filter((competitor) => String(competitor && competitor.weaponsDivision ? competitor.weaponsDivision : '').trim().toLowerCase() !== 'unassigned').length
      : 0,
    hyungsAssignedCount: Array.isArray(group && group.competitors)
      ? group.competitors.filter((competitor) => String(competitor && competitor.hyungsDivision ? competitor.hyungsDivision : '').trim().toLowerCase() !== 'unassigned').length
      : 0,
    sparringAssignedCount: Array.isArray(group && group.competitors)
      ? group.competitors.filter((competitor) => String(competitor && competitor.sparringDivision ? competitor.sparringDivision : '').trim().toLowerCase() !== 'unassigned').length
      : 0,
    competitorDivisionNumbers: Array.isArray(group && group.competitors)
      ? group.competitors.map((competitor) => parseOptionalInt(competitor && competitor.competitionDivisionNumber)).filter((value) => value != null)
      : []
  }));
}

module.exports = {
  TRACE_PATH,
  appendDivisionTrace,
  assignDivisionNumbers,
  summarizeGroupDivisionNumbers
};
