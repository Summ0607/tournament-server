const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createSimulationApp, initializeSimulation, readSimulation } = require('../backend/judgeSimulation');

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-simulation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'simulation');
  await initializeSimulation(directory, '2040-01-15');
  return directory;
}

async function start(t, directory) {
  const server = createSimulationApp(directory).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (endpoint, method = 'GET', body, headers = {}) => {
    const response = await fetch(base + endpoint, { method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  return { request, base };
}

test('isolated fixtures cover candidate, certification, testing, experience and expiration states without reseeding', async (t) => {
  const directory = await setup(t);
  const { request } = await start(t, directory);
  const { data } = await request('/api/judge-management');
  assert.equal(data.asOf, '2040-01-15');
  assert.equal(data.judges.length, 11);
  assert.deepEqual(new Set(data.judges.map((judge) => judge.certification)),
    new Set(['UNKNOWN', 'UNCERTIFIED', 'SK_TK', 'CORNER', 'REGIONAL', 'INTERNATIONAL']));
  assert.ok(data.judges.every((judge) => judge.associationId.startsWith('SIM-') && !Object.hasOwn(judge, 'dateOfBirth')));
  const eligibility = (id) => data.eligibility.find((item) => item.judgeId === data.judges.find((judge) => judge.associationId === id).id);
  assert.equal(eligibility('SIM-001').eligible, true);
  assert.equal(eligibility('SIM-003').writtenPassed, false);
  assert.equal(eligibility('SIM-003').practicalPassed, false);
  assert.match(eligibility('SIM-002').reason, /age 16/);
  assert.equal(eligibility('SIM-003').experienceCount, 0);
  for (const id of ['SIM-004', 'SIM-006', 'SIM-007']) {
    assert.equal(eligibility(id).eligible, true, id);
    assert.equal(eligibility(id).writtenPassed, true, id);
    assert.equal(eligibility(id).practicalPassed, true, id);
  }
  assert.equal(eligibility('SIM-005').writtenPassed, false);
  assert.equal(eligibility('SIM-005').practicalPassed, false);
  assert.equal(eligibility('SIM-009').recertifying, true);
  assert.equal(eligibility('SIM-009').reviewRequired, true);
  assert.equal(eligibility('SIM-010').experienceCount, 0);
  assert.equal(eligibility('SIM-011').experienceCount, 0);
  const before = fs.readFileSync(path.join(directory, 'judges.db'));
  const readyJudge = data.judges.find((judge) => judge.associationId === 'SIM-003');
  const deniedAward = await request(`/api/judge-management/${readyJudge.id}/award`, 'POST', {
    revision: data.revision, grantedAt: data.asOf
  });
  assert.equal(deniedAward.status, 409);
  await assert.rejects(initializeSimulation(directory, '2040-02-01'), /EEXIST/);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'judges.db')), before);
  const restarted = await start(t, directory);
  assert.deepEqual((await restarted.request('/api/judge-management')).data, data);
});

