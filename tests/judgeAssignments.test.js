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
const { apiRoles } = require('../backend/browserPermissions');
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
  assert.equal(data.judges.filter((judge) => judge.id === 'SIM-R-042').length, 1);
  assert.deepEqual(data.judges.find((judge) => judge.id === 'SIM-R-042').sources, ['volunteer', 'competitor']);
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
  const populated = result.data.judges[0];
  assert.equal((await request(`/ring-judges/${populated.id}?eventName=A`, 'PUT', {
    revision: result.data.revision, judge: { ...populated, certification: 'INTERNATIONAL' }
  })).status, 409);
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
