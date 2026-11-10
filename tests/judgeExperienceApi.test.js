const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { initializeJudgeDatabase } = require('../db/judgeManagement');
const { createJudgeManagementRouter } = require('../backend/judgeManagementRoutes');
const { createSimulationApp, initializeSimulation } = require('../backend/judgeSimulation');
const { regionalDataset, setupExperience } = require('../backend/judgeSimulationData');
const { apiRoles } = require('../backend/browserPermissions');

async function setup(t, simulation = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-experience-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'data');
  let app;
  if (simulation) {
    await initializeSimulation(directory, '2026-01-15');
    app = createSimulationApp(directory);
  } else {
    fs.mkdirSync(directory);
    const file = path.join(directory, 'judges.db');
    await initializeJudgeDatabase(file);
    app = express(); app.use(express.json()); app.use('/api', createJudgeManagementRouter({ file }));
  }
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (endpoint, method = 'GET', body) => {
    const response = await fetch(base + '/api/judge-management' + endpoint, { method,
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const profile = async (id) => {
    const result = await request(`/profile?associationId=${encodeURIComponent(id)}`);
    assert.equal(result.status, 200);
    return result.data;
  };
  return { base, request, profile };
}
const record = (overrides = {}) => ({ eventId: 'championship-1', eventName: 'Regional Championship One',
  eventDate: '2026-01-10', location: 'Venue', role: 'CORNER_JUDGE', eventScope: 'REGIONAL',
  phase: 'P1', source: 'TOURNAMENT', sourceId: 'service-1', ...overrides });

test('200-judge CSV imports by headers and experience setup preserves identities and histories on rerun', async (t) => {
  const { base, request, profile } = await setup(t);
  const dataset = regionalDataset('2026-01-15');
  assert.equal(dataset.judges.length, 200);
  assert.equal(new Set(dataset.judges.map((j) => j.associationId)).size, 200);
  const counts = Object.fromEntries(['INTERNATIONAL', 'REGIONAL', 'CORNER', 'SK_TK', 'UNCERTIFIED']
    .map((level) => [level, dataset.judges.filter((j) => j.certification === level).length]));
  assert.deepEqual(counts, { INTERNATIONAL: 8, REGIONAL: 32, CORNER: 100, SK_TK: 48, UNCERTIFIED: 12 });
  assert.equal(fs.readFileSync(path.join(__dirname, '..', 'test-data', 'judge-simulation', 'regional-judges-200.csv'), 'utf8'), dataset.csv);
  let state = (await request('')).data;
  let response = await request('-import', 'POST', { revision: state.revision, csv: dataset.csv });
  assert.equal(response.status, 200);
  assert.equal(response.data.added, 200);
  const ids = dataset.judges.map((j) => j.associationId);
  const result = await setupExperience(base, ids);
  assert.ok(result.added > 200);
  assert.equal(result.duplicates, 0);
  const before = await profile('sim-r-041');
  assert.equal(before.judge.associationId, 'SIM-R-041');
  assert.equal(Object.hasOwn(before.judge, 'dateOfBirth'), false);
  assert.equal(before.experience.length, 1);
  assert.equal(before.experience[0].logVerified, 0);
  assert.equal(before.eligibility.experienceCount, 0);
  const rerun = await setupExperience(base, ids);
  assert.equal(rerun.added, 0);
  assert.equal(rerun.duplicates, result.added);
  const clockResponse = await fetch(base + '/api/simulation', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ previousDate: '2026-01-15', date: '2026-02-15' }) });
  assert.equal(clockResponse.status, 200);
  const afterAdvance = await setupExperience(base, ['SIM-R-041']);
  assert.deepEqual(afterAdvance, { added: 0, duplicates: 1 });
  state = (await request('')).data;
  response = await request('-import', 'POST', { revision: state.revision, csv: dataset.csv });
  assert.equal(response.status, 200);
  assert.equal(response.data.updated, 200);
  assert.deepEqual((await profile('SIM-R-041')).experience, before.experience);
  await assert.rejects(setupExperience('https://example.com', ids), /local isolated/);
});