test('simulation date controls all judge writes, eligibility, imports and awards, and persists across restart', async (t) => {
  const directory = await setup(t);
  const { request } = await start(t, directory);
  let state = (await request('/api/judge-management')).data;
  const judge = state.judges.find((item) => item.associationId === 'SIM-001');
  const update = (extra) => request(`/api/judge-management/${judge.id}`, 'PUT', {
    revision: state.revision, judge, ...extra
  });
  let response = await update({ tests: [{ targetLevel: 'SK_TK', writtenDate: '2040-01-16', writtenScore: 80 }] });
  assert.equal(response.status, 400);
  assert.match(response.data.error, /Written test date cannot be in the future/);
  response = await update({ tests: [{ targetLevel: 'CORNER', practicalDate: '2040-01-16', practicalPassed: true }] });
  assert.equal(response.status, 400);
  assert.match(response.data.error, /Practical test date cannot be in the future/);
  response = await update({ experience: [{ eventName: 'Future simulated event', eventDate: '2040-01-16',
    location: '', role: 'SCOREKEEPER', eventScope: 'REGIONAL', logVerified: false }] });
  assert.equal(response.status, 400);
  assert.match(response.data.error, /Event date cannot be in the future/);
  response = await update({ judge: { ...judge, dateOfBirth: '2040-01-16' } });
  assert.equal(response.status, 400);
  assert.match(response.data.error, /Date of birth cannot be in the future/);
  response = await request('/api/judge-management-import', 'POST', { revision: state.revision,
    csv: 'lastName,DOB,idNumber,firstName,rank\nCandidate,2040-01-16,SIM-NEW,New,D1' });
  assert.equal(response.status, 400);
  response = await update({ tests: [{ targetLevel: 'SK_TK', writtenDate: '2040-01-15', writtenScore: 80 }] });
  assert.equal(response.status, 200);
  state = response.data;
  response = await request(`/api/judge-management/${judge.id}/award`, 'POST', { revision: state.revision, grantedAt: '2040-01-16' });
  assert.equal(response.status, 400);
  response = await request('/api/simulation', 'PUT', { previousDate: '2040-01-15', date: '2040-01-16' });
  assert.equal(response.status, 200);
  response = await request(`/api/judge-management/${judge.id}/award`, 'POST', { revision: state.revision, grantedAt: '2040-01-16' });
  assert.equal(response.status, 200);
  state = response.data;
  const promoted = state.judges.find((item) => item.id === judge.id);
  assert.equal(promoted.certification, 'SK_TK');
  assert.equal(promoted.grantedAt, '2040-01-16');
  assert.equal(promoted.expiration, '2045-01-16');
  response = await request('/api/simulation', 'PUT', { previousDate: '2040-01-16', date: '2042-01-16' });
  assert.equal(response.status, 200);
  state = (await request('/api/judge-management')).data;
  const young = state.judges.find((item) => item.associationId === 'SIM-002');
  assert.equal(state.eligibility.find((item) => item.judgeId === young.id).eligible, true);
  const expired = state.judges.find((item) => item.associationId === 'SIM-006');
  assert.equal(state.eligibility.find((item) => item.judgeId === expired.id).recertifying, true);
  response = await request('/api/simulation', 'PUT', { previousDate: '2042-01-16', date: '2040-01-15' });
  assert.equal(response.status, 400);
  response = await request('/api/simulation', 'PUT', { previousDate: '2040-01-15', date: '2043-01-15' });
  assert.equal(response.status, 409);
  const restarted = await start(t, directory);
  assert.equal(readSimulation(directory).date, '2042-01-16');
  const persisted = (await restarted.request('/api/judge-management')).data;
  assert.equal(persisted.asOf, '2042-01-16');
  assert.equal(persisted.judges.find((item) => item.id === judge.id).certification, 'SK_TK');
});

test('simulation exposes only isolated management/preparation UI and APIs, rejecting other origins and live paths', async (t) => {
  const directory = await setup(t);
  const { request, base } = await start(t, directory);
  assert.equal((await request('/api/judge-management', 'GET', null, { Origin: 'https://other.example' })).status, 403);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const req = http.get(base + '/api/judge-management', { headers: { Host: 'other.example' } }, (res) => {
      res.resume(); resolve(res.statusCode);
    });
    req.on('error', reject);
  });
  assert.equal(wrongHostStatus, 403);
  for (const endpoint of ['/judges.db', '/simulation.json', '/api/events', '/api/simulation-results', '/api/results', '/api/rings', '/events/test/tournament.db']) {
    assert.equal((await request(endpoint)).status, 404, endpoint);
  }
  const html = await (await fetch(base)).text();
  assert.match(html, /FABRICATED DATA ONLY/);
  const template = await (await fetch(base + '/management-template')).text();
  assert.match(template, /id="judgeManagementView"/);
  for (const asset of ['/judge-simulation.js', '/judge-management.js', '/volunteers.js', '/ring-judges.js', '/judge-assignments.js', '/judge-service-review.js']) {
    assert.equal((await fetch(base + asset)).status, 200);
  }
  const before = readSimulation(directory);
  const response = await request('/api/simulation', 'PUT', { previousDate: before.date, date: '2040-02-30' });
  assert.equal(response.status, 400);
  assert.deepEqual(readSimulation(directory), before);
});

