const assert = require('node:assert/strict');
const test = require('node:test');

const {
  selectEligibleSparringCompetitors,
  simulateSparringDivision
} = require('../backend/dayOfSparring');
const { validateResultPacket } = require('../backend/resultPacket');

function participant(participantId, overrides = {}) {
  return {
    participantId,
    name: participantId,
    studio: 'Studio A',
    heightInInches: 60,
    checkInStatus: 'CHECKED_IN',
    entries: { sparring: 'REGISTERED' },
    ...overrides
  };
}

function buildPacket(participants, sparring) {
  const completedAt = '2026-10-26T12:00:00.000Z';
  return {
    schemaVersion: 1,
    submissionId: '0b6c7dd3-8c75-4d33-89c4-05af8ac8b002',
    eventName: 'sparring-test',
    groupId: '1',
    groupDivisionNumber: 1,
    groupName: 'Division 1',
    ringId: 'ring-a-1',
    ringLabel: 'A1',
    completedAt,
    participants: participants.map(({ participantId, ...value }) => ({
      participantId,
      competitionDivisionNumber: 1,
      ...value,
      rankCode: value.rankCode ?? 'G5',
      rankLabel: value.rankLabel ?? 'G5',
      age: 18,
      heightInInches: value.heightInInches ?? 60,
      entries: { weapons: 'REGISTERED', hyungs: 'REGISTERED', sparring: 'REGISTERED' }
    })),
    disciplines: {
      weapons: { status: 'NOT_HELD', judgeCount: 0, results: [] },
      hyungs: { status: 'NOT_HELD', judgeCount: 0, results: [] },
      sparring
    },
    overallAwards: { weapons: [], hyungs: [], sparring: sparring.awards },
    signatures: [],
    source: {
      client: 'TournamentScoringApp',
      appVersionName: 'test',
      appVersionCode: 1,
      tabletLabel: 'Simulator',
      createdAt: completedAt
    }
  };
}

test('selects only checked-in, registered sparring entrants', () => {
  const entrants = [
    participant('eligible'),
    participant('no-show', { checkInStatus: 'NO_SHOW' }),
    participant('not-checked-in', { checkInStatus: 'REGISTERED' }),
    participant('scratched', { entries: { sparring: 'SCRATCHED' } }),
    participant('unregistered', { entries: { sparring: 'COMPLETED' } })
  ];

  assert.deepEqual(
    selectEligibleSparringCompetitors(entrants).map((entrant) => entrant.participantId),
    ['eligible']
  );
});

test('simulates single-entrant bye and no-entrant not-held cases', () => {
  const single = simulateSparringDivision([participant('solo')], { random: () => 0.5 });
  assert.equal(single.status, 'COMPLETED');
  assert.equal(single.bracketSize, 2);
  assert.equal(single.rounds.length, 1);
  assert.equal(single.rounds[0].bouts[0].outcome, 'BYE');
  assert.equal(single.rounds[0].bouts[0].winnerParticipantId, 'solo');
  assert.deepEqual(single.awards, [{ place: '1st', participantId: 'solo' }]);

  assert.deepEqual(simulateSparringDivision([]), {
    status: 'NOT_HELD',
    bracketSize: 0,
    awards: [],
    rounds: []
  });
});

test('advances seeded bouts, awards and warning deductions using app scoring rules', () => {
  const entrants = [
    participant('p1', { heightInInches: 57, studio: 'A' }),
    participant('p2', { heightInInches: 58, studio: 'B' }),
    participant('p3', { heightInInches: 60, studio: 'A' }),
    participant('p4', { heightInInches: 61, studio: 'B' })
  ];
  const first = simulateSparringDivision(entrants, { random: () => 0.1 });
  const second = simulateSparringDivision(entrants, { random: () => 0.1 });

  assert.deepEqual(first, second);
  assert.equal(first.bracketSize, 4);
  assert.equal(first.rounds.length, 2);
  assert.equal(first.rounds[0].bouts.length, 2);
  assert.equal(first.rounds[1].bouts.length, 1);
  assert.equal(first.rounds[0].bouts[0].blueParticipantId, 'p1');
  assert.equal(first.rounds[0].bouts[0].redParticipantId, 'p2');
  assert.deepEqual(first.awards.map((award) => award.place), ['1st', '2nd', 'Co-3rd', 'Co-3rd']);
  assert.equal(first.rounds.flatMap((round) => round.bouts).every((bout) =>
    bout.winnerParticipantId && ['BYE', 'FIRST_TO_THREE', 'TIME_EXPIRED', 'WARNING_DISQUALIFICATION'].includes(bout.outcome)
  ), true);
  for (const bout of first.rounds.flatMap((round) => round.bouts)) {
    assert.equal(bout.blueAdjustedPoints, Math.max(0, bout.blueRawPoints - Math.floor(bout.blueStandardWarnings / 2)));
    assert.equal(bout.redAdjustedPoints, Math.max(0, bout.redRawPoints - Math.floor(bout.redStandardWarnings / 2)));
    assert.equal(bout.blueDisqualified, bout.blueStandardWarnings >= 3);
    assert.equal(bout.redDisqualified, bout.redStandardWarnings >= 3);
  }

  const packet = buildPacket(entrants, first);
  assert.deepEqual(validateResultPacket(packet, 'ring-a-1', 'sparring-test'), []);
});