test('shared append API deduplicates service, counts phases once and supports verification, tests and coordinator promotion', async (t) => {
  const { request, profile } = await setup(t);
  const id = 'SIM-005';
  let state = await profile(id);
  const append = (records, revision = state.revision) => request('/experience', 'POST', { associationId: id, revision, records });
  let response = await append([record(), record({ phase: 'P2', sourceId: 'service-2' })]);
  assert.equal(response.status, 200);
  assert.equal(response.data.added, 2);
  state = await profile(id);
  assert.equal(state.experience.length, 3);
  assert.equal(state.eligibility.experienceCount, 1);
  response = await append([record(), record({ phase: 'P2', sourceId: 'service-2' })]);
  assert.equal(response.status, 200);
  assert.equal(response.data.duplicates, 2);
  state = await profile(id);
  response = await append([record({ location: 'Conflicting venue' })]);
  assert.equal(response.status, 409);
  response = await append([record({ eventId: 'duplicate-event-id', sourceId: 'new-source' })]);
  assert.equal(response.status, 409);
  const ids = state.experience.filter((row) => row.sourceId).map((row) => row.id);
  response = await request('/experience-verify', 'POST', { associationId: id, revision: state.revision, ids, verified: true });
  assert.equal(response.status, 200);
  state = await profile(id);
  assert.equal(state.eligibility.experienceCount, 2);
  assert.equal(state.eligibility.eligible, true);
  assert.equal(state.eligibility.writtenPassed, false);
  response = await request(`/${state.judge.id}/award`, 'POST', { revision: state.revision, grantedAt: state.asOf });
  assert.equal(response.status, 409);
  response = await request(`/${state.judge.id}`, 'PUT', { revision: state.revision, judge: state.judge,
    tests: [{ targetLevel: 'REGIONAL', writtenDate: '2026-01-15', writtenScore: 80, practicalDate: '2026-01-15', practicalPassed: true }],
    experience: state.experience.map((row) => ({ ...row, logVerified: Boolean(row.logVerified) })) });
  assert.equal(response.status, 200);
  state = await profile(id);
  assert.equal(state.experience.filter((row) => row.sourceId).length, 2);
  assert.equal(state.eligibility.writtenPassed, true);
  const tampered = state.experience.map((row) => ({ ...row, logVerified: Boolean(row.logVerified),
    ...(row.sourceId ? { location: 'Tampered venue' } : {}) }));
  response = await request(`/${state.judge.id}`, 'PUT', {
    revision: state.revision, judge: state.judge, experience: tampered
  });
  assert.equal(response.status, 409);
  assert.deepEqual((await profile(id)).experience, state.experience);
  response = await request(`/${state.judge.id}/award`, 'POST', { revision: state.revision, grantedAt: state.asOf });
  assert.equal(response.status, 200);
  state = await profile(id);
  assert.equal(state.judge.certification, 'REGIONAL');
  assert.equal(state.judge.expiration, '2031-01-15');
  assert.equal(state.experience.length, 3);
});

