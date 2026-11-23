const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ageOnDate, validDate } = require('./tournamentAge');

const judgePoolCounts = { SK_TK: 30, CORNER: 95, REGIONAL: 35, INTERNATIONAL: 20 };
const MAX_SIMULATION_RINGS = 20;
const SIMULATION_JUDGE_POOL_SEED = 'simulation-judge-pool-v1';
const SIMULATION_JUDGE_POOL_REFERENCE_DATE = '2020-01-01';
const defaultProfile = {
  competitorCount: 600,
  ringRows: 4,
  ringColumns: 5,
  blackBeltPercent: 35,
  blackBeltAge15PlusPercent: 60,
  gupAge16PlusPercent: 40,
  blackBeltJudgePercent: 20,
  gupSktkJudgePercent: 1,
  judgePoolCount: 180,
  sktkJudgeCount: 30,
  cornerJudgeCount: 95,
  regionalJudgeCount: 35,
  internationalJudgeCount: 20,
  priorExperiencePercent: 30
};

const maleNames = ['Aaron', 'Adam', 'Alex', 'Andrew', 'Anthony', 'Austin', 'Benjamin', 'Caleb', 'Cameron',
  'Daniel', 'David', 'Dylan', 'Ethan', 'Gabriel', 'Henry', 'Isaac', 'Jack', 'Jacob', 'James', 'Joshua',
  'Liam', 'Logan', 'Lucas', 'Mason', 'Matthew', 'Michael', 'Nathan', 'Noah', 'Oliver', 'Ryan', 'Samuel',
  'Thomas', 'William'];
const femaleNames = ['Abigail', 'Alyssa', 'Amelia', 'Ava', 'Charlotte', 'Chloe', 'Claire', 'Ella', 'Emily',
  'Emma', 'Grace', 'Hannah', 'Isabella', 'Lily', 'Madison', 'Mia', 'Natalie', 'Olivia', 'Rachel', 'Sarah',
  'Sophia', 'Victoria', 'Zoe'];
const lastNames = ['Anderson', 'Baker', 'Bennett', 'Brooks', 'Campbell', 'Carter', 'Chen', 'Clark', 'Collins',
  'Cooper', 'Davis', 'Edwards', 'Evans', 'Foster', 'Garcia', 'Green', 'Hall', 'Harris', 'Hill', 'Howard',
  'Jackson', 'Johnson', 'Kim', 'Lewis', 'Long', 'Martin', 'Miller', 'Moore', 'Nelson', 'Nguyen', 'Parker',
  'Patel', 'Perez', 'Price', 'Reed', 'Rivera', 'Roberts', 'Scott', 'Taylor', 'Thomas', 'Walker', 'White',
  'Wilson', 'Wright', 'Young'];
const studioRoots = ['Blue Dragon', 'Cedar Valley', 'Golden Crane', 'Mountain Gate', 'North Star', 'Red River',
  'Silver Tiger', 'Stone Bridge', 'Sunrise', 'West Wind'];
const studioEndings = ['Tang Soo Do', 'Martial Arts', 'Dojang'];
const phonePrefixes = ['201-555', '212-555', '310-555', '312-555', '415-555', '503-555', '617-555', '702-555'];
const gupRanks = [
  ['TTLD', 4, 6], ['G10', 6], ['G9', 6], ['G8', 6], ['G7', 6], ['G6', 8], ['G5', 8], ['G4', 8],
  ['G3', 9], ['G2', 9], ['G1', 9], ['CDB', 9]
];
const danRankAges = [['D1', 11], ['D2', 13], ['D3', 17], ['D4', 25], ['D5', 34], ['D6', 43], ['D7', 55]];
const ageFloorByRank = new Map(danRankAges);

function createRandom(seed) {
  let state = crypto.createHash('sha256').update(seed).digest().readUInt32LE(0) || 0x6d2b79f5;
  return {
    next() {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0x100000000;
    },
    integer(minimum, maximum) {
      return minimum + Math.floor(this.next() * (maximum - minimum + 1));
    },
    choose(values) {
      return values[this.integer(0, values.length - 1)];
    },
    shuffle(values) {
      const shuffled = values.slice();
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const other = this.integer(0, index);
        [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
      }
      return shuffled;
    }
  };
}

