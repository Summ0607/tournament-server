const crypto = require('crypto');

function groupNumber(group) {
  const value = Number.parseInt(group.groupDivisionNumber ?? group.id ?? group.groupId, 10);
  return Number.isFinite(value) ? value : null;
}

function entryStatus(value) {
  return ['REGISTERED', 'SCRATCHED', 'COMPLETED'].includes(value) ? value : 'REGISTERED';
}

function createSimulatorResultPacket({
  eventName,
  ringId,
  ringLabel,
  tabletLabel,
  group,
  completedAt,
  simulateSparring,
  selectEligibleSparringCompetitors
}) {
  const divisionNumber = groupNumber(group);
  const participants = (Array.isArray(group.competitors) ? group.competitors : []).map((competitor, index) => {
    const participantId = String(competitor.participantId || competitor.id || `${divisionNumber}-${index + 1}`);
    const firstName = String(competitor.firstName || '').trim();
    const lastName = String(competitor.lastName || '').trim();
    const entries = {
      weapons: entryStatus(competitor.weaponsEntryStatus),
      hyungs: entryStatus(competitor.hyungsEntryStatus),
      sparring: entryStatus(competitor.sparringEntryStatus)
    };
    return {
      participantId,
      competitionDivisionNumber: Number.isInteger(Number(competitor.competitionDivisionNumber))
        ? Number(competitor.competitionDivisionNumber)
        : divisionNumber,
      name: String(competitor.fullName || competitor.name || [firstName, lastName].filter(Boolean).join(' ') || `Competitor ${index + 1}`),
      studio: String(competitor.studio || ''),
      rankCode: String(competitor.rankCode || competitor.rank || ''),
      rankLabel: String(competitor.rankLabel || competitor.rankCode || competitor.rank || ''),
      age: Number.isInteger(Number(competitor.age)) && Number(competitor.age) >= 0
        ? Number(competitor.age)
        : 0,
      heightInInches: Number.isInteger(Number(competitor.heightInInches ?? competitor.height))
        ? Number(competitor.heightInInches ?? competitor.height)
        : null,
      checkInStatus: competitor.checkInStatus === 'NO_SHOW' || competitor.checkInStatus === 'REGISTERED'
        ? competitor.checkInStatus
        : 'CHECKED_IN',
      entries
    };
  });
  const eligible = selectEligibleSparringCompetitors(participants);
  const sparring = simulateSparring(eligible);

  return {
    schemaVersion: 1,
    submissionId: crypto.randomUUID(),
    eventName,
    groupId: String(divisionNumber ?? group.id ?? group.groupId ?? ''),
    groupDivisionNumber: divisionNumber,
    groupName: String(group.name || group.groupName || ''),
    ringId,
    ringLabel,
    completedAt,
    participants,
    disciplines: {
      weapons: { status: 'NOT_HELD', judgeCount: 0, results: [] },
      hyungs: { status: 'NOT_HELD', judgeCount: 0, results: [] },
      sparring
    },
    overallAwards: { weapons: [], hyungs: [], sparring: sparring.awards },
    signatures: [],
    source: {
      client: 'TournamentScoringApp',
      appVersionName: 'simulator',
      appVersionCode: 1,
      tabletLabel,
      createdAt: completedAt
    }
  };
}

module.exports = { createSimulatorResultPacket };