test('role details and phases do not inflate championship credit; invalid writes are atomic and authorized routes are classified', async (t) => {
  const { request, profile } = await setup(t);
  let state = await profile('SIM-003');
  const records = [record({ role: 'SCOREKEEPER' }), record({ role: 'TIMEKEEPER', sourceId: 'service-2', phase: 'P2' })];
  let response = await request('/experience', 'POST', { associationId: state.judge.associationId, revision: state.revision, records });
  assert.equal(response.status, 200);
  state = await profile('SIM-003');
  response = await request('/experience-verify', 'POST', { associationId: 'SIM-003', revision: state.revision,
    ids: state.experience.map((r) => r.id), verified: true });
  assert.equal(response.status, 200);
  state = await profile('SIM-003');
  assert.equal(state.eligibility.experienceCount, 1);
  response = await request('/experience', 'POST', { associationId: 'SIM-003', revision: state.revision,
    records: [record({ eventId: 'second', eventName: 'Second Event', sourceId: 'valid' }), record({ sourceId: 'invalid', eventDate: '2026-01-16' })] });
  assert.equal(response.status, 400);
  assert.deepEqual((await profile('SIM-003')).experience, state.experience);
  response = await request('/experience', 'POST', { associationId: 'SIM-003', revision: state.revision,
    records: [record({ logVerified: true })] });
  assert.equal(response.status, 400);
  response = await request('/experience', 'POST', { associationId: 'SIM-003', revision: -1, records });
  assert.equal(response.status, 409);
  response = await request('/experience-verify', 'POST', { associationId: 'SIM-003', revision: state.revision, ids: [999999], verified: true });
  assert.equal(response.status, 409);
  assert.equal((await request('/profile?associationId=missing')).status, 404);
  const corner = await profile('SIM-011');
  response = await request('/experience', 'POST', { associationId: 'SIM-011', revision: corner.revision,
    records: [record({ eventId: 'wrong-role', eventName: 'Wrong Role Event', role: 'SCOREKEEPER', sourceId: 'wrong-role' })] });
  assert.equal(response.status, 200);
  const service = response.data.experience.find((row) => row.sourceId === 'wrong-role');
  response = await request('/experience-verify', 'POST', { associationId: 'SIM-011', revision: response.data.revision, ids: [service.id], verified: true });
  assert.equal(response.status, 200);
  assert.equal((await profile('SIM-011')).eligibility.experienceCount, 0);
  for (const [method, suffix] of [['GET', '/profile'], ['POST', '/experience'], ['POST', '/experience-verify']]) {
    assert.deepEqual(apiRoles(method, '/api/judge-management' + suffix), ['administrator', 'judging-coordinator']);
  }
});

test('normal management uses real dates, rejects simulation submissions and accepts the same completed-service format', async (t) => {
  const { request } = await setup(t, false);
  let state = (await request('')).data;
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(state.asOf, today);
  let response = await request('', 'POST', { revision: state.revision,
    judge: { associationId: 'MEMBER1', firstName: 'Actual', lastName: 'Flow', rank: 'D1', certification: 'CORNER' } });
  assert.equal(response.status, 200); state = response.data;
  response = await request('/experience', 'POST', { associationId: 'MEMBER1', revision: state.revision,
    records: [record({ source: 'SIMULATION' })] });
  assert.equal(response.status, 400);
  response = await request('/experience', 'POST', { associationId: 'MEMBER1', revision: state.revision,
    records: [record({ eventDate: today })] });
  assert.equal(response.status, 200);
  assert.equal(response.data.experience[0].logVerified, 0);
  state = response.data;
  assert.equal((await request(`/experience/${state.experience[0].id}`, 'DELETE', {
    revision: state.revision, confirmedWithdrawal: true })).status, 409);
  response = await request('/experience', 'POST', { associationId: 'MEMBER1', revision: state.revision,
    confirmedCompleted: true, records: [record({ source: 'MANUAL', eventDate: today, phase: 'P2', role: 'ARBITRATOR' })] });
  assert.equal(response.status, 200);
  assert.equal(response.data.experience.find((row) => row.source === 'MANUAL').logVerified, 0);
});

