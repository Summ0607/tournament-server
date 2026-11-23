const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateSimulationSetup } = require('../backend/simulatorSetupGenerator');

const eventDate = '2027-02-13';
const seed = 'sim-tournament-2027-02-13-v1';
const danAge = { D1: 11, D2: 13, D3: 17, D4: 25, D5: 34, D6: 43, D7: 55 };
const heightRange = (age, gender) => age < 5 ? [39, 45] : age < 7 ? [42, 49] : age < 9 ? [45, 54] :
  age < 11 ? [48, 59] : age < 13 ? [52, 65] : age < 15 ? [57, 70] :
    age < 18 ? [60, 75] : gender === 'Female' ? [60, 72] : [64, 80];
const priorRole = (certification) => certification === 'SK_TK' ? 'SK_TK'
  : certification === 'CORNER' ? 'CORNER_JUDGE' : 'CENTER_JUDGE';

test('builds a reproducible 20-ring setup with the fixed judge pool and experience baseline', () => {
  const setup = generateSimulationSetup({ eventDate, seed });
  const { profile, competitors, volunteers, judges, priorExperience } = setup;
  assert.deepEqual(profile, {
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
    priorExperiencePercent: 30,
    eventDate,
    seed,
    ringCount: 20,
    blackBeltCount: 210,
    gupCount: 390,
    judgeRequirementCount: 140,
    judgeTargetCount: 168,
    judgingVolunteerCount: 122,
    otherVolunteerCount: 33,
    volunteerCount: 155,
    judgeCount: 180,
    blackBeltJudgeCount: 42,
    gupSktkJudgeCount: 4,
    competitorJudgeCount: 46,
    setupVolunteerCount: 6,
    teardownVolunteerCount: 3,
    setupTeardownOverlapCount: 0,
    setupTeardownUniqueCount: 9,
    securityVolunteerCount: 10,
    operationsVolunteerCount: 10,
    awardsVolunteerCount: 2,
    medicalVolunteerCount: 2,
    priorExperienceCount: 54,
    priorEventId: profile.priorEventId
  });
  assert.equal(competitors.length, 600);
  assert.equal(volunteers.length, 155);
  assert.equal(judges.length, 180);
  assert.equal(priorExperience.length, 54);

  const blackBelts = competitors.filter((person) => person.rank.startsWith('D'));
  const gups = competitors.filter((person) => !person.rank.startsWith('D'));
  assert.equal(blackBelts.length, 210);
  assert.ok(blackBelts.every((person) => Number(person.rank.slice(1)) <= 3));
  assert.equal(gups.length, 390);
  assert.equal(blackBelts.filter((person) => person.age >= 15).length, 126);
  assert.equal(gups.filter((person) => person.age >= 16).length, 156);
  for (const person of competitors) {
    assert.equal(person.age, require('../backend/tournamentAge').ageOnDate(person.dob, eventDate));
    assert.equal(person.ageAsOf, eventDate);
    assert.equal(person.specialNeeds, 'N');
    const [minimumHeight, maximumHeight] = heightRange(person.age, person.gender);
    assert.ok(person.height >= minimumHeight && person.height <= maximumHeight);
    assert.match(person.studio, /(?:Tang Soo Do|Martial Arts|Dojang)$/);
    if (person.age < 18) {
      assert.ok(person.parentFirstName);
      assert.equal(person.parentLastName, person.lastName);
      assert.equal(person.parentName, `${person.parentFirstName} ${person.lastName}`);
    }
    if (person.rank.startsWith('D')) {
      assert.ok(person.age >= danAge[person.rank]);
      assert.match(person.associationId, /^D\d{5}$/);
      assert.ok(Number(person.associationId.slice(1)) >= 23000);
      assert.ok(Number(person.associationId.slice(1)) <= 53000);
    } else {
      assert.match(person.associationId, /^G\d{6}$/);
      assert.ok(Number(person.associationId.slice(1)) >= 190500);
      assert.ok(Number(person.associationId.slice(1)) <= 270500);
      const minimumAge = person.rank === 'TTLD' ? 4 :
        ['G10', 'G9', 'G8', 'G7'].includes(person.rank) ? 6 :
          ['G6', 'G5', 'G4'].includes(person.rank) ? 8 : 9;
      assert.ok(person.age >= minimumAge);
      if (person.rank === 'TTLD') assert.ok(person.age <= 6);
    }
  }

  const phonePeople = new Map(competitors.map((person) => [person.associationId, person.phone]));
  for (const volunteer of volunteers) {
    if (phonePeople.has(volunteer.associationNumber)) {
      assert.equal(volunteer.contactNumber, phonePeople.get(volunteer.associationNumber));
    } else phonePeople.set(volunteer.associationNumber, volunteer.contactNumber);
  }
  const phones = [...phonePeople.values()];
  assert.equal(new Set(phones).size, phones.length);
  assert.ok(phones.every((phone) => /^\d{3}-\d{3}-\d{4}$/.test(phone)));
  assert.ok(new Set(phones.map((phone) => phone.slice(0, 7))).size >= 8);

  const judgingVolunteers = volunteers.filter((volunteer) => volunteer.primaryType === 'judging');
  const otherVolunteers = volunteers.filter((volunteer) => volunteer.primaryType !== 'judging');
  assert.equal(judgingVolunteers.length, 122);
  assert.equal(otherVolunteers.length, 33);
  assert.equal(judgingVolunteers.length + profile.competitorJudgeCount, profile.judgeTargetCount);
  const judgesById = new Map(judges.map((judge) => [judge.associationId, judge]));
  for (const volunteer of judgingVolunteers) {
    const judge = judgesById.get(volunteer.associationNumber);
    assert.ok(judge);
    assert.equal(judge.certification, volunteer.certification);
  }
  const competitorIds = new Set(competitors.map((person) => person.associationId));
  const volunteerIds = new Set(judgingVolunteers.map((person) => person.associationNumber));
  const competitorJudges = judges.filter((judge) => competitorIds.has(judge.associationId));
  assert.equal(competitorJudges.length, 46);
  assert.equal(competitorJudges.filter((judge) => !volunteerIds.has(judge.associationId)).length, 46);
  assert.equal(volunteers.filter((volunteer) => volunteer.primaryType === 'security').length, 10);
  assert.equal(volunteers.filter((volunteer) => volunteer.primaryType === 'operations').length, 10);
  assert.equal(volunteers.filter((volunteer) => volunteer.primaryType === 'awards').length, 2);
  assert.equal(volunteers.filter((volunteer) => volunteer.primaryType === 'medical').length, 2);
  assert.equal(volunteers.filter((volunteer) => volunteer.primaryType === 'setup' ||
    volunteer.secondaryType === 'setup').length, profile.setupVolunteerCount);
  assert.equal(volunteers.filter((volunteer) => volunteer.primaryType === 'teardown' ||
    volunteer.secondaryType === 'teardown').length, profile.teardownVolunteerCount);
  assert.ok(profile.setupTeardownUniqueCount <= 9);
  assert.equal(blackBelts.filter((person) => person.certification).length, 42);
  assert.equal(competitorJudges.filter((judge) =>
    blackBelts.some((person) => person.associationId === judge.associationId)).length, 42);
  assert.equal(competitorJudges.filter((judge) =>
    gups.some((person) => person.associationId === judge.associationId)).length, 4);

  const danNumbers = new Map();
  assert.deepEqual(Object.fromEntries(['SK_TK', 'CORNER', 'REGIONAL', 'INTERNATIONAL'].map((certification) =>
    [certification, judges.filter((judge) => judge.certification === certification).length]
  )), { SK_TK: 30, CORNER: 95, REGIONAL: 35, INTERNATIONAL: 20 });
  for (const judge of judges) {
    if (judge.rank.startsWith('D')) {
      assert.ok(judge.dateOfBirth);
      assert.ok(require('../backend/tournamentAge').ageOnDate(judge.dateOfBirth, eventDate) >= danAge[judge.rank]);
      danNumbers.set(judge.rank, Number(judge.associationId.slice(1)));
    }
    if (/^D[5-7]$/.test(judge.rank)) assert.equal(judge.certification, 'INTERNATIONAL');
    if (judge.rank === 'D4') assert.ok(['REGIONAL', 'INTERNATIONAL'].includes(judge.certification));
    if (['D2', 'D3'].includes(judge.rank)) assert.ok(['REGIONAL', 'CORNER'].includes(judge.certification));
    if (judge.rank === 'D1') assert.ok(['SK_TK', 'CORNER'].includes(judge.certification));
    if (judge.certification === 'SK_TK') {
      assert.ok(['G1', 'CDB', 'D1'].includes(judge.rank));
      assert.ok(require('../backend/tournamentAge').ageOnDate(judge.dateOfBirth, eventDate) >= 16);
    }
  }
  for (let rank = 1; rank < 7; rank += 1) {
    assert.ok(danNumbers.get(`D${rank}`) > danNumbers.get(`D${rank + 1}`));
  }
  assert.equal(new Set(judges.map((judge) => judge.associationId)).size, 180);

  assert.equal(new Set(priorExperience.map((record) => record.associationId)).size, 54);
  assert.equal(new Set(priorExperience.map((record) => record.eventId)).size, 1);
  assert.equal(priorExperience[0].eventId, profile.priorEventId);
  assert.match(profile.priorEventId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(priorExperience.every((record) => record.eventDate < eventDate &&
    record.source === 'SIMULATION' && record.logVerified === false &&
    record.role === priorRole(judgesById.get(record.associationId).certification)));

  assert.deepEqual(generateSimulationSetup({ eventDate, seed }), setup);
});

test('rejects invalid setup parameters instead of producing partial data', () => {
  assert.throws(() => generateSimulationSetup({ eventDate: '2027-02-30', seed }), /tournament date/i);
  assert.throws(() => generateSimulationSetup({ eventDate: '2019-12-31', seed }), /reference date/i);
  assert.throws(() => generateSimulationSetup({ eventDate, seed: '' }), /seed/i);
  assert.throws(() => generateSimulationSetup({ eventDate, seed, competitorCount: 0 }), /competitorCount/i);
  assert.throws(() => generateSimulationSetup({ eventDate, seed, competitorCount: 647 }), /supports at most 20/i);
  assert.equal(generateSimulationSetup({ eventDate, seed, competitorCount: 646 }).profile.ringCount, 20);
});

test('reuses the same 180 judges and baseline experience across simulated events', () => {
  const first = generateSimulationSetup({ eventDate, seed });
  const second = generateSimulationSetup({ eventDate: '2028-02-13', seed: 'another-event-seed' });
  assert.deepEqual(first.judges, second.judges);
  assert.deepEqual(first.priorExperience, second.priorExperience);
  assert.notDeepEqual(
    first.volunteers.filter((volunteer) => volunteer.primaryType === 'judging')
      .map((volunteer) => volunteer.associationNumber).sort(),
    second.volunteers.filter((volunteer) => volunteer.primaryType === 'judging')
      .map((volunteer) => volunteer.associationNumber).sort()
  );
  assert.equal(first.profile.priorEventId, second.profile.priorEventId);
  assert.notDeepEqual(first.competitors, second.competitors);
});

test('CLI writes the complete preparation package once and refuses to overwrite it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'simulator-setup-'));
  const output = path.join(directory, 'prepared');
  const cli = path.resolve(__dirname, '../backend/simulatorSetupGenerator.js');
  const args = [cli, '--event-date', eventDate, '--seed', seed, '--output-dir', output];
  try {
    execFileSync(process.execPath, args, { stdio: 'pipe' });
    const setup = JSON.parse(fs.readFileSync(path.join(output, 'setup.json'), 'utf8'));
    assert.equal(setup.competitors.length, 600);
    assert.equal(setup.volunteers.length, 155);
    assert.equal(setup.judges.length, 180);
    assert.equal(setup.priorExperience.length, 54);
    assert.deepEqual(fs.readdirSync(output).sort(), [
      'competitors.csv', 'experience-api.json', 'judges.csv', 'setup.json', 'volunteers.csv'
    ]);
    const apiRequests = JSON.parse(fs.readFileSync(path.join(output, 'experience-api.json'), 'utf8'));
    assert.equal(apiRequests.length, 54);
    assert.ok(apiRequests.every((request) => request.records.length === 1 &&
      request.records[0].logVerified === false && request.records[0].source === 'SIMULATION'));
    assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('scales judge coverage and security/operations with event size', () => {
  for (const [competitorCount, expectedRings] of [[130, 8], [646, 20]]) {
    const setup = generateSimulationSetup({ eventDate, seed, competitorCount });
    const { profile, volunteers } = setup;
    assert.equal(profile.ringCount, expectedRings);
    assert.equal(profile.judgeRequirementCount, expectedRings * 7);
    assert.equal(profile.judgeTargetCount, Math.ceil(expectedRings * 7 * 1.2));
    assert.equal(profile.judgingVolunteerCount + profile.competitorJudgeCount, profile.judgeTargetCount);
    assert.equal(profile.securityVolunteerCount, Math.min(10, Math.max(2, Math.ceil(expectedRings / 2))));
    assert.equal(profile.operationsVolunteerCount,
      Math.min(10, Math.max(4, Math.ceil(expectedRings / 2) + 2)));
    assert.ok(profile.setupVolunteerCount >= 3 && profile.setupVolunteerCount <= 6);
    assert.ok(profile.teardownVolunteerCount >= 3 && profile.teardownVolunteerCount <= 6);
    assert.ok(profile.setupTeardownUniqueCount <= 9);
    assert.equal(volunteers.length, profile.volunteerCount);
  }
});