function eventGuid(seed, eventDate) {
  const bytes = crypto.createHash('sha256').update(`simulator-prior-event:${eventDate}:${seed}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function subtractDays(date, days) {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() - days);
  return result.toISOString().slice(0, 10);
}

function birthDateForAge(date, age, random) {
  const [eventYear] = date.split('-').map(Number);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const year = eventYear - age - random.integer(0, 1);
    const month = random.integer(1, 12);
    const day = random.integer(1, new Date(Date.UTC(year, month, 0)).getUTCDate());
    const candidate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (ageOnDate(candidate, date) === age) return candidate;
  }
  throw new Error(`Unable to generate a birth date for age ${age} on ${date}.`);
}

function nameFor(gender, random) {
  return {
    firstName: random.choose(gender === 'Male' ? maleNames : femaleNames),
    lastName: random.choose(lastNames)
  };
}

function heightFor(age, gender, random) {
  const ranges = age < 5 ? [39, 45] : age < 7 ? [42, 49] : age < 9 ? [45, 54] :
    age < 11 ? [48, 59] : age < 13 ? [52, 65] : age < 15 ? [57, 70] :
      age < 18 ? [60, 75] : [gender === 'Female' ? 60 : 64, gender === 'Female' ? 72 : 80];
  return random.integer(ranges[0], ranges[1]);
}

function makePhoneQueue(random) {
  const first = phonePrefixes.map((prefix) => `${prefix}-${String(random.integer(100, 199)).padStart(4, '0')}`);
  const rest = phonePrefixes.flatMap((prefix) => Array.from({ length: 9000 }, (_, index) =>
    `${prefix}-${String(index + 1000).padStart(4, '0')}`)).filter((phone) => !first.includes(phone));
  return [...first, ...random.shuffle(rest)];
}

function danAssociationId(rank, random, usedIds) {
  const rankNumber = Number(rank.slice(1));
  const total = 53_000 - 23_000 + 1;
  const minimum = 23_000 + Math.floor((7 - rankNumber) * total / 7);
  const maximum = 23_000 + Math.floor((8 - rankNumber) * total / 7) - 1;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = random.integer(minimum, maximum);
    const id = `D${String(value).padStart(5, '0')}`;
    if (!usedIds.has(id)) { usedIds.add(id); return id; }
  }
  for (let value = minimum; value <= maximum; value += 1) {
    const id = `D${String(value).padStart(5, '0')}`;
    if (!usedIds.has(id)) { usedIds.add(id); return id; }
  }
  throw new Error(`No unused Dan number remains for rank ${rank}.`);
}

function associationIdFor(rank, random, usedIds) {
  if (rank.startsWith('D')) return danAssociationId(rank, random, usedIds);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = `G${random.integer(190_500, 270_500)}`;
    if (!usedIds.has(id)) { usedIds.add(id); return id; }
  }
  for (let value = 190_500; value <= 270_500; value += 1) {
    const id = `G${value}`;
    if (!usedIds.has(id)) { usedIds.add(id); return id; }
  }
  throw new Error('No unused Gup number remains.');
}

function chooseGupRank(age, random) {
  return random.choose(gupRanks.filter(([, minimumAge, maximumAge]) =>
    age >= minimumAge && (maximumAge === undefined || age <= maximumAge)))[0];
}

function chooseDanRank(age, random) {
  const eligible = danRankAges.slice(0, 3).filter(([, minimumAge]) => age >= minimumAge);
  const weights = [36, 24, 17, 10, 7, 4, 2];
  const candidates = eligible.flatMap(([rank], index) => Array(weights[index]).fill(rank));
  return random.choose(candidates);
}

function certificationFor(rank, age, random) {
  if (rank === 'CDB' || rank === 'G1') return 'SK_TK';
  if (rank === 'D1') return random.choose(age >= 16 ? ['SK_TK', 'CORNER'] : ['CORNER']);
  if (rank === 'D2' || rank === 'D3') return random.choose(['REGIONAL', 'CORNER']);
  if (/^D[4-7]$/.test(rank)) return 'INTERNATIONAL';
  throw new Error(`No judge certification rule exists for rank ${rank}.`);
}

function makePerson({ rank, age, gender, date, random, usedIds, phoneQueue }) {
  const name = nameFor(gender, random);
  const parent = age < 18 ? nameFor(random.choose(['Male', 'Female']), random) : null;
  const suffix = random.choose(studioEndings);
  const person = {
    ...name,
    gender,
    dob: birthDateForAge(date, age, random),
    age,
    ageAsOf: date,
    associationId: associationIdFor(rank, random, usedIds),
    rank,
    studio: `${random.choose(studioRoots)} ${suffix}`,
    specialNeeds: 'N',
    height: heightFor(age, gender, random),
    phone: phoneQueue.shift()
  };
  if (parent) {
    person.parentFirstName = parent.firstName;
    person.parentLastName = person.lastName;
    person.parentName = `${parent.firstName} ${person.lastName}`;
  } else {
    person.parentFirstName = '';
    person.parentLastName = '';
    person.parentName = '';
  }
  return person;
}

function priorExperienceFor(judges, eventDate, seed, random, percentage) {
  const count = Math.round(judges.length * percentage / 100);
  const selected = random.shuffle(judges).slice(0, count);
  const priorDate = subtractDays(eventDate, 30);
  const eventId = eventGuid(seed, eventDate);
  const eventName = 'Fall Regional Championship';
  const locations = ['Cedar Falls', 'Lakeview', 'Northfield', 'Riverton', 'Springfield', 'Westhaven'];
  return selected.map((judge) => {
    const role = judge.certification === 'SK_TK' ? 'SK_TK'
      : judge.certification === 'CORNER' ? 'CORNER_JUDGE' : 'CENTER_JUDGE';
    return {
      associationId: judge.associationId,
      eventId,
      eventName,
      eventDate: priorDate,
      location: random.choose(locations),
      role,
      eventScope: 'REGIONAL',
      phase: 'P1',
      source: 'SIMULATION',
      sourceId: `${judge.associationId}:${eventId}:${role}:P1`,
      logVerified: false
    };
  });
}

function judgeExperienceRole(certification) {
  return certification === 'SK_TK' ? 'SK_TK'
    : certification === 'CORNER' ? 'CORNER_JUDGE' : 'CENTER_JUDGE';
}

function judgeDatabaseRecord(person, certification) {
  return {
    associationId: person.associationId,
    firstName: person.firstName,
    lastName: person.lastName,
    gender: person.gender,
    dateOfBirth: person.dob,
    contactNumber: person.phone,
    school: person.studio,
    rank: person.rank,
    certification,
    expiration: '',
    status: 'Active',
    notes: 'FABRICATED simulation judge'
  };
}

function generateJudgePool({
  eventDate, seed, random = createRandom(seed), usedIds = new Set(),
  phoneQueue = makePhoneQueue(random), blackBeltCompetitors = [], gupCompetitors = []
}) {
  const membersByCertification = { SK_TK: [], CORNER: [], REGIONAL: [], INTERNATIONAL: [] };
  const d3Competitors = blackBeltCompetitors.filter((person) => person.rank === 'D3');
  if (d3Competitors.length > judgePoolCounts.REGIONAL) {
    const excess = random.shuffle(d3Competitors).slice(0, d3Competitors.length - judgePoolCounts.REGIONAL);
    for (const person of excess) {
      usedIds.delete(person.associationId);
      person.rank = 'D2';
      person.associationId = danAssociationId('D2', random, usedIds);
    }
  }
  const remainingRegionalSlots = judgePoolCounts.REGIONAL -
    blackBeltCompetitors.filter((person) => person.rank === 'D3').length;
  const regionalD2 = new Set(random.shuffle(blackBeltCompetitors.filter((person) => person.rank === 'D2'))
    .slice(0, remainingRegionalSlots));
  for (const person of blackBeltCompetitors) {
    const certification = person.rank === 'D3' || regionalD2.has(person) ? 'REGIONAL' : 'CORNER';
    person.certification = certification;
    membersByCertification[certification].push({ person, certification });
  }
  for (const person of gupCompetitors) {
    person.certification = 'SK_TK';
    membersByCertification.SK_TK.push({ person, certification: 'SK_TK' });
  }

  const ranksByCertification = {
    SK_TK: ['G1', 'CDB', 'D1'],
    CORNER: ['D1', 'D2'],
    REGIONAL: ['D2', 'D3', 'D4'],
    INTERNATIONAL: ['D4', 'D5', 'D6', 'D7']
  };
  const members = [];
  for (const [certification, count] of Object.entries(judgePoolCounts)) {
    const assigned = membersByCertification[certification];
    if (assigned.length > count) throw new Error(`Competitor judges exceed the ${certification} pool capacity.`);
    members.push(...assigned);
    for (let index = assigned.length; index < count; index += 1) {
      const rank = random.choose(ranksByCertification[certification]);
      const minimumAge = certification === 'SK_TK' ? 16 : ageFloorByRank.get(rank);
      const age = random.integer(minimumAge, 70);
      const person = makePerson({
        rank, age, gender: random.choose(['Male', 'Female']), date: eventDate, random, usedIds,
        phoneQueue
      });
      members.push({ person, certification });
    }
  }

  const judges = members.map(({ person, certification }) => judgeDatabaseRecord(person, certification));
  const priorExperience = priorExperienceFor(judges, eventDate, seed, random, defaultProfile.priorExperiencePercent);
  return { members, judges, priorExperience };
}

function generateSimulationSetup({
  eventDate,
  seed,
  competitorCount = defaultProfile.competitorCount
}) {
  validDate(eventDate);
  if (eventDate < SIMULATION_JUDGE_POOL_REFERENCE_DATE) {
    throw new Error(`Simulation event date must be on or after the fixed judge-pool reference date ${SIMULATION_JUDGE_POOL_REFERENCE_DATE}.`);
  }
  if (typeof seed !== 'string' || !seed.trim() || seed.length > 100) {
    throw new Error('A nonempty simulation seed of at most 100 characters is required.');
  }
  if (!Number.isSafeInteger(competitorCount) || competitorCount < 1 || competitorCount > 5000) {
    throw new Error('competitorCount must be an integer from 1 to 5000.');
  }
  const random = createRandom(seed);
  const ringCount = Math.max(4, Math.ceil((competitorCount * 0.65 / 21) / 4) * 4);
  if (ringCount > MAX_SIMULATION_RINGS) {
    throw new Error(`Competitor count requires ${ringCount} rings; the fixed simulation judge pool supports at most ${MAX_SIMULATION_RINGS}.`);
  }
  const ringRows = 4;
  const ringColumns = ringCount / ringRows;
  const blackBeltCount = Math.round(competitorCount * defaultProfile.blackBeltPercent / 100);
  const gupCount = competitorCount - blackBeltCount;
  const judgePool = generateJudgePool({
    eventDate: SIMULATION_JUDGE_POOL_REFERENCE_DATE,
    seed: SIMULATION_JUDGE_POOL_SEED
  });
  const currentAge = (person) => ageOnDate(person.dob, eventDate);
  const eligibleBlackBeltJudges = judgePool.members.filter(({ person, certification }) =>
    ['CORNER', 'REGIONAL'].includes(certification) && /^D[1-3]$/.test(person.rank) && currentAge(person) >= 15
  );
  const eligibleGupJudges = judgePool.members.filter(({ person, certification }) =>
    certification === 'SK_TK' && ['G1', 'CDB'].includes(person.rank) && currentAge(person) >= 16
  );
  const blackBeltJudgeCount = Math.round(blackBeltCount * defaultProfile.blackBeltJudgePercent / 100);
  const gupSktkJudgeCount = Math.round(gupCount * defaultProfile.gupSktkJudgePercent / 100);
  if (blackBeltJudgeCount > eligibleBlackBeltJudges.length ||
      gupSktkJudgeCount > eligibleGupJudges.length) {
    throw new Error("The fixed judge pool cannot satisfy this event's age-eligible competitor-judge targets.");
  }
  const selectedBlackBeltJudges = random.shuffle(eligibleBlackBeltJudges).slice(0, blackBeltJudgeCount);
  const selectedGupJudges = random.shuffle(eligibleGupJudges).slice(0, gupSktkJudgeCount);
  const blackBeltYoungCount = blackBeltCount -
    Math.round(blackBeltCount * defaultProfile.blackBeltAge15PlusPercent / 100);
  const blackBeltOlderCount = blackBeltCount - blackBeltYoungCount;
  const gupOlderCount = Math.round(gupCount * defaultProfile.gupAge16PlusPercent / 100);
  const gupYoungerCount = gupCount - gupOlderCount;
  const usedIds = new Set(judgePool.judges.map((judge) => judge.associationId));
  const poolPhones = new Set(judgePool.members.map(({ person }) => person.phone));
  const phoneQueue = makePhoneQueue(random).filter((phone) => !poolPhones.has(phone));
  const eventPerson = (person) => {
    const age = currentAge(person);
    return { ...person, age, ageAsOf: eventDate, height: heightFor(age, person.gender, random) };
  };
  const makeCompetitor = (age, blackBelt) => {
    const rank = blackBelt ? chooseDanRank(age, random) : chooseGupRank(age, random);
    return makePerson({
      rank, age, gender: random.choose(['Male', 'Female']), date: eventDate, random, usedIds, phoneQueue
    });
  };
  const blackBeltCompetitors = [
    ...selectedBlackBeltJudges.map(({ person, certification }) =>
      ({ ...eventPerson(person), certification })),
    ...Array.from({ length: blackBeltOlderCount - blackBeltJudgeCount }, () =>
      makeCompetitor(random.integer(15, 70), true)),
    ...Array.from({ length: blackBeltYoungCount }, () => makeCompetitor(random.integer(11, 14), true))
  ];
  const gups = [
    ...selectedGupJudges.map(({ person, certification }) =>
      ({ ...eventPerson(person), certification })),
    ...Array.from({ length: gupOlderCount - gupSktkJudgeCount }, () =>
      makeCompetitor(random.integer(16, 70), false)),
    ...Array.from({ length: gupYoungerCount }, () => makeCompetitor(random.integer(4, 15), false))
  ];
  const competitors = random.shuffle([...blackBeltCompetitors, ...gups]).map((person, index) => ({
    ...person,
    competitorId: `competitor-${String(index + 1).padStart(4, '0')}`
  }));
  const competitorJudgeIds = new Set(competitors.filter((person) => person.certification)
    .map((person) => person.associationId));
  const competitorJudgeCount = competitorJudgeIds.size;
  const judgeRequirementCount = ringCount * 7;
  const judgeTargetCount = Math.ceil(judgeRequirementCount * 1.2);
  const judgingVolunteerCount = judgeTargetCount - competitorJudgeCount;
  const eventJudgeMembers = random.shuffle(judgePool.members.filter(({ person }) =>
    !competitorJudgeIds.has(person.associationId))).slice(0, judgingVolunteerCount).map(({ person, certification }) => ({
    person: { ...person, age: currentAge(person), ageAsOf: eventDate },
    certification
  }));
  const judges = judgePool.judges;
  const priorExperience = judgePool.priorExperience;
  const setupVolunteerCount = random.integer(3, 6);
  const teardownVolunteerCount = random.integer(3, 6);
  const setupTeardownOverlapCount = Math.max(0, setupVolunteerCount + teardownVolunteerCount - 9);
  const setupTeardownUniqueCount = setupVolunteerCount + teardownVolunteerCount - setupTeardownOverlapCount;
  const securityVolunteerCount = Math.min(10, Math.max(2, Math.ceil(ringCount / 2)));
  const operationsVolunteerCount = Math.min(10, Math.max(4, Math.ceil(ringCount / 2) + 2));
  const awardsVolunteerCount = 2;
  const medicalVolunteerCount = 2;
  const otherVolunteerCount = setupTeardownUniqueCount + securityVolunteerCount +
    operationsVolunteerCount + awardsVolunteerCount + medicalVolunteerCount;
  const volunteers = [];
  let volunteerSequence = 0;
  const addVolunteer = (person, certification, primaryType, secondaryType = '') => {
    volunteerSequence++;
    volunteers.push({
      ...person,
      id: `volunteer-${String(volunteerSequence).padStart(4, '0')}`,
      associationNumber: person.associationId,
      certification,
      primaryType,
      secondaryType,
      contactNumber: person.phone,
      email: ''
    });
  };
  for (const { person, certification } of eventJudgeMembers) {
    addVolunteer(person, certification, 'judging');
  }
  const addSupportVolunteer = (primaryType, secondaryType = '') => {
    const rank = random.choose(['G1', 'CDB', 'D1', 'D2', 'D3']);
    const person = makePerson({
      rank, age: random.integer(Math.max(18, ageFloorByRank.get(rank) || 18), 70),
      gender: random.choose(['Male', 'Female']), date: eventDate, random, usedIds, phoneQueue
    });
    addVolunteer(person, 'UNKNOWN', primaryType, secondaryType);
  };
  for (let index = 0; index < setupTeardownOverlapCount; index += 1) {
    addSupportVolunteer('setup', 'teardown');
  }
  for (let index = setupTeardownOverlapCount; index < setupVolunteerCount; index += 1) {
    addSupportVolunteer('setup');
  }
  for (let index = setupTeardownOverlapCount; index < teardownVolunteerCount; index += 1) {
    addSupportVolunteer('teardown');
  }
  for (let index = 0; index < securityVolunteerCount; index += 1) addSupportVolunteer('security');
  for (let index = 0; index < operationsVolunteerCount; index += 1) addSupportVolunteer('operations');
  for (let index = 0; index < awardsVolunteerCount; index += 1) addSupportVolunteer('awards');
  for (let index = 0; index < medicalVolunteerCount; index += 1) addSupportVolunteer('medical');

  const priorExperienceCount = priorExperience.length;
  const profile = {
    ...defaultProfile,
    eventDate,
    seed,
    competitorCount,
    ringRows,
    ringColumns,
    ringCount,
    blackBeltCount,
    gupCount,
    judgeRequirementCount,
    judgeTargetCount,
    judgingVolunteerCount,
    otherVolunteerCount,
    volunteerCount: volunteers.length,
    judgeCount: judges.length,
    blackBeltJudgeCount,
    gupSktkJudgeCount,
    competitorJudgeCount,
    setupVolunteerCount,
    teardownVolunteerCount,
    setupTeardownOverlapCount,
    setupTeardownUniqueCount,
    securityVolunteerCount,
    operationsVolunteerCount,
    awardsVolunteerCount,
    medicalVolunteerCount,
    priorExperienceCount,
    priorEventId: priorExperience[0]?.eventId || eventGuid(seed, eventDate)
  };
  if (judges.length !== defaultProfile.judgePoolCount ||
      judgingVolunteerCount + competitorJudgeCount !== judgeTargetCount ||
      volunteers.length !== judgingVolunteerCount + otherVolunteerCount ||
      volunteers.filter((person) => person.primaryType === 'setup' || person.secondaryType === 'setup').length !== setupVolunteerCount ||
      volunteers.filter((person) => person.primaryType === 'teardown' || person.secondaryType === 'teardown').length !== teardownVolunteerCount ||
      priorExperience.length !== priorExperienceCount ||
      usedIds.size !== competitorCount + judgePool.members.filter(({ person }) =>
        !competitors.some((competitor) => competitor.associationId === person.associationId)).length +
        otherVolunteerCount) {
    throw new Error('Generated setup failed an internal count or identity check.');
  }
  return { profile, competitors, volunteers, judges, priorExperience };
}

function parseArguments(args) {
  if (args.length % 2 !== 0) throw new Error('Options require values.');
  const allowed = new Set(['--event-date', '--seed', '--output-dir', '--competitors']);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    if (option === '--output') throw new Error('Use --output-dir for the complete prepare-only package.');
    if (!allowed.has(option) || Object.hasOwn(values, option)) throw new Error(`Invalid option: ${option}`);
    values[option] = args[index + 1];
  }
  for (const required of ['--event-date', '--seed', '--output-dir']) {
    if (!values[required]) throw new Error(`${required} is required.`);
  }
  const integerOption = (option, fallback) => {
    if (values[option] === undefined) return fallback;
    if (!/^\d+$/.test(values[option])) throw new Error(`${option} must be a positive integer.`);
    return Number(values[option]);
  };
  return {
    eventDate: values['--event-date'],
    seed: values['--seed'],
    outputDirectory: path.resolve(values['--output-dir']),
    competitorCount: integerOption('--competitors', defaultProfile.competitorCount)
  };
}

function main(args) {
  const options = parseArguments(args);
  const { outputDirectory, ...generationOptions } = options;
  if (fs.existsSync(outputDirectory)) throw new Error(`Output directory already exists: ${outputDirectory}`);
  const setup = generateSimulationSetup(generationOptions);
  const { buildPreparationFiles, writeCsvFiles } = require('./simulatorSetupCsvExport');
  const { files, summary } = buildPreparationFiles(setup);
  const output = writeCsvFiles(files, outputDirectory);
  console.log(`Created preparation files in ${output}: ${summary.competitorCount} competitors, ${summary.volunteerCount} volunteers, ${summary.judgeCount} judges, ${summary.priorExperienceCount} prior-experience records, and ${summary.experienceRequestCount} API requests.`);
  if (summary.competitorRankWarnings) console.warn(`${summary.competitorRankWarnings} competitor row(s) will be flagged by the existing import flow as ineligible by rank and require review.`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = {
  generateSimulationSetup, generateJudgePool, defaultProfile, certificationFor, main,
  SIMULATION_JUDGE_POOL_SEED, SIMULATION_JUDGE_POOL_REFERENCE_DATE
};