test('coordinator actual service supports phase details, corrections, withdrawal and normal progression through World service', async (t) => {
  const { base, request, profile } = await setup(t);
  let state = await profile('SIM-005');
  const append = (records) => request('/experience', 'POST', { associationId: 'SIM-005',
    revision: state.revision, confirmedCompleted: true, records });
  let result = await append([record({ source: 'MANUAL', sourceId: undefined }),
    record({ source: 'MANUAL', sourceId: undefined, phase: 'P2' })]);
  assert.equal(result.status, 200);
  state = await profile('SIM-005');
  const p1 = state.experience.find((row) => row.source === 'MANUAL' && row.phase === 'P1');
  const p2 = state.experience.find((row) => row.source === 'MANUAL' && row.phase === 'P2');
  assert.equal(p1.logVerified, 0);
  assert.equal(p2.logVerified, 0);
  assert.equal(state.eligibility.experienceCount, 1);
  result = await append([record({ source: 'MANUAL', sourceId: undefined })]);
  assert.equal(result.data.duplicates, 1);
  state = await profile('SIM-005');
  result = await request('/experience-verify', 'POST', { associationId: 'SIM-005',
    revision: state.revision, ids: [p1.id], verified: true });
  assert.equal(result.status, 200);
  state = await profile('SIM-005');
  assert.equal(state.eligibility.experienceCount, 2);
  result = await request(`/experience/${p1.id}`, 'PUT', { associationId: 'SIM-011', revision: state.revision,
    confirmedCompleted: true, record: { location: 'Replacement served', role: 'CORNER_JUDGE', phase: 'P1' } });
  assert.equal(result.status, 200);
  assert.equal(result.data.experience.find((row) => row.id === p1.id).logVerified, 0);
  state = await profile('SIM-005');
  assert.equal(state.eligibility.experienceCount, 1);
  result = await request(`/experience/${p1.id}`, 'DELETE', { revision: state.revision, confirmedWithdrawal: true });
  assert.equal(result.status, 200);
  assert.equal((await profile('SIM-011')).experience.some((row) => row.id === p1.id), false);
  state = await profile('SIM-005');
  result = await request('/experience-verify', 'POST', { associationId: 'SIM-005',
    revision: state.revision, ids: [p2.id], verified: true });
  assert.equal(result.status, 200);
  state = await profile('SIM-005');
  assert.equal(state.eligibility.experienceCount, 2);
  assert.equal(state.eligibility.eligible, true);
  assert.equal((await request(`/${state.judge.id}/award`, 'POST', {
    revision: state.revision, grantedAt: state.asOf })).status, 409);
  const passTests = async (targetLevel) => {
    const response = await request(`/${state.judge.id}`, 'PUT', { revision: state.revision, judge: state.judge,
      tests: [{ targetLevel, writtenDate: state.asOf, writtenScore: 80, practicalDate: state.asOf, practicalPassed: true }] });
    assert.equal(response.status, 200);
    state = await profile('SIM-005');
  };
  await passTests('REGIONAL');
  result = await request(`/${state.judge.id}/award`, 'POST', { revision: state.revision, grantedAt: state.asOf });
  assert.equal(result.status, 200);
  state = await profile('SIM-005');
  assert.equal(state.judge.certification, 'REGIONAL');
  const clock = await fetch(base + '/api/simulation', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ previousDate: '2026-01-15', date: '2026-02-15' }) });
  assert.equal(clock.status, 200);
  state = await profile('SIM-005');
  assert.equal(state.eligibility.experienceCount, 0);
  result = await append([record({ source: 'MANUAL', eventId: 'regional-center', eventName: 'Regional Center Service',
    eventDate: '2026-02-01', role: 'CENTER_JUDGE' })]);
  assert.equal(result.status, 200);
  state = await profile('SIM-005');
  const center = state.experience.find((row) => row.eventId === 'regional-center');
  result = await request('/experience-verify', 'POST', { associationId: 'SIM-005',
    revision: state.revision, ids: [center.id], verified: true });
  assert.equal(result.status, 200);
  state = await profile('SIM-005');
  assert.match(state.eligibility.reason, /World Championship/);
  result = await append([record({ source: 'MANUAL', eventId: 'world-service', eventName: 'World Service',
    eventDate: '2026-02-10', role: 'CORNER_JUDGE', eventScope: 'WORLD', phase: 'P2' })]);
  assert.equal(result.status, 200);
  state = await profile('SIM-005');
  const world = state.experience.find((row) => row.eventId === 'world-service');
  result = await request('/experience-verify', 'POST', { associationId: 'SIM-005',
    revision: state.revision, ids: [world.id], verified: true });
  assert.equal(result.status, 200);
  state = await profile('SIM-005');
  assert.equal(state.eligibility.eligible, true);
  await passTests('INTERNATIONAL');
  result = await request(`/${state.judge.id}/award`, 'POST', { revision: state.revision, grantedAt: state.asOf });
  assert.equal(result.status, 200);
  assert.equal((await profile('SIM-005')).judge.certification, 'INTERNATIONAL');
});