test('isolated preparation persists explicit participants, shared identities and independent P1/P2 plans without credit', async (t) => {
  const directory = await setup(t);
  const { request } = await start(t, directory);
  const initial = (await request('/api/judge-management')).data;
  for (const [index, ringCount] of [8, 16, 20].entries()) {
    const result = await request('/api/simulation/events', 'POST', {
      name: `Regional ${index + 1}`, date: '2040-01-15', scope: 'regional', tournamentDays: index === 1 ? 2 : 1, ringCount
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.event.ringConfigX * result.data.event.ringConfigY, ringCount);
  }
  const url = '/api/simulation/participation?eventName=Regional%201';
  let state = (await request(url)).data;
  assert.equal(state.judges.length, 11);
  assert.deepEqual(state.volunteers, []);
  assert.deepEqual(state.competitors, []);
  assert.equal(state.judges.find((row) => row.associationId === 'SIM-002').age, 14);
  assert.ok(state.judges.every((row) => !Object.hasOwn(row, 'birth') && !Object.hasOwn(row, 'dateOfBirth')));
  const members = ['SIM-003', 'SIM-005', 'SIM-006', 'SIM-007', 'SIM-008', 'SIM-010', 'SIM-011'].map((associationId) =>
    ({ associationId, volunteer: true, competitor: false }));
  members.push({ associationId: 'SIM-004', volunteer: false, competitor: true },
    { associationId: 'SIM-002', volunteer: true, competitor: true });
  let response = await request(url, 'POST', { revision: state.revision, judgeRevision: state.judgeRevision, members });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.deepEqual(response.data, { addedVolunteers: 8, addedCompetitors: 2 });
  assert.equal((await request(url, 'POST', { revision: state.revision, judgeRevision: state.judgeRevision, members })).status, 409);
  state = (await request(url)).data;
  response = await request(url, 'POST', { revision: state.revision, judgeRevision: state.judgeRevision, members });
  assert.deepEqual(response.data, { addedVolunteers: 0, addedCompetitors: 0 });
  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(path.join(directory, 'events', 'Regional 1', 'tournament.db'), sqlite3.OPEN_READONLY);
  try {
    const rows = await new Promise((resolve, reject) => db.all(`SELECT c.personId,v.person_id
      FROM competitors c JOIN volunteers v ON c.associationNumber=v.association_id WHERE c.associationNumber='SIM-002'`,
    (error, rows) => error ? reject(error) : resolve(rows)));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].personId, rows[0].person_id);
  } finally { await new Promise((resolve) => db.close(resolve)); }
  assert.equal((await request('/api/simulation/participation?eventName=Regional%202')).data.volunteers.length, 0);
  const volunteers = (await request('/api/volunteers?eventName=Regional%201')).data;
  assert.ok(volunteers.volunteers.every((row) => row.certification === 'UNKNOWN' && row.ageAsOf === '2040-01-15'));
  assert.equal(volunteers.volunteers.find((row) => row.associationNumber === 'SIM-002').parentName, 'Fabricated guardian');
  assert.ok((await request('/api/schools')).data.schools.every((school) => school.name.startsWith('Simulation School')));
  const ringUrl = '/api/ring-judges?eventName=Regional%201';
  let roster = (await request(ringUrl)).data;
  response = await request('/api/ring-judges/populate?eventName=Regional%201', 'POST', { revision: roster.revision });
  assert.equal(response.status, 200);
  assert.equal(response.data.judges.find((row) => row.associationNumber === 'SIM-004').certification, 'SK_TK');
  roster = response.data;
  response = await request('/api/ring-judges/populate-volunteers?eventName=Regional%201', 'POST', { revision: roster.revision });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const planUrl = '/api/judge-assignments?eventName=Regional%201';
  let plan = (await request(planUrl)).data;
  assert.equal(plan.rings.length, 8);
  assert.equal(plan.judges.length, 9);
  assert.equal(plan.judges.find((row) => row.associationId === 'SIM-004').potential, true);
  assert.deepEqual(plan.phases.P1.available, []);
  assert.deepEqual(plan.phases.P2.available, []);
  const draft = { discipline: 'gup', rings: plan.rings.slice(0, 1), available: plan.judges.map((row) => row.id), arbitrators: [], assignments: {} };
  response = await request('/api/judge-assignments/auto?eventName=Regional%201', 'POST', {
    revision: plan.revision, sourceRevision: plan.sourceRevision, phase: draft
  });
  assert.equal(response.status, 200);
  assert.equal(response.data.operatingRings, 1);
  draft.assignments = response.data.assignments;
  response = await request(planUrl, 'PUT', {
    revision: plan.revision, sourceRevision: plan.sourceRevision, phases: { P1: plan.phases.P1, P2: draft }
  });
  assert.equal(response.status, 200);
  plan = response.data;
  assert.deepEqual(plan.phases.P1.available, []);
  assert.deepEqual(plan.phases.P2, draft);
  assert.deepEqual((await request('/api/judge-management')).data, initial, 'preparation must never create service or awards');
  const restarted = await start(t, directory);
  assert.equal((await restarted.request('/api/simulation/events')).data.events.length, 3);
  assert.deepEqual((await restarted.request(url)).data, state);
  assert.deepEqual((await restarted.request(planUrl)).data.phases, plan.phases);
  const { buildReview } = require('../tournament-management/judge-service-review');
  let review = buildReview(state.config, plan, initial);
  assert.ok(review.rows.length > 0);
  assert.deepEqual(review.actual, []);
  const planned = review.rows.find((row) => row.associationId !== 'SIM-005');
  const service = { ...planned.seed, role: 'CORNER_JUDGE', source: 'MANUAL' };
  const append = (revision, confirmedCompleted = true) => request('/api/judge-management/experience', 'POST', {
    revision, associationId: 'SIM-005', confirmedCompleted, records: [service]
  });
  assert.equal((await append(initial.revision, false)).status, 400, 'reviewing the plan does not attest completion');
  response = await append(initial.revision);
  assert.equal(response.status, 200);
  let actualState = response.data;
  const entry = actualState.experience.find((record) => record.eventId === review.event.eventId);
  const replacement = initial.judges.find((judge) => judge.associationId === 'SIM-005');
  assert.equal(entry.judgeId, replacement.id, 'credit goes to actual replacement, not planned official');
  assert.equal(entry.logVerified, 0);
  assert.equal(actualState.experience.length, initial.experience.length + 1, 'other planned officials gain no records');
  assert.deepEqual(actualState.judges, initial.judges, 'review never awards certification');
  assert.equal(actualState.eligibility.find((row) => row.judgeId === replacement.id).experienceCount,
    initial.eligibility.find((row) => row.judgeId === replacement.id).experienceCount, 'pending service gives no additional credit');
  assert.equal((await append(initial.revision)).status, 409);
  response = await append(actualState.revision);
  assert.equal(response.data.duplicates, 1);
  actualState = response.data;
  review = buildReview(state.config, plan, actualState);
  assert.equal(review.actual.length, 1);
  assert.equal(review.rows.find((row) => row.associationId === planned.associationId && row.phase === planned.phase &&
    row.role === planned.role).matching.length, 0);
  response = await request('/api/judge-management/experience-verify', 'POST', {
    revision: actualState.revision, associationId: 'SIM-005', ids: [entry.id], verified: true
  });
  assert.equal(response.status, 200);
  actualState = response.data;
  assert.equal(actualState.eligibility.find((row) => row.judgeId === replacement.id).experienceCount,
    initial.eligibility.find((row) => row.judgeId === replacement.id).experienceCount + 1);
  assert.equal((await request(`/api/judge-management/experience/${entry.id}`, 'PUT', {
    revision: actualState.revision, confirmedRoleAdjustment: true, record: { role: 'TIMEKEEPER' }
  })).status, 409);
  response = await request('/api/judge-management/experience-verify', 'POST', {
    revision: actualState.revision, associationId: 'SIM-005', ids: [entry.id], verified: false
  });
  assert.equal(response.status, 200);
  actualState = response.data;
  response = await request(`/api/judge-management/experience/${entry.id}`, 'PUT', {
    revision: actualState.revision, confirmedRoleAdjustment: true, record: { role: 'TIMEKEEPER' }
  });
  assert.equal(response.status, 200);
  actualState = response.data;
  const adjusted = actualState.experience.find((row) => row.id === entry.id);
  assert.equal(adjusted.logVerified, 0, 'credited-role adjustment remains pending verification');
  assert.equal(adjusted.judgeId, replacement.id, 'credit adjustment does not reassign the judge');
  assert.equal(adjusted.phase, service.phase, 'credit adjustment preserves the phase');
  assert.equal(buildReview(state.config, plan, actualState).actual[0].role, 'TIMEKEEPER');
  response = await request(`/api/judge-management/experience/${entry.id}`, 'DELETE', {
    revision: actualState.revision, confirmedWithdrawal: true
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.experience, initial.experience, 'withdrawal restores actual service history');
  assert.deepEqual((await request(planUrl)).data.phases, plan.phases, 'actual service never rewrites planned assignments');
});

