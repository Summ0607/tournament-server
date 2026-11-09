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

test('simulation exposes only management UI and isolated APIs, rejecting other origins and live paths', async (t) => {
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
  for (const endpoint of ['/judges.db', '/simulation.json', '/api/events', '/api/ring-judges', '/api/simulation-results']) {
    assert.equal((await request(endpoint)).status, 404, endpoint);
  }
  const html = await (await fetch(base)).text();
  assert.match(html, /FABRICATED DATA ONLY/);
  const template = await (await fetch(base + '/management-template')).text();
  assert.match(template, /id="judgeManagementView"/);
  for (const asset of ['/judge-simulation.js', '/judge-management.js']) {
    assert.equal((await fetch(base + asset)).status, 200);
  }
  const before = readSimulation(directory);
  const response = await request('/api/simulation', 'PUT', { previousDate: before.date, date: '2040-02-30' });
  assert.equal(response.status, 400);
  assert.deepEqual(readSimulation(directory), before);
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