test('applies two standard-warning deduction and resolves the 120-second result', () => {
  const values = [0.6, 0.1, 0.99, 0.1, 0, 0.9];
  const result = simulateSparringDivision(
    [participant('blue'), participant('red')],
    { random: () => values.shift() }
  );
  const [bout] = result.rounds[0].bouts;

  assert.equal(bout.outcome, 'TIME_EXPIRED');
  assert.equal(bout.elapsedSeconds, 120);
  assert.equal(bout.blueRawPoints, 4);
  assert.equal(bout.blueStandardWarnings, 2);
  assert.equal(bout.blueAdjustedPoints, 3);
  assert.equal(bout.redAdjustedPoints, 2);
  assert.equal(bout.winnerParticipantId, 'blue');
  assert.equal(bout.warnings.length, 2);
});

test('applies UI same-studio reseating when the adjacent bout has nearby heights', () => {
  const entrants = [
    participant('a1', { heightInInches: 60, studio: 'A' }),
    participant('a2', { heightInInches: 61, studio: 'A' }),
    participant('b1', { heightInInches: 62, studio: 'B' }),
    participant('c1', { heightInInches: 63, studio: 'C' })
  ];
  const result = simulateSparringDivision(entrants, { random: () => 0.1 });

  assert.deepEqual(
    result.rounds[0].bouts.slice(0, 2).map((bout) => [bout.blueParticipantId, bout.redParticipantId]),
    [['a1', 'b1'], ['a2', 'c1']]
  );
});

test('advances the opponent when an entrant reaches three standard warnings', () => {
  const values = [0.9, 0.1, 0.1, 0, 0];
  const result = simulateSparringDivision(
    [participant('blue'), participant('red')],
    { random: () => values.shift() }
  );
  const [bout] = result.rounds[0].bouts;

  assert.equal(bout.outcome, 'WARNING_DISQUALIFICATION');
  assert.equal(bout.blueDisqualified, true);
  assert.equal(bout.blueStandardWarnings, 3);
  assert.equal(bout.redDisqualified, false);
  assert.equal(bout.winnerParticipantId, 'red');
});

test('distributes first-round byes across different second-round groups', () => {
  const entrants = Array.from({ length: 5 }, (_, index) =>
    participant(`p${index + 1}`, { heightInInches: 55 + index }));
  const result = simulateSparringDivision(entrants, { random: () => 0.25 });
  const firstRound = result.rounds[0].bouts;
  const byeIndexes = firstRound.flatMap((bout, index) => bout.outcome === 'BYE' ? [index] : []);

  assert.equal(result.bracketSize, 8);
  assert.equal(byeIndexes.length, 3);
  assert.ok(byeIndexes.some((index) => index === 0 || index === 1));
  assert.ok(byeIndexes.some((index) => index === 2 || index === 3));
  assert.equal(result.rounds.length, 3);
  assert.equal(result.rounds[1].bouts.length, 2);
  assert.equal(result.rounds[2].bouts.length, 1);
});

test('rejects duplicate participant IDs and invalid random values', () => {
  assert.throws(() => simulateSparringDivision([
    participant('duplicate'),
    participant('duplicate')
  ]), /Duplicate sparring participant/);
  assert.throws(() => simulateSparringDivision([
    participant('p1'),
    participant('p2')
  ], {
    random: () => 1
  }), /random must return/);
});
