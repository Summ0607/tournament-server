const BOUT_DURATION_SECONDS = 120;

function nextPowerOfTwo(value) {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

function nextInt(random, minInclusive, maxExclusive) {
  return minInclusive + Math.floor(random() * (maxExclusive - minInclusive));
}

function seededRosterRandom(competitors) {
  const sortedCompetitors = competitors.slice().sort((left, right) => {
    const leftId = String(left.participantId);
    const rightId = String(right.participantId);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  let seed = 0;
  for (const competitor of sortedCompetitors) {
    const id = String(competitor.participantId);
    let hash = 0;
    for (let index = 0; index < id.length; index += 1) {
      hash = Math.imul(31, hash) + id.charCodeAt(index) | 0;
    }
    seed = Math.imul(31, seed) + hash | 0;
  }
  let state = seed >>> 0;
  return function random() {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, random) {
  const result = items.slice();
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = nextInt(random, 0, index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function createFirstRound(competitors) {
  if (competitors.length === 1) {
    return [{ boutNumber: 1, blue: competitors[0], red: null, bye: true }];
  }
  const bracketSize = nextPowerOfTwo(competitors.length);
  const pairCount = bracketSize / 2;
  const random = seededRosterRandom(competitors);
  const byeCount = bracketSize - competitors.length;
  const secondRoundGroupCount = Math.floor(pairCount / 2);
  const byePairIndexes = new Set();

  if (byeCount <= secondRoundGroupCount) {
    const byeGroups = shuffle(
      Array.from({ length: secondRoundGroupCount }, (_, index) => index),
      random
    ).slice(0, byeCount);
    for (const groupIndex of byeGroups) {
      const pairA = groupIndex * 2;
      byePairIndexes.add(random() < 0.5 ? pairA : pairA + 1);
    }
  } else {
    const preferredSlots = Array.from({ length: secondRoundGroupCount }, (_, groupIndex) => {
      const pairA = groupIndex * 2;
      return random() < 0.5 ? pairA : pairA + 1;
    });
    const preferred = new Set(preferredSlots);
    const remaining = shuffle(
      Array.from({ length: pairCount }, (_, index) => index).filter((index) => !preferred.has(index)),
      random
    ).slice(0, byeCount - secondRoundGroupCount);
    [...preferredSlots, ...remaining].forEach((index) => byePairIndexes.add(index));
  }

  const ordered = competitors
    .map((competitor, index) => ({ competitor, index }))
    .sort((left, right) =>
      (Number(left.competitor.heightInInches) || 0) - (Number(right.competitor.heightInInches) || 0) ||
      left.index - right.index
    )
    .map(({ competitor }) => competitor);
  let competitorIndex = 0;
  const bouts = Array.from({ length: pairCount }, (_, index) => {
    if (byePairIndexes.has(index)) {
      return { boutNumber: index + 1, blue: ordered[competitorIndex++], red: null, bye: true };
    }
    return {
      boutNumber: index + 1,
      blue: ordered[competitorIndex++],
      red: ordered[competitorIndex++],
      bye: false
    };
  });

  for (let index = 0; index < bouts.length - 1; index += 1) {
    const bout = bouts[index];
    const nextBout = bouts[index + 1];
    if (!bout.blue || !bout.red || bout.blue.studio !== bout.red.studio ||
        !nextBout.blue || !nextBout.red) continue;
    if (Math.abs((Number(bout.blue.heightInInches) || 0) - (Number(nextBout.blue.heightInInches) || 0)) <= 4 &&
        Math.abs((Number(bout.red.heightInInches) || 0) - (Number(nextBout.red.heightInInches) || 0)) <= 4 &&
        bout.blue.studio !== nextBout.blue.studio) {
      [bout.red, nextBout.blue] = [nextBout.blue, bout.red];
    }
  }
  return bouts;
}

function createBoutResult(bout, boutNumber, random) {
  if (bout.bye) {
    return {
      boutNumber,
      blueParticipantId: bout.blue && bout.blue.participantId || null,
      redParticipantId: bout.red && bout.red.participantId || null,
      winnerParticipantId: (bout.blue || bout.red).participantId,
      outcome: 'BYE',
      blueRawPoints: 0,
      blueAdjustedPoints: 0,
      blueStandardWarnings: 0,
      blueSevereWarnings: 0,
      redRawPoints: 0,
      redAdjustedPoints: 0,
      redStandardWarnings: 0,
      redSevereWarnings: 0,
      elapsedSeconds: BOUT_DURATION_SECONDS,
      blueDisqualified: false,
      redDisqualified: false,
      warnings: [],
      winner: bout.blue || bout.red,
      loser: null
    };
  }

  let blueWarnings = nextInt(random, 0, 4);
  let redWarnings = nextInt(random, 0, 4);
  if (blueWarnings >= 3 && redWarnings >= 3) {
    if (random() < 0.5) blueWarnings = 2;
    else redWarnings = 2;
  }
  const blueDisqualified = blueWarnings >= 3;
  const redDisqualified = redWarnings >= 3;
  const blueDeduction = Math.floor(blueWarnings / 2);
  const redDeduction = Math.floor(redWarnings / 2);
  const elapsedSeconds = nextInt(random, 30, BOUT_DURATION_SECONDS + 1);
  const blueWins = blueDisqualified ? false
    : redDisqualified ? true
      : random() < 0.5;
  let blueRawPoints = nextInt(random, 0, 5);
  let redRawPoints = nextInt(random, 0, 5);

  if (!blueDisqualified && !redDisqualified) {
    if (blueWins) {
      blueRawPoints = Math.max(blueRawPoints, 3 + blueDeduction);
      redRawPoints = Math.min(redRawPoints, 2 + redDeduction);
    } else {
      redRawPoints = Math.max(redRawPoints, 3 + redDeduction);
      blueRawPoints = Math.min(blueRawPoints, 2 + blueDeduction);
    }
  }

  const blueAdjustedPoints = Math.max(0, blueRawPoints - blueDeduction);
  const redAdjustedPoints = Math.max(0, redRawPoints - redDeduction);
  const winner = blueDisqualified ? bout.red
    : redDisqualified ? bout.blue
      : (blueWins ? bout.blue : bout.red);
  const loser = winner === bout.blue ? bout.red : bout.blue;
  const outcome = blueDisqualified || redDisqualified
    ? 'WARNING_DISQUALIFICATION'
    : (elapsedSeconds >= BOUT_DURATION_SECONDS ? 'TIME_EXPIRED' : 'FIRST_TO_THREE');
  const warnings = [
    ...Array.from({ length: blueWarnings }, () => ({
      side: 'BLUE',
      type: 'STANDARD',
      reason: 'Simulated standard warning'
    })),
    ...Array.from({ length: redWarnings }, () => ({
      side: 'RED',
      type: 'STANDARD',
      reason: 'Simulated standard warning'
    }))
  ];

  return {
    boutNumber,
    blueParticipantId: bout.blue.participantId,
    redParticipantId: bout.red.participantId,
    winnerParticipantId: winner.participantId,
    outcome,
    blueRawPoints,
    blueAdjustedPoints,
    blueStandardWarnings: blueWarnings,
    blueSevereWarnings: 0,
    redRawPoints,
    redAdjustedPoints,
    redStandardWarnings: redWarnings,
    redSevereWarnings: 0,
    elapsedSeconds,
    blueDisqualified,
    redDisqualified,
    warnings,
    winner,
    loser
  };
}

function selectEligibleSparringCompetitors(participants) {
  return (Array.isArray(participants) ? participants : []).filter((participant) =>
    participant && participant.checkInStatus === 'CHECKED_IN' &&
    participant.entries && participant.entries.sparring === 'REGISTERED'
  );
}

function simulateSparringDivision(competitors, { random = Math.random } = {}) {
  if (!Array.isArray(competitors)) throw new Error('Sparring competitors must be an array');
  if (typeof random !== 'function') throw new Error('random must be a function');
  if (competitors.length === 0) {
    return { status: 'NOT_HELD', bracketSize: 0, awards: [], rounds: [] };
  }
  const roll = () => {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new Error('random must return a finite number from 0 inclusive to 1 exclusive');
    }
    return value;
  };
  const ids = new Set();
  for (const competitor of competitors) {
    if (!competitor || typeof competitor.participantId !== 'string' || !competitor.participantId.trim()) {
      throw new Error('Each sparring competitor requires a participantId');
    }
    if (ids.has(competitor.participantId)) throw new Error(`Duplicate sparring participant: ${competitor.participantId}`);
    ids.add(competitor.participantId);
  }

  const bracketSize = Math.max(2, nextPowerOfTwo(competitors.length));
  let bouts = createFirstRound(competitors);
  let nextGlobalBoutNumber = bouts.length + 1;
  const rounds = [];
  const semifinalLosers = [];
  let roundNumber = 1;

  while (bouts.length) {
    const results = bouts.map((bout) =>
      createBoutResult(bout, bout.boutNumber, roll));
    const winners = results.map((result) => result.winner).filter(Boolean);
    rounds.push({
      roundNumber,
      bouts: results.map(({ winner, loser, ...result }) => result)
    });
    if (winners.length <= 1) {
      break;
    }
    if (bouts.length === 2) {
      semifinalLosers.push(...results.map((result) => result.loser).filter(Boolean));
    }
    bouts = [];
    for (let index = 0; index < winners.length; index += 2) {
      bouts.push({
        boutNumber: nextGlobalBoutNumber++,
        blue: winners[index],
        red: winners[index + 1] || null,
        bye: winners[index + 1] == null
      });
    }
    roundNumber += 1;
  }

  const final = rounds.at(-1)?.bouts[0];
  const champion = final && competitors.find((competitor) => competitor.participantId === final.winnerParticipantId);
  const runnerUp = final && [final.blueParticipantId, final.redParticipantId]
    .filter(Boolean)
    .map((id) => competitors.find((competitor) => competitor.participantId === id))
    .find((competitor) => competitor && competitor.participantId !== final.winnerParticipantId);
  const awardRecipients = [champion, runnerUp, ...semifinalLosers].filter(Boolean).slice(0, 4);
  const labels = ['1st', '2nd', 'Co-3rd', 'Co-3rd'];
  return {
    status: 'COMPLETED',
    bracketSize,
    awards: awardRecipients.map((competitor, index) => ({
      place: labels[index],
      participantId: competitor.participantId
    })),
    rounds
  };
}

module.exports = { selectEligibleSparringCompetitors, simulateSparringDivision };