test('simulation participation rejects invalid, stale and concurrent writes atomically, supports explicit missing-DOB age', async (t) => {
  const directory = await setup(t);
  const { request } = await start(t, directory);
  const event = { name: 'Isolated', date: '2040-01-15', scope: 'regional', tournamentDays: 1, ringCount: 8 };
  for (const overrides of [{ name: '..' }, { name: 'CON' }, { name: 'escape\\event' }, { date: '2040-02-30' },
    { scope: '' }, { ringCount: 12 }, { tournamentDays: 3 }]) {
    assert.equal((await request('/api/simulation/events', 'POST', { ...event, ...overrides })).status, 400);
  }
  assert.equal((await request('/api/simulation/events', 'POST', event)).status, 200);
  assert.equal((await request('/api/simulation/events', 'POST', event)).status, 409);
  const url = '/api/simulation/participation?eventName=Isolated';
  let state = (await request(url)).data;
  const body = (members) => ({ revision: state.revision, judgeRevision: state.judgeRevision, members });
  const member = { associationId: 'SIM-003', volunteer: true, competitor: true };
  for (const members of [[], [member, member], [{ ...member, associationId: 3 }], [{ ...member, associationId: 'MISSING' }],
    [{ ...member, volunteer: false, competitor: false }]]) assert.equal((await request(url, 'POST', body(members))).status, 400);
  assert.equal((await request(url, 'POST', { ...body([member]), dob: '2000-01-01' })).status, 400);
  assert.deepEqual((await request(url)).data, state);
  const concurrent = await Promise.all([request(url, 'POST', body([member])), request(url, 'POST', body([member]))]);
  assert.deepEqual(concurrent.map((row) => row.status).sort(), [200, 409]);
  assert.equal((await request(url)).data.volunteers.length, 1);
  state = (await request(url)).data;
  const directoryState = (await request('/api/judge-management')).data;
  const added = await request('/api/judge-management', 'POST', { revision: directoryState.revision,
    judge: { associationId: 'SIM-MISSING-DOB', firstName: 'No', lastName: 'Birthdate', school: 'Simulation School 1',
      rank: 'D1', certification: 'UNKNOWN', status: 'Active', notes: 'Fabricated missing-DOB exercise' } });
  assert.equal(added.status, 200);
  assert.equal((await request(url, 'POST', body([{ ...member, associationId: 'SIM-004' }]))).status, 409);
  state = (await request(url)).data;
  const missing = { associationId: 'SIM-MISSING-DOB', volunteer: true, competitor: true };
  assert.equal(state.judges.find((row) => row.associationId === missing.associationId).age, null);
  assert.equal((await request(url, 'POST', body([missing]))).status, 400);
  assert.equal((await request(url, 'POST', body([{ ...missing, age: 30 }]))).status, 200);
  state = (await request(url)).data;
  assert.equal(state.competitors.find((row) => row.associationId === missing.associationId).age, 30);
  const beforeConflict = state;
  const directoryAfterAdd = (await request('/api/judge-management')).data;
  const changedJudge = directoryAfterAdd.judges.find((row) => row.associationId === 'SIM-003');
  assert.equal((await request(`/api/judge-management/${changedJudge.id}`, 'PUT', {
    revision: directoryAfterAdd.revision, judge: { ...changedJudge, firstName: 'Changed' }
  })).status, 200);
  state = (await request(url)).data;
  const conflict = await request(url, 'POST', body([{ ...member, associationId: 'SIM-005' }, member]));
  assert.equal(conflict.status, 409);
  const afterConflict = (await request(url)).data;
  assert.deepEqual(afterConflict.volunteers, beforeConflict.volunteers, 'first insertion rolls back when later identity conflicts');
  assert.deepEqual(afterConflict.competitors, beforeConflict.competitors);
  assert.equal(afterConflict.revision, beforeConflict.revision);
  for (const endpoint of ['/api/simulation/participation?eventName=..', '/api/simulation/participation?eventName=escape%5Cevent']) {
    assert.equal((await request(endpoint)).status, 400);
  }
  assert.equal((await request('/api/simulation/participation?eventName=unknown')).status, 404);
  assert.equal((await request(url, 'POST', body([member]), { Origin: 'https://other.example' })).status, 403);
});

