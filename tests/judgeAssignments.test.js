const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const sqlite3 = require('sqlite3');
const initializeDatabase = require('../db/init');
const { initializeJudgeDatabase } = require('../db/judgeManagement');
const { createJudgeManagementRouter } = require('../backend/judgeManagementRoutes');
const { createJudgeAssignmentRouter } = require('../backend/judgeAssignmentRoutes');
const { createRingJudgeRouter } = require('../backend/ringJudgeRoutes');
const { readVolunteerDirectory, replaceVolunteerDirectory } = require('../backend/volunteerStore');
const { autoAssign, progressionOpportunity, minimums } = require('../backend/judgeAssignmentAlgorithm');
const { regionalDataset } = require('../backend/judgeSimulationData');
const { apiRoles, isTabletEndpoint } = require('../backend/browserPermissions');
const run = (db, sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, (error) => error ? reject(error) : resolve()));

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-assignments-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const eventsRoot = path.join(root, 'events'), judgeFile = path.join(root, 'judges.db');
  await initializeJudgeDatabase(judgeFile);
  for (const name of ['A', 'B']) {
    const dir = path.join(eventsRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    await initializeDatabase(path.join(dir, 'tournament.db'));
    fs.writeFileSync(path.join(dir, 'event-config.json'), JSON.stringify({
      date: '2026-01-15', scope: 'regional', tournamentDays: 1, ringConfigX: 4, ringConfigY: 5
    }));
  }
  const eventFile = path.join(eventsRoot, 'A', 'tournament.db');
  const app = express(); app.use(express.json({ limit: '3mb' }));
  app.use('/api', createJudgeManagementRouter({ file: judgeFile, currentDate: () => '2026-01-15', allowSimulation: true }));
  app.use('/api', createJudgeAssignmentRouter({ eventsRoot, judgeFile }));
  app.use('/api', createRingJudgeRouter({ eventsRoot, judgeFile, configurationStatus: () => ({ configurationLocked: false }) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = async (endpoint, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${endpoint}`, {
      method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
    });
    return { status: response.status, data: await response.json() };
  };
  const csv = regionalDataset('2026-01-15');
  const imported = await request('/judge-management-import', 'POST', { revision: 0, csv: csv.csv });
  assert.equal(imported.status, 200);
  let directory = await readVolunteerDirectory(eventFile);
  directory.volunteers = csv.judges.slice(0, 188).map((judge, index) => ({
    id: `v${index}`, firstName: judge.firstName, lastName: judge.lastName, associationNumber: judge.associationId.toLowerCase(),
    school: judge.school, rank: judge.rank, certification: 'UNKNOWN', primaryType: 'judging', secondaryType: '',
    age: index < 140 ? 25 + (index + 1) % 25 : judge.rank === 'CDB' ? 14 + (index + 1) % 8 : 16 + (index + 1) % 12,
    ageAsOf: '2026-01-15', parentName: '', contactNumber: '', gender: '', email: ''
  }));
  await replaceVolunteerDirectory(eventFile, directory.revision, directory);
  return { request, eventsRoot, eventFile, judgeFile };
}
const url = '/judge-assignments?eventName=A';
const phase = (data, available, discipline = 'black-belt', count = 20) => ({
  discipline, rings: data.rings.slice(0, count), available, arbitrators: [], assignments: {}
});

test('realistic 200-member directory supplies event volunteers only; 8, 16 and 20 rings can be staffed with arbitrator reserves', async (t) => {
  const { request } = await setup(t);
  const response = await request(url);
  assert.equal(response.status, 200);
  const data = response.data;
  assert.equal(data.judges.length, 188);
  assert.ok(data.judges.every((judge) => !Object.hasOwn(judge, 'dateOfBirth')));
  assert.equal(data.judges.filter((judge) => judge.roles.center).length, 40);
  assert.equal(data.judges.filter((judge) => judge.roles.corner).length, 136);
  assert.ok(data.judges.find((judge) => judge.id === 'SIM-R-137').qualificationIssue.includes('expires'));
  const available = data.judges.map((judge) => judge.id);
  for (const count of [8, 16, 20]) {
    const draft = phase(data, available, 'black-belt', count);
    draft.arbitrators = ['SIM-R-001', 'SIM-R-002', 'SIM-R-003', 'SIM-R-004'];
    const result = await request('/judge-assignments/auto?eventName=A', 'POST', {
      revision: data.revision, sourceRevision: data.sourceRevision, phase: draft
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.operatingRings, count);
    const used = Object.values(result.data.assignments).flatMap((ring) => Object.values(ring).flat());
    assert.equal(new Set(used).size, used.length);
    assert.ok(used.every((id) => !draft.arbitrators.includes(id)));
    if (count === 20) assert.equal(used.length, 140);
  }
  const other = await request('/judge-assignments?eventName=B');
  assert.equal(other.data.judges.length, 0);
  assert.equal((await request('/judge-assignments')).status, 400);
  assert.equal((await request('/judge-assignments?eventName=..')).status, 400);
  assert.equal((await request('/judge-assignments?eventName=missing')).status, 404);
  assert.deepEqual(apiRoles('PUT', '/api/judge-assignments'), ['administrator', 'event-coordinator', 'judging-coordinator']);
});

test('ring judge plan slices are read-only and preserve the saved qualification revision', async (t) => {
  const { request } = await setup(t);
  const data = (await request(url)).data;
  const center = data.judges.find((judge) => judge.roles.center);
  const corner = data.judges.find((judge) => judge.roles.corner && judge.id !== center.id);
  const draft = phase(data, [center.id, corner.id], 'black-belt', 2);
  const ringId = draft.rings[0];
  draft.assignments = { [ringId]: { center: [center.id], corner: [corner.id], sktk: [] } };
  const saved = await request(url, 'PUT', {
    revision: data.revision,
    sourceRevision: data.sourceRevision,
    replacementPin: 'A7!Q',
    phases: { P1: draft, P2: data.phases.P2 }
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.replacementPinConfigured, true);
  assert.equal(JSON.stringify(saved.data).includes('A7!Q'), false);
  const plan = await request(`/rings/${encodeURIComponent(ringId)}/judge-plan?eventName=A&phase=P1`);
  assert.equal(plan.status, 200);
  assert.equal(plan.data.type, 'tournament-judge-plan');
  assert.equal(plan.data.assignmentRevision, saved.data.revision);
  assert.equal(plan.data.replacementPinVerifier.algorithm, 'SHA-256-salted-v1');
  assert.equal(
    require('node:crypto').createHash('sha256')
      .update(`${plan.data.replacementPinVerifier.salt}:A7!Q`, 'utf8').digest('hex'),
    plan.data.replacementPinVerifier.digest
  );
  assert.equal(JSON.stringify(plan.data).includes('A7!Q'), false);
  assert.deepEqual(plan.data.positions.center.map((judge) => judge.associationId), [center.id]);
  assert.deepEqual(plan.data.positions.corner.map((judge) => judge.associationId), [corner.id]);
  assert.equal(plan.data.assigned, true);
  assert.equal(apiRoles('GET', `/api/rings/${ringId}/judge-plan`).includes('tournament-operator'), true);
  assert.equal(isTabletEndpoint('GET', `/api/rings/${ringId}/judge-plan`), true);
  const secondRing = await request(`/rings/${encodeURIComponent(draft.rings[1] || ringId)}/judge-plan?eventName=A&phase=P1`);
  assert.equal(secondRing.data.replacementPinVerifier.salt, plan.data.replacementPinVerifier.salt);
  const invalidPin = await request(url, 'PUT', {
    revision: saved.data.revision,
    sourceRevision: saved.data.sourceRevision,
    replacementPin: 'bad',
    phases: saved.data.phases
  });
  assert.equal(invalidPin.status, 400);
  const nonTextPin = await request(url, 'PUT', {
    revision: saved.data.revision,
    sourceRevision: saved.data.sourceRevision,
    replacementPin: 1234,
    phases: saved.data.phases
  });
  assert.equal(nonTextPin.status, 400);
});

test('certified competitors are potential candidates; agreement is per phase, duplicate role identities merge, and ring population uses directory certification', async (t) => {
  const { request, eventFile } = await setup(t);
  let directory = await readVolunteerDirectory(eventFile);
  directory.volunteers = directory.volunteers.filter((row) => row.associationNumber.toUpperCase() !== 'SIM-R-041');
  await replaceVolunteerDirectory(eventFile, directory.revision, directory);
  const db = new sqlite3.Database(eventFile);
  try {
    await run(db, `INSERT INTO competitors(id,firstName,lastName,associationNumber,rank,age,ageAsOf)
      VALUES(1,'Test41','Regional041','SIM-R-041','D1',30,'2026-01-15'),
      (2,'Test42','Regional042','SIM-R-042','D1',42,'2026-01-15'),
      (3,'Unmatched','Competitor','OTHER','D1',30,'2026-01-15')`);
  } finally { await new Promise((resolve) => db.close(resolve)); }
  let data = (await request(url)).data;
  const candidate = data.judges.find((judge) => judge.id === 'SIM-R-041');
  assert.equal(candidate.potential, true);
  assert.equal(candidate.certification, 'CORNER');
  assert.equal(candidate.priority, 4);
  assert.equal(data.judges.filter((judge) => judge.id === 'SIM-R-042').length, 1);
  assert.deepEqual(data.judges.find((judge) => judge.id === 'SIM-R-042').sources, ['volunteer', 'competitor']);
  assert.equal(data.judges.find((judge) => judge.id === 'SIM-R-042').priority, 6);
  assert.ok(!data.judges.some((judge) => judge.id === 'OTHER'));
  assert.deepEqual(data.phases.P1.available, []);
  const draft = phase(data, ['SIM-R-041'], 'gup', 1);
  draft.assignments = { [draft.rings[0]]: { center: [], corner: ['SIM-R-041'], sktk: [] } };
  let result = await request(url, 'PUT', { revision: data.revision, sourceRevision: data.sourceRevision,
    phases: { P1: data.phases.P1, P2: draft } });
  assert.equal(result.status, 200);
  data = result.data;
  assert.deepEqual(data.phases.P1.available, []);
  assert.deepEqual(data.phases.P2.available, ['SIM-R-041']);
  result = await request(url, 'PUT', { revision: data.revision, sourceRevision: data.sourceRevision,
    phases: { P1: { ...draft, discipline: 'black-belt' }, P2: draft } });
  assert.equal(result.status, 400);
  const rj = await request('/ring-judges?eventName=A');
  result = await request('/ring-judges/populate?eventName=A', 'POST', { revision: rj.data.revision });
  assert.equal(result.status, 200);
  assert.equal(result.data.judges.length, 2);
  assert.equal(result.data.certificationReadOnly, true);
  assert.ok(result.data.judges.every((judge) => judge.certification === 'CORNER'));
  assert.match(result.data.judges[0].reviewNotes, /potential judge/);
  const beforePriority = (await request(url)).data;
  const ringFile = path.join(path.dirname(eventFile), 'ring-judges.json');
  const ringData = JSON.parse(fs.readFileSync(ringFile, 'utf8'));
  ringData.judges.find((judge) => judge.associationNumber === 'SIM-R-041').priority = 9;
  ringData.revision = 'edited-priority';
  fs.writeFileSync(ringFile, JSON.stringify(ringData));
  const afterPriority = (await request(url)).data;
  assert.equal(afterPriority.judges.find((judge) => judge.id === 'SIM-R-041').priority, 9);
  assert.notEqual(afterPriority.sourceRevision, beforePriority.sourceRevision);
  const populated = result.data.judges[0];
  assert.equal((await request(`/ring-judges/${populated.id}?eventName=A`, 'PUT', {
    revision: result.data.revision, judge: { ...populated, certification: 'INTERNATIONAL' }
  })).status, 409);
});

test('In-House competitor approval adds only to Ring Judges and never assigns uncertified competitors', async (t) => {
  const { request, eventsRoot, eventFile } = await setup(t);
  const configFile = path.join(eventsRoot, 'A', 'event-config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  fs.writeFileSync(configFile, JSON.stringify({ ...config, scope: 'in-house' }));
  const db = new sqlite3.Database(eventFile);
  try {
    await run(db, `INSERT INTO competitors(id,firstName,lastName,associationNumber,rank,age,ageAsOf)
      VALUES(1,'Jordan','Test','UNMATCHED','D1',25,'2026-01-15')`);
  } finally { await new Promise((resolve) => db.close(resolve)); }

  const directory = await request('/ring-judges?eventName=A');
  assert.equal(directory.data.eventScope, 'in-house');
  const review = await request('/ring-judges/in-house-competitors?eventName=A');
  assert.equal(review.status, 200);
  assert.deepEqual(review.data.candidates.map((candidate) => candidate.associationNumber), ['UNMATCHED']);
  assert.equal((await request('/ring-judges/in-house-competitors?eventName=B')).status, 400);
  assert.equal((await request('/ring-judges/approve-in-house-competitors?eventName=A', 'POST', {
    revision: directory.data.revision, candidateRevision: 'stale', competitorIds: ['1']
  })).status, 409);

  const approved = await request('/ring-judges/approve-in-house-competitors?eventName=A', 'POST', {
    revision: directory.data.revision, candidateRevision: review.data.candidateRevision, competitorIds: ['1']
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.judges[0].priority, 4);
  assert.equal(approved.data.judges[0].certification, 'UNKNOWN');
  assert.equal(approved.data.judges[0].flaggedForReview, false);
  const assignments = await request('/judge-assignments?eventName=A');
  assert.ok(!assignments.data.judges.some((judge) => judge.id === 'UNMATCHED'));
});

test('saves reject invalid qualification, unconfirmed availability, double booking, stale sources and operational locks', async (t) => {
  const { request, eventFile, eventsRoot, judgeFile } = await setup(t);
  let data = (await request(url)).data;
  const draft = phase(data, ['SIM-R-041', 'SIM-R-137'], 'gup', 1);
  draft.assignments = { [draft.rings[0]]: { center: ['SIM-R-041'], corner: [], sktk: [] } };
  const save = () => request(url, 'PUT', { revision: data.revision, sourceRevision: data.sourceRevision,
    phases: { P1: data.phases.P1, P2: draft } });
  assert.equal((await save()).status, 400);
  draft.assignments[draft.rings[0]] = { center: [], corner: ['SIM-R-137'], sktk: [] };
  assert.equal((await save()).status, 400);
  draft.assignments[draft.rings[0]] = { center: [], corner: ['SIM-R-041'], sktk: ['SIM-R-041'] };
  assert.equal((await save()).status, 400);
  draft.available = []; draft.assignments[draft.rings[0]] = { center: [], corner: ['SIM-R-041'], sktk: [] };
  assert.equal((await save()).status, 400);
  draft.assignments = {};
  const directory = await readVolunteerDirectory(eventFile);
  await replaceVolunteerDirectory(eventFile, directory.revision, directory);
  assert.equal((await save()).status, 409);
  data = (await request(url)).data;
  const configFile = path.join(eventsRoot, 'A', 'event-config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  fs.writeFileSync(configFile, JSON.stringify({ ...config, ringConfigX: 3 }));
  assert.equal((await save()).status, 409);
  data = (await request(url)).data;
  const rosterDb = new sqlite3.Database(eventFile);
  try { await run(rosterDb, `INSERT INTO competitors(id,firstName,lastName,associationNumber,rank,age,ageAsOf)
    VALUES(1,'Other','Competitor','OTHER','D1',30,'2026-01-15')`); }
  finally { await new Promise((resolve) => rosterDb.close(resolve)); }
  assert.equal((await save()).status, 409);
  data = (await request(url)).data;
  const db = new sqlite3.Database(judgeFile);
  try { await run(db, 'UPDATE judge_management_settings SET revision=revision+1'); }
  finally { await new Promise((resolve) => db.close(resolve)); }
  assert.equal((await save()).status, 409);
  data = (await request(url)).data;
  let response = await save();
  assert.equal(response.status, 200);
  assert.equal((await save()).status, 409);
  data = response.data;
  fs.writeFileSync(path.join(eventsRoot, 'A', 'ring-assignments.json'), JSON.stringify({ rings: {}, eventStartedAt: '2026-01-15' }));
  assert.equal((await save()).status, 409);
});

test('date-based rank, age, expiration and identity issues block assignments without leaking private DOB', async (t) => {
  const { request, eventFile, judgeFile } = await setup(t);
  const db = new sqlite3.Database(judgeFile);
  try {
    await run(db, "UPDATE judges SET first_name='Different' WHERE association_id='SIM-R-041'");
    await run(db, "UPDATE judges SET certification_granted_at='2026-01-16' WHERE association_id='SIM-R-042'");
    await run(db, "UPDATE judges SET rank='CDB' WHERE association_id='SIM-R-045'");
  } finally { await new Promise((resolve) => db.close(resolve)); }
  const directory = await readVolunteerDirectory(eventFile);
  directory.volunteers.find((row) => row.associationNumber.toUpperCase() === 'SIM-R-043').rank = 'D2';
  directory.volunteers.find((row) => row.associationNumber.toUpperCase() === 'SIM-R-044').ageAsOf = '2025-01-15';
  directory.volunteers.find((row) => row.associationNumber.toUpperCase() === 'SIM-R-145').age = 15;
  directory.volunteers.find((row) => row.associationNumber.toUpperCase() === 'SIM-R-045').rank = 'CDB';
  await replaceVolunteerDirectory(eventFile, directory.revision, directory);
  const data = (await request(url)).data;
  for (const id of ['SIM-R-041', 'SIM-R-042', 'SIM-R-043', 'SIM-R-044', 'SIM-R-145']) {
    assert.ok(Object.values(data.judges.find((judge) => judge.id === id).roles).every((allowed) => !allowed), id);
  }
  const cdb = data.judges.find((judge) => judge.id === 'SIM-R-045');
  assert.equal(cdb.roles.corner, false);
  assert.equal(cdb.roles.sktk, true);
});

test('assignment optimization preserves staffing before progression and returns unique valid positions', () => {
  const judge = (id, roles, certification = 'CORNER', needs = false) => ({
    id, roles: { center: false, corner: false, sktk: false, ...roles }, certification,
    progression: { targetLevel: certification === 'SK_TK' ? 'CORNER' : 'REGIONAL', requiredExperience: needs ? 2 : 0, experienceCount: 0 }
  });
  const judges = [judge('center', { center: true, corner: true, sktk: true }, 'REGIONAL'),
    ...Array.from({ length: 5 }, (_, i) => judge(`corner${i}`, { corner: true, sktk: true }, 'CORNER', i === 4)),
    judge('sk', { sktk: true }, 'SK_TK', true)];
  const result = autoAssign(judges, ['A1', 'A2'], 'black-belt');
  assert.equal(result.operatingRings, 1);
  assert.ok(result.assignments.A1.corner.includes('corner4'));
  assert.ok(result.assignments.A1.sktk.includes('sk'));
  assert.equal(result.assignments.A1.center[0], 'center');
  for (const [role, min] of Object.entries(minimums('black-belt'))) assert.ok(result.assignments.A1[role].length >= min);
  assert.equal(progressionOpportunity(judge('x', { corner: true }, 'CORNER', true), 'center'), false);
  const all = Object.values(result.assignments).flatMap((ring) => Object.values(ring).flat());
  assert.equal(new Set(all).size, all.length);
});
test('higher priority wins role selection before progression opportunity', () => {
  const candidate = (id, priority, roles, progression = null) => ({
    id, priority, roles: { center: false, corner: false, sktk: false, ...roles },
    certification: 'REGIONAL', progression
  });
  const judges = [
    candidate('high-priority', 6, { center: true }),
    candidate('low-priority-progression', 4, { center: true }, {
      targetLevel: 'INTERNATIONAL', requiredExperience: 2, experienceCount: 0
    }),
    candidate('corner1', 4, { corner: true }),
    candidate('corner2', 4, { corner: true }),
    candidate('sktk', 4, { sktk: true })
  ];
  const result = autoAssign(judges, ['A1'], 'gup');
  assert.equal(result.operatingRings, 1);
  assert.deepEqual(result.assignments.A1.center, ['high-priority']);
});

test('verified service and retained retakes require an explicit award before subsequent-event Center assignment', async (t) => {
  const { request, eventsRoot, eventFile } = await setup(t);
  const associationId = 'SIM-R-041';
  const profile = async () => {
    const response = await request(`/judge-management/profile?associationId=${associationId}`);
    assert.equal(response.status, 200);
    return response.data;
  };
  let state = await profile();
  const judgeId = state.judge.id;
  const award = (grantedAt = '2026-01-15', revision = state.revision) =>
    request(`/judge-management/${judgeId}/award`, 'POST', { revision, grantedAt });
  const records = ['P1', 'P2'].map((phase) => ({
    eventId: 'step4-first', eventName: 'Step Four First Championship', eventDate: '2026-01-10',
    eventScope: 'REGIONAL', location: 'Fabricated venue', phase, role: 'CORNER_JUDGE', source: 'MANUAL'
  }));
  let response = await request('/judge-management/experience', 'POST', {
    associationId, revision: state.revision, confirmedCompleted: true, records
  });
  assert.equal(response.status, 200);
  state = await profile();
  assert.equal(state.eligibility.experienceCount, 0);
  const verify = async (ids, verified) => {
    const result = await request('/judge-management/experience-verify', 'POST', {
      associationId, revision: state.revision, ids, verified
    });
    assert.equal(result.status, 200);
    state = await profile();
  };
  await verify(state.experience.map((row) => row.id), true);
  assert.equal(state.eligibility.experienceCount, 1, 'two phases at one event count once');
  assert.equal(state.eligibility.eligible, false);
  assert.equal((await award()).status, 409);
  response = await request('/judge-management/experience', 'POST', {
    associationId, revision: state.revision, confirmedCompleted: true,
    records: [{ ...records[0], eventId: 'step4-second', eventName: 'Step Four Second Championship', eventDate: '2026-01-12' }]
  });
  assert.equal(response.status, 200);
  state = await profile();
  await verify(state.experience.filter((row) => row.eventId === 'step4-second').map((row) => row.id), true);
  assert.equal(state.eligibility.experienceCount, 2);
  assert.equal(state.eligibility.eligible, true);
  const attempts = [];
  const testAttempt = async (attempt) => {
    attempts.push({ targetLevel: 'REGIONAL', ...attempt });
    const result = await request(`/judge-management/${judgeId}`, 'PUT', {
      revision: state.revision, judge: state.judge, tests: attempts
    });
    assert.equal(result.status, 200);
    state = await profile();
    assert.equal(state.tests.length, attempts.length, 'retain previous attempts, not just latest result');
    assert.equal(state.judge.certification, 'CORNER', 'neither service nor tests auto-promote');
  };
  await testAttempt({ writtenDate: '2026-01-12', writtenScore: 79, practicalDate: '2026-01-12', practicalPassed: false });
  assert.equal(state.eligibility.writtenPassed, false);
  assert.equal(state.eligibility.practicalPassed, false);
  assert.equal((await award()).status, 409);
  await testAttempt({ writtenDate: '2026-01-13', writtenScore: 80 });
  assert.equal(state.eligibility.writtenPassed, true);
  assert.equal(state.eligibility.practicalPassed, false);
  assert.equal((await award()).status, 409);
  await testAttempt({ practicalDate: '2026-01-15', practicalPassed: true });
  assert.equal(state.eligibility.practicalPassed, true);
  assert.equal((await award('2026-01-14')).status, 409, 'cannot award before passing practical retake');
  assert.equal((await award('2026-01-16')).status, 400, 'cannot grant a future award');
  const nextFile = path.join(eventsRoot, 'B', 'tournament.db');
  let directory = await readVolunteerDirectory(nextFile);
  const officials = [associationId, 'SIM-R-042', 'SIM-R-043', 'SIM-R-145'];
  directory.volunteers = (await readVolunteerDirectory(eventFile)).volunteers
    .filter((row) => officials.includes(row.associationNumber.toUpperCase()))
    .map((row) => ({ ...row, ageAsOf: '2026-02-15', certification: 'UNKNOWN' }));
  await replaceVolunteerDirectory(nextFile, directory.revision, directory);
  const configFile = path.join(eventsRoot, 'B', 'event-config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  fs.writeFileSync(configFile, JSON.stringify({ ...config, date: '2026-02-15' }));
  const nextUrl = '/judge-assignments?eventName=B';
  const before = (await request(nextUrl)).data;
  const candidate = (data) => data.judges.find((row) => row.id === associationId);
  assert.equal(candidate(before).roles.center, false, 'ready to award is not yet a Center qualification');
  const plan = phase(before, [associationId], 'gup', 1);
  plan.assignments = { [plan.rings[0]]: { center: [associationId], corner: [], sktk: [] } };
  const save = (data) => request(nextUrl, 'PUT', { revision: data.revision,
    sourceRevision: data.sourceRevision, phases: { P1: plan, P2: data.phases.P2 } });
  assert.equal((await save(before)).status, 400);
  const secondId = state.experience.find((row) => row.eventId === 'step4-second').id;
  await verify([secondId], false);
  assert.equal(state.eligibility.experienceCount, 1);
  assert.equal((await award()).status, 409, 'passing tests alone cannot replace verified experience');
  await verify([secondId], true);
  assert.equal((await award('2026-01-15', state.revision - 1)).status, 409);
  response = await award();
  assert.equal(response.status, 200);
  state = await profile();
  assert.equal(state.judge.certification, 'REGIONAL');
  assert.equal(state.judge.grantedAt, '2026-01-15');
  assert.equal(state.judge.expiration, '2031-01-15');
  assert.equal(state.tests.length, 3);
  assert.equal(state.experience.length, 3);
  assert.equal((await award('2026-01-14')).status, 400, 'cannot move an award before the current certification grant');
  assert.equal((await save(before)).status, 409, 'old qualification snapshots must be reloaded after award');
  const after = (await request(nextUrl)).data;
  assert.equal(candidate(after).certification, 'REGIONAL');
  assert.equal(candidate(after).roles.center, true);
  assert.equal(candidate(after).progression.targetLevel, 'INTERNATIONAL');
  assert.equal(candidate(after).progression.experienceCount, 0, 'old Corner service does not become Center credit');
  assert.equal((await save(after)).status, 200);
  const automatic = await request('/judge-assignments/auto?eventName=B', 'POST', {
    revision: (await request(nextUrl)).data.revision, sourceRevision: after.sourceRevision,
    phase: { ...plan, available: officials }
  });
  assert.equal(automatic.status, 200);
  assert.equal(automatic.data.operatingRings, 1);
  assert.deepEqual(automatic.data.assignments[plan.rings[0]].center, [associationId]);
  assert.equal((await readVolunteerDirectory(nextFile)).volunteers[0].certification, 'UNKNOWN',
    'assignment reads the award without rewriting volunteer claims');
});

test('expired Center qualification and arbitrator reserves expose staffing shortfalls until explicit recertification', async (t) => {
  const { request } = await setup(t);
  const associationId = 'SIM-R-009';
  const profile = async () => {
    const response = await request(`/judge-management/profile?associationId=${associationId}`);
    assert.equal(response.status, 200);
    return response.data;
  };
  let state = await profile();
  const id = state.judge.id;
  const change = async (extra) => {
    const response = await request(`/judge-management/${id}`, 'PUT', {
      revision: state.revision, judge: state.judge, ...extra
    });
    assert.equal(response.status, 200);
    state = await profile();
  };
  await change({ judge: { ...state.judge, expiration: '2026-01-15' } });
  let data = (await request(url)).data;
  assert.equal(data.judges.find((row) => row.id === associationId).roles.center, true,
    'certificate remains usable on event-date expiration boundary');
  await change({ judge: { ...state.judge, expiration: '2026-01-14' } });
  data = (await request(url)).data;
  const candidate = data.judges.find((row) => row.id === associationId);
  assert.equal(candidate.roles.center, false);
  assert.match(candidate.qualificationIssue, /expires/);
  assert.equal(state.judge.certification, 'REGIONAL');
  assert.equal(state.eligibility.recertifying, true);
  assert.equal(state.eligibility.targetLevel, 'REGIONAL');
  assert.equal(state.eligibility.reviewRequired, true);
  const available = [associationId, 'SIM-R-041', 'SIM-R-042', 'SIM-R-145'];
  const draft = phase(data, available, 'gup');
  const automatic = (snapshot, overrides = {}) => request('/judge-assignments/auto?eventName=A', 'POST', {
    revision: snapshot.revision, sourceRevision: snapshot.sourceRevision, phase: { ...draft, ...overrides }
  });
  let result = await automatic(data);
  assert.equal(result.status, 200);
  assert.equal(result.data.operatingRings, 0, 'unavailable directory Centers cannot fill a volunteer staffing gap');
  assert.ok(Object.values(result.data.assignments).every((ring) => Object.values(ring).every((list) => !list.length)));
  const manual = { ...draft, assignments: { [draft.rings[0]]: { center: [associationId], corner: [], sktk: [] } } };
  assert.equal((await request(url, 'PUT', { revision: data.revision, sourceRevision: data.sourceRevision,
    phases: { P1: manual, P2: data.phases.P2 } })).status, 400);
  result = await request(url, 'PUT', { revision: data.revision, sourceRevision: data.sourceRevision,
    phases: { P1: { ...draft, assignments: result.data.assignments }, P2: data.phases.P2 } });
  assert.equal(result.status, 200, 'staffing shortfalls remain saveable as incomplete preparation');
  data = result.data;
  const award = () => request(`/judge-management/${id}/award`, 'POST', {
    revision: state.revision, grantedAt: '2026-01-15'
  });
  assert.equal((await award()).status, 409);
  const oldTests = [{ targetLevel: 'REGIONAL', writtenDate: '2020-01-01', writtenScore: 80,
    practicalDate: '2020-01-01', practicalPassed: true }];
  await change({ tests: oldTests });
  assert.equal(state.eligibility.writtenPassed, false);
  assert.equal((await award()).status, 409);
  const records = [10, 12].map((day) => ({
    eventId: `renewal-${day}`, eventName: `Renewal Championship ${day}`, eventDate: `2026-01-${day}`,
    location: 'Fabricated venue', eventScope: 'REGIONAL', phase: 'P1', role: 'CORNER_JUDGE', source: 'MANUAL'
  }));
  result = await request('/judge-management/experience', 'POST', {
    associationId, revision: state.revision, confirmedCompleted: true, records
  });
  assert.equal(result.status, 200);
  state = await profile();
  assert.equal(state.eligibility.eligible, false, 'unverified logs do not satisfy Regional recertification');
  result = await request('/judge-management/experience-verify', 'POST', {
    associationId, revision: state.revision, ids: state.experience.map((row) => row.id), verified: true
  });
  assert.equal(result.status, 200);
  state = await profile();
  assert.equal(state.eligibility.eligible, true);
  assert.equal(state.eligibility.writtenPassed, false);
  await change({ tests: [...oldTests, { targetLevel: 'REGIONAL', writtenDate: '2026-01-15', writtenScore: 80,
    practicalDate: '2026-01-15', practicalPassed: true }] });
  result = await award();
  assert.equal(result.status, 200);
  state = await profile();
  assert.equal(state.judge.certification, 'REGIONAL', 'recertification preserves the level, not International promotion');
  assert.equal(state.judge.expiration, '2031-01-15');
  assert.equal(state.tests.length, 2);
  assert.equal(state.experience.length, 2);
  assert.equal((await automatic(data)).status, 409, 'renewal invalidates stale preparation snapshots');
  data = (await request(url)).data;
  assert.equal(data.judges.find((row) => row.id === associationId).roles.center, true);
  for (const count of [8, 16, 20]) {
    result = await automatic(data, { rings: data.rings.slice(0, count) });
    assert.equal(result.status, 200);
    assert.equal(result.data.operatingRings, 1, 'four available officials staff only one Gup ring');
    const used = Object.values(result.data.assignments).flatMap((ring) => Object.values(ring).flat());
    assert.equal(used.length, 4);
    assert.equal(new Set(used).size, 4);
    assert.ok(used.every((member) => available.includes(member)));
  }
  result = await automatic(data, { discipline: 'black-belt' });
  assert.equal(result.data.operatingRings, 0, 'two Corners are insufficient for a BB ring');
  result = await automatic(data, { arbitrators: [associationId] });
  assert.equal(result.data.operatingRings, 0, 'reserved arbitrator cannot double as the only Center');
  result = await automatic(data, { available: [] });
  assert.equal(result.data.operatingRings, 0);
  assert.deepEqual((await profile()).experience, state.experience, 'planning never creates service or credit');
});
