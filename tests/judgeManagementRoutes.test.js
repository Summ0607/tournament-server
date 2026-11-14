const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { initializeJudgeDatabase } = require('../db/judgeManagement');
const { createJudgeManagementRouter, evaluateEligibility } = require('../backend/judgeManagementRoutes');

test('judge records, ID-based imports, CSV aliases and revision conflicts are safe', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-routes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'judges.db');
  await initializeJudgeDatabase(file);
  const app = express(); app.use(express.json()); app.use('/api', createJudgeManagementRouter({ file }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (endpoint, method = 'GET', body) => {
    const response = await fetch(base + endpoint, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  let state = (await request('/judge-management')).data;
  assert.equal(state.revision, 0);
  const judge = { associationId: 'ID1', firstName: 'John', lastName: 'Smith', school: 'Original', rank: 'D1',
    certification: 'CORNER', expiration: '2030-01-01', status: 'Active', notes: 'Keep' };
  let result = await request('/judge-management', 'POST', { revision: state.revision, judge });
  assert.equal(result.status, 200); state = result.data;
  result = await request('/judge-management', 'POST', { revision: state.revision, judge: { ...judge, associationId: 'id1' } });
  assert.equal(result.status, 409);
  result = await request('/judge-management', 'POST', { revision: 0, judge: { ...judge, associationId: 'ID2' } });
  assert.equal(result.status, 409);
  const csv = 'idNumber,firstName,lastName,studioName,rank,level,judgingLevelExpDate,status,DOB\nID1,John,Smith,New School,,,,,\nID2,John,Smith,,D1,Corner,12/31/2030,Active,2000-01-01\nID3,Third,Judge,,D1,Unknown,,Active,2000-01-01\n';
  result = await request('/judge-management-import', 'POST', { revision: state.revision, csv });
  assert.equal(result.status, 200); state = result.data;
  assert.equal(state.added, 2); assert.equal(state.updated, 1);
  assert.equal(state.judges.length, 3);
  assert.equal(state.judges.find((j) => j.associationId === 'ID1').school, 'New School');
  assert.equal(state.judges.find((j) => j.associationId === 'ID1').notes, 'Keep');
  assert.equal(state.judges.find((j) => j.associationId === 'ID1').expiration, '2030-01-01');
  assert.equal(state.judges.find((j) => j.associationId === 'ID2').expiration, '2030-12-31');
  const privateDobJudge = state.judges.find((j) => j.associationId === 'ID3');
  assert.equal(Object.hasOwn(privateDobJudge, 'dateOfBirth'), false);
  assert.equal(state.eligibility.find((item) => item.judgeId === privateDobJudge.id).eligible, true);
  result = await request('/judge-management-import', 'POST', { revision: state.revision,
    csv: 'idNumber,firstName,lastName\nID3,Good,Row\n,Bad,Row\n' });
  assert.equal(result.status, 400);
  assert.match(result.data.error, /CSV row 3.*Association ID/);
  assert.equal((await request('/judge-management')).data.judges.length, 3);
  result = await request('/judge-management-settings', 'PUT', { revision: state.revision,
    aliases: { ...state.aliases, associationId: [...state.aliases.associationId, 'member id'] } });
  assert.equal(result.status, 200); state = result.data;
  result = await request('/judge-management-import', 'POST', { revision: state.revision,
    csv: 'member id,firstName,lastName\nID4,Fourth,Judge\n' });
  assert.equal(result.status, 200); state = result.data;
  const target = state.judges.find((j) => j.associationId === 'ID4');
  result = await request(`/judge-management/${target.id}`, 'PUT', { revision: state.revision,
    judge: { ...target, firstName: 'Edited' } });
  assert.equal(result.status, 200); state = result.data;
  result = await request('/judge-management/delete', 'POST', { revision: state.revision, ids: [target.id] });
  assert.equal(result.status, 200); assert.equal(result.data.judges.length, 3);
  result = await request('/judge-management-import', 'POST', { revision: result.data.revision,
    csv: 'WTSDA Number,Given Name,Family Name,School Name,Belt Rank,Judging Certification Level,Judging Certification Expiration,Judge Status,Birth Date,JOT Form Submission ID\n' +
      'ID5,Alias,Judge,Alias School,D1,Corner,2030-12-31,Active,2000-01-01,FORM-005' });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.added, 1);
  const aliasJudge = result.data.judges.find((item) => item.associationId === 'ID5');
  assert.equal(aliasJudge.firstName, 'Alias');
  assert.equal(aliasJudge.school, 'Alias School');
  assert.equal(aliasJudge.certification, 'CORNER');
  assert.equal(aliasJudge.expiration, '2030-12-31');
});

test('DOB remains private; eligibility, tests, experience and coordinator awards follow the certification rules', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-eligibility-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'judges.db');
  await initializeJudgeDatabase(file);
  const app = express(); app.use(express.json()); app.use('/api', createJudgeManagementRouter({ file }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (endpoint, method = 'GET', body) => {
    const response = await fetch(base + endpoint, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const today = new Date().toISOString().slice(0, 10);
  let state = (await request('/judge-management')).data;
  let response = await request('/judge-management', 'POST', {
    revision: state.revision,
    judge: { associationId: 'AGE1', firstName: 'Alex', lastName: 'Judge', rank: 'D1',
      certification: 'UNKNOWN', dateOfBirth: '2000-01-01', status: 'Active' },
    tests: [], experience: []
  });
  assert.equal(response.status, 200);
  state = response.data;
  const judge = state.judges.find((item) => item.associationId === 'AGE1');
  assert.equal(Object.hasOwn(judge, 'dateOfBirth'), false);
  assert.equal(state.eligibility[0].targetLevel, 'SK_TK');
  assert.equal(state.eligibility[0].eligible, true);

  response = await request(`/judge-management/${judge.id}/award`, 'POST', { revision: state.revision, grantedAt: today });
  assert.equal(response.status, 409);

  response = await request(`/judge-management/${judge.id}`, 'PUT', {
    revision: state.revision, judge, tests: [{ targetLevel: 'SK_TK', writtenDate: today, writtenScore: 79 }], experience: []
  });
  assert.equal(response.status, 200);
  state = response.data;
  assert.equal(state.eligibility[0].writtenPassed, false);
  response = await request(`/judge-management/${judge.id}/award`, 'POST', { revision: state.revision, grantedAt: today });
  assert.equal(response.status, 409);

  response = await request(`/judge-management/${judge.id}`, 'PUT', {
    revision: state.revision, judge, tests: [{ targetLevel: 'SK_TK', writtenDate: today, writtenScore: 80 }], experience: []
  });
  assert.equal(response.status, 200);
  state = response.data;
  response = await request(`/judge-management/${judge.id}/award`, 'POST', { revision: state.revision, grantedAt: today });
  assert.equal(response.status, 200);
  state = response.data;
  assert.equal(state.judges[0].certification, 'SK_TK');
  assert.equal(state.judges[0].expiration, `${new Date(Date.UTC(new Date(today).getUTCFullYear() + 5, new Date(today).getUTCMonth(), new Date(today).getUTCDate())).toISOString().slice(0, 10)}`);

  const promotedJudge = state.judges.find((item) => item.id === judge.id);
  response = await request(`/judge-management/${judge.id}`, 'PUT', {
    revision: state.revision, judge: promotedJudge,
    tests: [{ targetLevel: 'CORNER', writtenDate: today, writtenScore: 80, practicalDate: today, practicalPassed: true }],
    experience: [{ eventName: 'Regional Championship', eventDate: today, location: 'Venue', role: 'JUDGE',
      eventScope: 'REGIONAL', logVerified: true }]
  });
  assert.equal(response.status, 200);
  state = response.data;
  assert.equal(state.eligibility[0].targetLevel, 'CORNER');
  assert.equal(state.eligibility[0].eligible, true);
  assert.equal(state.eligibility[0].writtenPassed, true);
  assert.equal(state.eligibility[0].practicalPassed, true);
  response = await request(`/judge-management/${judge.id}/award`, 'POST', { revision: state.revision, grantedAt: today });
  assert.equal(response.status, 200);
  state = response.data;
  assert.equal(state.judges[0].certification, 'CORNER');
  assert.equal(state.experience.length, 1);
  assert.equal(state.tests.length, 1);

  response = await request(`/judge-management/${judge.id}`, 'PUT', {
    revision: state.revision, judge: state.judges[0], tests: [{ targetLevel: 'CORNER', writtenDate: today, writtenScore: 80 }],
    experience: []
  });
  assert.equal(response.status, 200);
  state = response.data;
  assert.equal(Object.hasOwn(state.judges[0], 'dateOfBirth'), false);
  assert.equal(state.eligibility[0].practicalPassed, false);
  response = await request('/judge-management/delete', 'POST', { revision: state.revision, ids: [judge.id] });
  assert.equal(response.status, 200);
  assert.equal(response.data.tests.length, 0);
  assert.equal(response.data.experience.length, 0);
});

test('age eligibility uses stored DOB and the CDB 14-year threshold without exposing birth dates', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-age-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'judges.db');
  await initializeJudgeDatabase(file);
  const app = express(); app.use(express.json()); app.use('/api', createJudgeManagementRouter({ file }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (endpoint, method = 'GET', body) => {
    const response = await fetch(base + endpoint, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const today = new Date();
  const birthDateForAge = (age) => `${today.getUTCFullYear() - age}-01-01`;
  let state = (await request('/judge-management')).data;
  const result = await request('/judge-management-import', 'POST', { revision: state.revision,
    csv: `idNumber,firstName,lastName,rank,level,DOB\nCDB14,Fourteen,Judge,CDB,Unknown,${birthDateForAge(14)}\nCDB13,Thirteen,Judge,CDB,Unknown,${birthDateForAge(13)}` });
  assert.equal(result.status, 200);
  state = result.data;
  const fourteen = state.judges.find((judge) => judge.associationId === 'CDB14');
  const thirteen = state.judges.find((judge) => judge.associationId === 'CDB13');
  assert.equal(state.eligibility.find((item) => item.judgeId === fourteen.id).eligible, true);
  assert.equal(state.eligibility.find((item) => item.judgeId === thirteen.id).eligible, false);
  assert.match(state.eligibility.find((item) => item.judgeId === thirteen.id).reason, /age 14 or older/);
  assert.ok(state.judges.every((judge) => !Object.hasOwn(judge, 'dateOfBirth')));
});

test('effective-date eligibility evaluates written/practical attempts independently and excludes future service', () => {
  const judge = { id: 1, certification: 'CORNER', rank: 'D2', expiration: '2030-01-01', grantedAt: '2025-01-01' };
  const tests = [{ judgeId: 1, targetLevel: 'REGIONAL', writtenDate: '2026-01-10', writtenScore: 80,
    practicalDate: '2026-01-15', practicalPassed: 1 }];
  const experience = ['2026-01-09', '2026-01-14'].map((eventDate, index) => ({
    judgeId: 1, eventId: `event-${index}`, eventDate, role: 'CORNER_JUDGE', eventScope: 'REGIONAL', logVerified: 1
  }));
  let result = evaluateEligibility(judge, tests, experience, '2026-01-10');
  assert.equal(result.experienceCount, 1);
  assert.equal(result.eligible, false);
  assert.equal(result.writtenPassed, true, 'later practical date must not hide an already-passed written test');
  assert.equal(result.practicalPassed, false);
  result = evaluateEligibility(judge, tests, experience, '2026-01-14');
  assert.equal(result.eligible, true);
  assert.equal(result.practicalPassed, false);
  result = evaluateEligibility(judge, tests, experience, '2026-01-15');
  assert.equal(result.eligible, true);
  assert.equal(result.writtenPassed, true);
  assert.equal(result.practicalPassed, true);
  const reversed = [{ ...tests[0], writtenDate: '2026-01-16', practicalDate: '2026-01-10' }];
  result = evaluateEligibility(judge, reversed, experience, '2026-01-15');
  assert.equal(result.writtenPassed, false);
  assert.equal(result.practicalPassed, true);
  const arbitrator = { judgeId: 1, eventId: 'arbitrator-service', eventDate: '2026-01-15',
    role: 'ARBITRATOR', eventScope: 'REGIONAL', logVerified: 1 };
  result = evaluateEligibility(judge, tests, [arbitrator], '2026-01-15');
  assert.equal(result.experienceCount, 0);
});