test('candidates introduced between events retain history through repeated service, duplicate retries and recertification', async (t) => {
  const directory = await setup(t);
  const { request } = await start(t, directory);
  const before = (await request('/api/judge-management')).data;
  const advance = async (previousDate, date) => {
    assert.equal((await request('/api/simulation', 'PUT', { previousDate, date })).status, 200);
  };
  await advance('2040-01-15', '2040-02-15');
  let result = await request('/api/judge-management-import', 'POST', { revision: before.revision,
    csv: 'idNumber,firstName,lastName,rank,level,DOB\nSIM-LATE,Late,Candidate,D1,Uncertified,2010-01-01\n' });
  assert.equal(result.status, 200);
  assert.equal(result.data.added, 1);
  assert.equal(result.data.judges.length, 12);
  assert.deepEqual(result.data.judges.filter((row) => row.associationId !== 'SIM-LATE'), before.judges);
  assert.deepEqual(result.data.tests, before.tests);
  assert.deepEqual(result.data.experience, before.experience);
  const profile = async () => {
    const response = await request('/api/judge-management/profile?associationId=SIM-LATE');
    assert.equal(response.status, 200);
    return response.data;
  };
  let state = await profile();
  const id = state.judge.id;
  const tests = [];
  const attempt = async (record) => {
    tests.push(record);
    const response = await request(`/api/judge-management/${id}`, 'PUT', {
      revision: state.revision, judge: state.judge, tests
    });
    assert.equal(response.status, 200);
    state = await profile();
    assert.equal(state.tests.length, tests.length);
  };
  const award = () => request(`/api/judge-management/${id}/award`, 'POST', {
    revision: state.revision, grantedAt: state.asOf
  });
  await attempt({ targetLevel: 'SK_TK', writtenDate: '2040-02-15', writtenScore: 79 });
  assert.equal((await award()).status, 409);
  await attempt({ targetLevel: 'SK_TK', writtenDate: '2040-02-15', writtenScore: 80 });
  assert.equal((await award()).status, 200);
  state = await profile();
  assert.equal(state.judge.certification, 'SK_TK');
  const service = { eventId: 'late-first', eventName: 'Late Candidate First Championship',
    eventDate: '2040-03-01', location: 'Fabricated venue', eventScope: 'REGIONAL',
    phase: 'P1', role: 'SCOREKEEPER', source: 'MANUAL' };
  const append = (records) => request('/api/judge-management/experience', 'POST', {
    associationId: 'SIM-LATE', revision: state.revision, confirmedCompleted: true, records
  });
  assert.equal((await append([service])).status, 400, 'future service must not be manufactured');
  await advance('2040-02-15', '2040-03-15');
  state = await profile();
  const records = [service, { ...service, phase: 'P2', role: 'TIMEKEEPER' }];
  const concurrent = await Promise.all([append(records), append(records)]);
  assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 409]);
  state = await profile();
  assert.equal(state.experience.length, 2);
  assert.equal(state.eligibility.experienceCount, 0);
  result = await append(records);
  assert.equal(result.status, 200);
  assert.equal(result.data.added, 0);
  assert.equal(result.data.duplicates, 2);
  state = await profile();
  const verify = async (ids) => {
    const response = await request('/api/judge-management/experience-verify', 'POST', {
      associationId: 'SIM-LATE', revision: state.revision, ids, verified: true
    });
    assert.equal(response.status, 200);
    state = await profile();
  };
  await verify(state.experience.map((row) => row.id));
  assert.equal(state.eligibility.experienceCount, 1, 'separate phases/roles earn one championship');
  await attempt({ targetLevel: 'CORNER', writtenDate: '2040-03-14', writtenScore: 80,
    practicalDate: '2040-03-14', practicalPassed: true });
  assert.equal((await award()).status, 200);
  state = await profile();
  assert.equal(state.judge.certification, 'CORNER');
  assert.equal(state.judge.expiration, '2045-03-15');
  assert.equal(state.eligibility.experienceCount, 0, 'old SK/TK service is not new Corner experience');
  await advance('2040-03-15', '2040-05-15');
  state = await profile();
  const next = { ...service, eventId: 'late-second', eventName: 'Late Candidate Second Championship',
    eventDate: '2040-04-01', role: 'CORNER_JUDGE' };
  result = await append([next, { ...next, phase: 'P2' }]);
  assert.equal(result.status, 200);
  state = await profile();
  await verify(state.experience.filter((row) => row.eventId === next.eventId).map((row) => row.id));
  assert.equal(state.eligibility.experienceCount, 1);
  result = await append([{ ...next, eventId: 'late-third', eventName: 'Late Candidate Third Championship', eventDate: '2040-05-01' }]);
  assert.equal(result.status, 200);
  state = await profile();
  await verify(state.experience.filter((row) => row.eventId === 'late-third').map((row) => row.id));
  assert.equal(state.eligibility.experienceCount, 2);
  assert.equal(state.eligibility.eligible, true);
  assert.equal(state.eligibility.writtenPassed, false);
  assert.equal((await award()).status, 409, 'repeated events alone do not promote');
  const retainedExperience = state.experience;
  await advance('2040-05-15', '2045-03-15');
  state = await profile();
  assert.equal(state.eligibility.recertifying, false, 'certificate remains current on expiration date');
  await advance('2045-03-15', '2045-03-16');
  state = await profile();
  assert.equal(state.judge.certification, 'CORNER', 'expiry must not erase the awarded level');
  assert.equal(state.eligibility.recertifying, true);
  assert.equal(state.eligibility.targetLevel, 'CORNER', 'recertification does not advance to Regional');
  assert.equal(state.eligibility.writtenPassed, false, 'pre-Corner tests cannot renew the Corner cycle');
  assert.equal(state.eligibility.practicalPassed, false);
  assert.equal((await award()).status, 409);
  await attempt({ targetLevel: 'CORNER', writtenDate: '2045-03-16', writtenScore: 79,
    practicalDate: '2045-03-16', practicalPassed: false });
  assert.equal((await award()).status, 409);
  await attempt({ targetLevel: 'CORNER', writtenDate: '2045-03-16', writtenScore: 80,
    practicalDate: '2045-03-16', practicalPassed: true });
  assert.equal((await award()).status, 200);
  state = await profile();
  assert.equal(state.judge.certification, 'CORNER');
  assert.equal(state.judge.expiration, '2050-03-16');
  assert.deepEqual(state.experience, retainedExperience);
  const restarted = await start(t, directory);
  const persisted = (await restarted.request('/api/judge-management/profile?associationId=SIM-LATE')).data;
  assert.deepEqual(persisted, state);
  const preserved = (await restarted.request('/api/judge-management')).data;
  assert.equal(preserved.judges.length, 12);
  assert.deepEqual(preserved.judges.filter((row) => row.associationId !== 'SIM-LATE'), before.judges);
});