test('coordinator service requires attestation and valid identity; stale, conflicting and nonmanual changes are rejected', async (t) => {
  const { request, profile } = await setup(t);
  let state = await profile('SIM-003');
  const manual = record({ source: 'MANUAL', sourceId: undefined, role: 'SCOREKEEPER' });
  const append = (overrides = {}) => request('/experience', 'POST', { associationId: 'SIM-003',
    revision: state.revision, records: [manual], confirmedCompleted: true, ...overrides });
  assert.equal((await append({ confirmedCompleted: false })).status, 400);
  for (const change of [{ phase: '' }, { eventId: 3 }, { eventDate: '2026-01-16' }, { logVerified: true }]) {
    assert.equal((await append({ records: [{ ...manual, ...change }] })).status, 400);
  }
  assert.equal((await append({ associationId: 'missing' })).status, 404);
  assert.equal((await append({ records: [manual, { ...manual, phase: 'BAD' }] })).status, 400);
  assert.equal((await profile('SIM-003')).experience.length, 0);
  let result = await append();
  assert.equal(result.status, 200);
  assert.equal((await append()).status, 409);
  state = await profile('SIM-003');
  const id = state.experience[0].id;
  assert.equal((await append({ records: [{ ...manual, eventName: 'Different name' }] })).status, 409);
  const correction = (overrides = {}) => request(`/experience/${id}`, 'PUT', {
    associationId: 'SIM-003', revision: state.revision, confirmedCompleted: true,
    record: { location: 'Corrected', role: 'TIMEKEEPER', phase: 'P2' }, ...overrides });
  assert.equal((await correction({ confirmedCompleted: false })).status, 400);
  assert.equal((await correction({ revision: -1 })).status, 409);
  assert.equal((await request(`/experience/${id}`, 'DELETE', { revision: -1, confirmedWithdrawal: true })).status, 409);
  assert.equal((await correction({ record: { ...manual, eventId: 'another-event' } })).status, 400);
  assert.equal((await correction({ associationId: 'missing' })).status, 404);
  result = await append({ records: [{ ...manual, phase: 'P2', role: 'TIMEKEEPER' }] });
  assert.equal(result.status, 200);
  state = await profile('SIM-003');
  assert.equal((await correction()).status, 409);
  assert.equal((await request(`/experience/${id}`, 'DELETE', { revision: state.revision })).status, 400);
  result = await request('/experience-verify', 'POST', { revision: state.revision, associationId: 'SIM-003',
    ids: state.experience.map((row) => row.id), verified: true });
  assert.equal(result.status, 200);
  state = await profile('SIM-003');
  assert.equal(state.eligibility.experienceCount, 1);
  for (const row of state.experience) {
    result = await request(`/experience/${row.id}`, 'DELETE', { revision: state.revision, confirmedWithdrawal: true });
    assert.equal(result.status, 200);
    state = await profile('SIM-003');
  }
  assert.equal(state.eligibility.experienceCount, 0);
  const legacy = await profile('SIM-005');
  const legacyId = legacy.experience[0].id;
  for (const method of ['PUT', 'DELETE']) {
    assert.equal((await request(`/experience/${legacyId}`, method, { revision: legacy.revision })).status, 409);
    assert.deepEqual(apiRoles(method, `/api/judge-management/experience/${legacyId}`), ['administrator', 'judging-coordinator']);
  }
  state = await profile('SIM-003');
  result = await append({ records: [{ ...manual, eventId: 'in-house', eventName: 'In House Service', eventScope: 'IN_HOUSE', role: 'ARBITRATOR' }] });
  assert.equal(result.status, 200);
  const inHouse = result.data.experience.find((row) => row.eventId === 'in-house');
  result = await request('/experience-verify', 'POST', { associationId: 'SIM-003',
    revision: result.data.revision, ids: [inHouse.id], verified: true });
  assert.equal(result.status, 200);
  assert.equal((await profile('SIM-003')).eligibility.experienceCount, 0);
});
