const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const sqlite3 = require('sqlite3');
const express = require('express');
const { createRingJudgeRouter, validateJudge } = require('../backend/ringJudgeRoutes');
const { certificationLevels, judgeRankOptions } = require('../db/judgeCertification');
const { create } = require('../tournament-management/ring-judges');
const judge = { name: 'Judge One', associationNumber: 'D100', school: 'School', rank: 'D1',
  certification: '', flaggedForReview: false, reviewNotes: '' };
test('judge validation preserves optional certification and review observations', () => {
  assert.equal(validateJudge({ ...judge, rank: 'Cho Dan' }).rank, 'D1');
  assert.equal(validateJudge(judge).priority, 4);
  assert.equal(validateJudge({ ...judge, priority: 99 }).priority, 99);
  for (const change of [{ name: '' }, { rank: 'unknown' }, { flaggedForReview: 'false' }, { reviewNotes: 'x'.repeat(2001) }, { certification: null }]) {
    assert.throws(() => validateJudge({ ...judge, ...change }));
  }
  for (const priority of [-1, 100, 1.5, '4']) {
    assert.throws(() => validateJudge({ ...judge, priority }), /Priority must be a whole number from 0 to 99/);
  }
  assert.equal(validateJudge({ ...judge, flaggedForReview: true, reviewNotes: 'Follow up' }).reviewNotes, 'Follow up');
  const named = validateJudge({ ...judge, firstName: ' Jane Ann ', lastName: ' van Doe ' });
  assert.equal(named.name, 'van Doe, Jane Ann');
  assert.equal(named.firstName, 'Jane Ann');
  assert.equal(named.lastName, 'van Doe');
  for (const change of [{ firstName: '' }, { lastName: '' }, { firstName: 12 }, { lastName: 'x'.repeat(101) }]) {
    assert.throws(() => validateJudge({ ...judge, firstName: 'Jane', lastName: 'Doe', ...change }));
  }
});
test('judge certification uses shared levels with enforced rank minimums and lenient migration flags', () => {
  assert.equal(validateJudge(judge).certification, 'UNKNOWN');
  assert.equal(validateJudge({ ...judge, certification: 'Regional Center' }).certification, 'REGIONAL');
  assert.equal(validateJudge({ ...judge, certification: 'scorekeeper', rank: 'G5' }).certification, 'SK_TK');
  for (const change of [{ certification: 'Grandmaster' }, { certification: 'International' },
    { rank: 'G10' }, { rank: 'D9' }, { certification: 'Corner', rank: 'G1' }]) {
    assert.throws(() => validateJudge({ ...judge, ...change }));
  }
  const unrecognized = validateJudge({ ...judge, certification: 'Senior Judge' }, true);
  assert.equal(unrecognized.certification, 'UNKNOWN');
  assert.equal(unrecognized.flaggedForReview, true);
  assert.match(unrecognized.reviewNotes, /was not recognized/);
  const mismatch = validateJudge({ ...judge, certification: 'International' }, true);
  assert.equal(mismatch.certification, 'INTERNATIONAL');
  assert.equal(mismatch.flaggedForReview, true);
  assert.match(mismatch.reviewNotes, /requires rank D2 or higher/);
  assert.match(validateJudge({ ...judge, rank: 'D9' }, true).reviewNotes, /between G5 and D8/);
});
async function seed(file) {
  const db = new sqlite3.Database(file);
  const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, (error) => error ? reject(error) : resolve()));
  await run('CREATE TABLE competitors (id INTEGER, firstName TEXT, lastName TEXT, associationNumber TEXT, studio TEXT, rank TEXT, age INTEGER, ageAsOf TEXT)');
  for (const [id, rank, dob, association] of [
    [1, 'D1', '01/09/2009', 'D101'], [2, 'D3', '01/10/2009', 'D102'],
    [3, 'CDB', '01/01/2000', 'G103'], [4, 'D8', '01/01/1950', 'D104'],
    [5, 'G1', '01/01/2000', 'G105'], [6, 'D10', '01/01/1950', 'D106'],
    [7, 'G5', '01/10/2011', 'G107'], [8, 'CDB', '01/10/2013', 'G108']
  ]) await run('INSERT INTO competitors VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, `First${id}`, 'Last', association, 'School', rank, require('../backend/tournamentAge').ageOnDate(dob, '2027-01-09'), '2027-01-09']);
  await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
}
test('judge API persists scoped CRUD, idempotent adult Dan population, stale guards and operational locks', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-judges-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['A', 'B']) {
    fs.mkdirSync(path.join(root, name));
    await seed(path.join(root, name, 'tournament.db'));
    fs.writeFileSync(path.join(root, name, 'event-config.json'), JSON.stringify({ date: '2027-01-09' }));
  }
  let locked = false;
  const app = express(); app.use(express.json());
  app.use('/api', createRingJudgeRouter({ eventsRoot: root, configurationStatus: () => ({ configurationLocked: locked }) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/ring-judges`;
  const get = async (name = 'A') => (await (await fetch(`${url}?eventName=${name}`)).json());
  const write = (suffix, body, method = 'POST') => fetch(`${url}${suffix}?eventName=A`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  assert.equal((await fetch(url)).status, 400);
  assert.equal((await fetch(`${url}?eventName=..`)).status, 400);
  assert.equal((await fetch(`${url}?eventName=missing`)).status, 404);
  assert.deepEqual((await get()).judges, []);
  assert.equal(fs.existsSync(path.join(root, 'A', 'ring-judges.json')), false);
  const volunteerDetails = { age: 25, ageAsOf: '2027-01-09', parentName: '', contactNumber: '', primaryType: 'judging', secondaryType: '' };
  let response = await write('', { revision: null, volunteerRevision: null, volunteer: volunteerDetails,
    judge: { ...judge, firstName: 'Jane Ann', lastName: 'Doe', associationNumber: 'D101', priority: 4 } });
  assert.equal(response.status, 200);
  let data = await response.json();
  assert.deepEqual(data.judgeRanks, judgeRankOptions());
  assert.equal(data.judges[0].firstName, 'Jane Ann');
  assert.equal(data.judges[0].priority, 4);
  assert.equal(data.volunteerDirectory.volunteers.length, 1);
  assert.equal(data.judges[0].volunteerId, data.volunteerDirectory.volunteers[0].id);
  assert.equal((await get()).judges[0].lastName, 'Doe');
  const manualId = data.judges[0].id;
  assert.equal((await write('', { revision: null, judge })).status, 409);
  assert.equal((await write('', { revision: data.revision, judge: { ...judge, associationNumber: 'd101' } })).status, 409);
  data = await (await write('/populate', { revision: data.revision })).json();
  assert.equal(data.added, 4); assert.equal(data.skipped, 1);
  assert.equal(data.judges.length, 5);
  assert.equal(data.judges.find((row) => row.competitorId !== null && row.rank === 'D8').rank, 'D8');
  for (const rank of ['D3', 'CDB', 'G1']) {
    const candidate = data.judges.find((row) => row.rank === rank);
    assert.equal(candidate.certification, 'UNKNOWN');
    assert.match(candidate.reviewNotes, /SK\/TK age and rank criteria; certification is unverified/);
  }
  assert.equal(data.judges.some((row) => row.associationNumber === 'G107' || row.associationNumber === 'G108'), false);
  assert.equal(data.judges.some((row) => row.rank === 'D10'), false);
  data = await (await write('/populate', { revision: data.revision })).json();
  assert.equal(data.added, 0); assert.equal(data.skipped, 5);
  const concurrent = await Promise.all([
    write('/populate', { revision: data.revision }), write('/populate', { revision: data.revision })
  ]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
  data = await get();
  const volunteerRevision = data.volunteerDirectory.revision;
  response = await write(`/${manualId}`, { revision: data.revision, volunteerRevision,
    volunteer: { ...volunteerDetails, age: 10 }, judge: { ...data.judges.find((row) => row.id === manualId), certification: 'SK/TK' } }, 'PUT');
  assert.equal(response.status, 400);
  assert.equal((await get()).revision, data.revision);
  assert.equal((await get()).volunteerDirectory.revision, volunteerRevision);
  const originalRename = fs.renameSync;
  const renameMock = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(root, 'A', 'ring-judges.json')) throw Object.assign(new Error('Injected judge write failure'), { code: 'EIO' });
    return originalRename(from, to);
  });
  const logMock = t.mock.method(console, 'error', () => {});
  response = await write(`/${manualId}`, { revision: data.revision, volunteerRevision,
    volunteer: volunteerDetails, judge: { ...data.judges.find((row) => row.id === manualId), certification: 'Corner' } }, 'PUT');
  assert.equal(response.status, 500);
  renameMock.mock.restore();
  logMock.mock.restore();
  assert.equal((await get()).revision, data.revision);
  assert.equal((await get()).volunteerDirectory.revision, volunteerRevision);
  assert.equal((await get()).volunteerDirectory.volunteers[0].certification, 'UNKNOWN');
  response = await write(`/${manualId}`, { revision: data.revision, volunteerRevision,
    volunteer: volunteerDetails, judge: { ...data.judges.find((row) => row.id === manualId), certification: 'Corner' } }, 'PUT');
  assert.equal(response.status, 200);
  data = await response.json();
  assert.equal(data.volunteerDirectory.volunteers[0].certification, 'CORNER');
  assert.equal(data.judges.find((row) => row.id === manualId).certification, 'CORNER');
  assert.equal((await write(`/${manualId}`, { revision: data.revision, volunteerRevision,
    volunteer: volunteerDetails, judge: data.judges.find((row) => row.id === manualId) }, 'PUT')).status, 409);
  const competitorCandidate = data.judges.find((row) => row.rank === 'D3');
  response = await write(`/${competitorCandidate.id}`, { revision: data.revision,
    judge: { ...competitorCandidate, rank: 'D1' } }, 'PUT');
  assert.equal(response.status, 400);
  response = await write(`/${competitorCandidate.id}`, { revision: data.revision,
    judge: { ...competitorCandidate, certification: 'SK/TK' } }, 'PUT');
  assert.equal(response.status, 200);
  data = await response.json();
  const linked = data.judges.find((row) => row.competitorId !== null && row.rank === 'D8');
  const db = new sqlite3.Database(path.join(root, 'A', 'tournament.db'));
  await new Promise((resolve, reject) => db.run('UPDATE competitors SET age = 15 WHERE id = ?', [competitorCandidate.competitorId],
    (error) => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  const beforeAgeFailure = data.revision;
  response = await write(`/${competitorCandidate.id}`, { revision: data.revision,
    judge: { ...competitorCandidate, certification: 'SK/TK' } }, 'PUT');
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /age 16/);
  assert.equal((await get()).revision, beforeAgeFailure);
  data = await (await write(`/${linked.id}`, { revision: data.revision, judge: { ...linked, flaggedForReview: true, certification: 'Regional', reviewNotes: 'Follow up' } }, 'PUT')).json();
  data = await (await write('/populate', { revision: data.revision })).json();
  assert.equal(data.judges.find((row) => row.id === linked.id).reviewNotes, 'Follow up');
  const beforeClear = await get();
  for (const ids of [[], [linked.id, linked.id], [linked.id, 'missing']]) {
    assert.equal((await write('/clear-review', { revision: data.revision, ids })).status, 400);
  }
  assert.equal((await write('/clear-review', { revision: 'stale', ids: [linked.id] })).status, 409);
  assert.deepEqual(await get(), beforeClear);
  data = await (await write('/clear-review', { revision: data.revision, ids: [linked.id] })).json();
  assert.deepEqual(data.judges, beforeClear.judges.map((row) => row.id === linked.id ? { ...row, flaggedForReview: false } : row));
  assert.deepEqual((await get()).judges, data.judges);
  assert.deepEqual((await get('B')).judges, []);
  locked = true;
  assert.equal((await get()).configurationLocked, true);
  for (const [suffix, body, method] of [
    ['', { judge }, 'POST'], [`/${manualId}`, { judge }, 'PUT'],
    ['/populate', {}, 'POST'], ['/delete', { ids: [manualId] }, 'POST'],
    ['/clear-review', { ids: [linked.id] }, 'POST']
  ]) assert.equal((await write(suffix, { revision: data.revision, ...body }, method)).status, 409);
  locked = false;
  assert.equal((await write('/delete', { revision: data.revision, ids: [manualId, 'missing'] })).status, 400);
  data = await (await write('/delete', { revision: data.revision, ids: [manualId] })).json();
  assert.equal(data.judges.length, 4);
  assert.deepEqual((await get()).judges, data.judges);
  t.mock.method(console, 'error', () => {});
  fs.writeFileSync(path.join(root, 'A', 'ring-judges.json'), '{bad');
  assert.equal((await fetch(`${url}?eventName=A`)).status, 500);
  assert.equal((await write('/populate', { revision: data.revision })).status, 500);
});
function frontend(change = {}, rows = null) {
  const nodes = new Map(), confirmations = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, handlers: {}, addEventListener(key, fn) { this.handlers[key] = fn; },
      setAttribute() {}, show() { this.open = true; this.modal = false; }, showModal() { this.open = true; this.modal = true; }, close() { this.open = false; }, focus() {} });
    return nodes.get(id);
  };
  let event = 'A', allowed = true, failure = false, schoolFailure = false, locked = false, hold, pending = false;
  let judges = rows || [{ id: 'one', competitorId: null, ...judge, ...change }];
  const requests = [];
  const workspace = create({ document: { getElementById: node }, selectedEvent: () => event,
    confirm: (message) => { confirmations.push(message); return allowed; },
    request: async (url, options) => {
      requests.push({ url, options });
      if (url === '/api/schools') {
        if (schoolFailure) throw new Error('Unable to load schools');
        return { schools: [{ name: 'School', archived: false }, { name: '<New School>', archived: false }, { name: 'Archived', archived: true }] };
      }
      if (pending) await new Promise((resolve) => { hold = resolve; });
      if (failure) throw new Error('Request failed');
      if (options) {
        const body = JSON.parse(options.body);
        if (url.includes('/delete?')) judges = [];
        else if (url.includes('/clear-review?')) judges = judges.map((row) => body.ids.includes(row.id) ? { ...row, flaggedForReview: false } : row);
        else if (!url.includes('/populate?')) judges = [{ id: 'one', competitorId: null, ...body.judge,
          name: `${body.judge.lastName}, ${body.judge.firstName}` }];
      }
      return { judges, revision: 'r1', volunteerDirectory: { revision: null, tournamentDate: '2027-01-09',
        types: [{ id: 'judging', name: 'Judging' }, { id: 'medical', name: 'Medical' }], volunteers: [] },
        configurationLocked: locked, certificationLevels: certificationLevels(), judgeRanks: judgeRankOptions(), added: 0, skipped: 1 };
    } });
  return { workspace, node, requests, confirmations, setEvent: (v) => { event = v; },
    confirm: (v) => { allowed = v; }, fail: (v) => { failure = v; }, lock: () => { locked = true; },
    failSchools: () => { schoolFailure = true; },
    hold: () => { pending = true; }, finish: () => { pending = false; hold(); } };
}
test('judge editor filters, escapes, confirms changes, preserves errors and guards pending writes', async () => {
  const p = frontend(), n = p.node;
  await p.workspace.load();
  assert.equal(n('rjDelete').disabled, true);
  n('rjAdd').handlers.click(); n('rj-firstName').value = '<New>'; n('rj-lastName').value = 'Judge';
  p.confirm(false);
  assert.equal(p.workspace.canLeave(), false);
  assert.equal(n('rjDialog').open, true);
  p.fail(true);
  await n('rjForm').handlers.submit({ preventDefault() {} });
  assert.match(n('rjError').textContent, /Request failed/);
  assert.equal(p.workspace.dirty(), true);
  p.fail(false); p.hold();
  const saving = n('rjForm').handlers.submit({ preventDefault() {} });
  assert.equal(p.workspace.busy(), true);
  assert.equal(n('rjSave').disabled, true);
  assert.equal(n('rj-firstName').disabled, true);
  p.finish(); await saving;
  assert.match(n('rjBody').innerHTML, /&lt;New&gt;/);
  n('rjSearch').value = 'absent'; n('rjSearchForm').handlers.submit({ preventDefault() {} });
  assert.match(n('rjBody').innerHTML, /No matching/);
  n('rjSearch').value = ''; n('rjSearchForm').handlers.submit({ preventDefault() {} });
  n('rjAll').checked = true; n('rjAll').handlers.change();
  assert.equal(n('rjDelete').disabled, false);
  await n('rjDelete').handlers.click();
  assert.equal(p.requests.some((r) => r.url.includes('/delete?')), false);
  p.confirm(true); await n('rjDelete').handlers.click();
  assert.match(n('rjBody').innerHTML, /No matching/);
  assert.equal(n('rjDelete').disabled, true);
  p.lock(); await p.workspace.load();
  assert.equal(n('rjAdd').disabled, true);
  assert.equal(n('rjPopulate').disabled, true);
});
test('judge workspace ignores late responses after tournament changes or navigation', async () => {
  const p = frontend();
  p.hold();
  const loading = p.workspace.load();
  p.setEvent('B'); p.workspace.leave(); p.finish(); await loading;
  assert.doesNotMatch(p.node('rjBody').innerHTML, /Judge One/);
});
test('Ring Judges column filters work together and clear without changing the saved directory', async () => {
  const rows = [
    { id: 'one', competitorId: null, name: 'Alex Doe', associationNumber: 'A101', school: 'East', rank: 'D3',
      certification: 'SK_TK', priority: 4, flaggedForReview: true, reviewNotes: '' },
    { id: 'two', competitorId: 2, name: 'Jordan Smith', associationNumber: 'B202', school: 'West', rank: 'D1',
      certification: 'REGIONAL', priority: 12, flaggedForReview: false, reviewNotes: '' },
    { id: 'three', competitorId: null, volunteerId: 'v3', name: 'Alex Jones', associationNumber: 'A303', school: 'East',
      rank: 'D3', certification: 'SK_TK', priority: 4, flaggedForReview: false, reviewNotes: '' }
  ];
  const p = frontend({}, rows), n = p.node;
  await p.workspace.load();
  for (const id of ['name', 'associationNumber', 'school', 'rank', 'certification', 'priority', 'flaggedForReview', 'source']) {
    assert.ok(n(`rjFilter-${id}`), `expected filter for ${id}`);
  }
  n('rjFilter-name').value = 'alex';
  n('rjFilter-name').handlers.input({ target: n('rjFilter-name') });
  assert.match(n('rjBody').innerHTML, /Alex Doe/);
  assert.match(n('rjBody').innerHTML, /Alex Jones/);
  assert.doesNotMatch(n('rjBody').innerHTML, /Jordan Smith/);

  n('rjFilter-priority').value = '4';
  n('rjFilter-priority').handlers.change({ target: n('rjFilter-priority') });
  assert.match(n('rjBody').innerHTML, /Alex Doe/);
  assert.match(n('rjBody').innerHTML, /Alex Jones/);
  assert.doesNotMatch(n('rjBody').innerHTML, /Jordan Smith/);
  n('rjFilter-school').value = 'East';
  n('rjFilter-school').handlers.change({ target: n('rjFilter-school') });
  n('rjFilter-rank').value = 'D3';
  n('rjFilter-rank').handlers.change({ target: n('rjFilter-rank') });
  n('rjFilter-certification').value = 'SK_TK';
  n('rjFilter-certification').handlers.change({ target: n('rjFilter-certification') });
  n('rjFilter-flaggedForReview').value = 'true';
  n('rjFilter-flaggedForReview').handlers.change({ target: n('rjFilter-flaggedForReview') });
  n('rjFilter-source').value = 'Manual';
  n('rjFilter-source').handlers.change({ target: n('rjFilter-source') });
  assert.match(n('rjBody').innerHTML, /Alex Doe/);
  assert.doesNotMatch(n('rjBody').innerHTML, /Alex Jones|Jordan Smith/);
  assert.match(n('rjCount').textContent, /^1 of 3 judges/);

  n('rjFilter-associationNumber').value = 'B202';
  n('rjFilter-associationNumber').handlers.input({ target: n('rjFilter-associationNumber') });
  assert.match(n('rjBody').innerHTML, /No matching judges/);
  n('rjSearch').value = 'Jordan';
  n('rjSearchForm').handlers.submit({ preventDefault() {} });
  assert.match(n('rjBody').innerHTML, /No matching judges/);

  await n('rjClearFilters').handlers.click();
  assert.match(n('rjBody').innerHTML, /Alex Doe/);
  assert.match(n('rjBody').innerHTML, /Alex Jones/);
  assert.match(n('rjBody').innerHTML, /Jordan Smith/);
  assert.equal(n('rjSearch').value, '');
  assert.equal(n('rjFilter-name').value, '');
  assert.equal(n('rjFilter-school').value, '');
  assert.equal(n('rjFilter-priority').value, '');
});
test('Add and Edit use named rank and school dropdowns, retain selections and submit separate names with rank codes', async () => {
  const p = frontend({ name: 'van Doe, Jane Ann', school: 'Former <School>', rank: 'D8' }), n = p.node;
  await p.workspace.load();
  n('rjAdd').handlers.click();
  assert.equal(n('rjDialogTitle').textContent, 'Add Volunteer to Ring Judges');
  assert.equal(n('rjDialog').modal, false);
  assert.equal(n('rj-rank').value, '');
  assert.match(n('rj-rank').innerHTML, /value="G5">5th Gup/);
  assert.match(n('rj-rank').innerHTML, /value="D1">Cho Dan/);
  assert.match(n('rj-rank').innerHTML, /value="D8">Pal Dan/);
  assert.doesNotMatch(n('rj-rank').innerHTML, /value="(?:G6|D9)"/);
  assert.match(n('rj-school').innerHTML, /&lt;New School&gt;/);
  assert.doesNotMatch(n('rj-school').innerHTML, /Archived|Former/);
  n('rjCancel').handlers.click();
  n('rjBody').handlers.dblclick(nameEvent(2));
  assert.equal(n('rjDialogTitle').textContent, 'Edit Judge');
  assert.equal(n('rjDialog').modal, false);
  assert.equal(n('rj-firstName').value, 'Jane Ann');
  assert.equal(n('rj-lastName').value, 'van Doe');
  assert.equal(n('rj-school').value, 'Former <School>');
  assert.match(n('rj-school').innerHTML, /Former &lt;School&gt;/);
  assert.equal(n('rj-rank').value, 'D8');
  assert.equal(n('rj-priority').value, 4);
  assert.equal(p.workspace.dirty(), false);
  n('rj-firstName').value = 'Janet';
  n('rj-rank').value = 'D7';
  n('rj-priority').value = '7';
  await n('rjForm').handlers.submit({ preventDefault() {} });
  const saved = JSON.parse(p.requests.at(-1).options.body).judge;
  assert.equal(saved.firstName, 'Janet');
  assert.equal(saved.lastName, 'van Doe');
  assert.equal(saved.rank, 'D7');
  assert.equal(saved.priority, 7);
  n('rjBody').handlers.dblclick(nameEvent(2));
  assert.equal(n('rj-firstName').value, 'Janet');
  assert.equal(n('rj-rank').value, 'D7');
});
test('failed school directory load surfaces an error and disables judge editing', async () => {
  const p = frontend();
  p.failSchools();
  await p.workspace.load();
  assert.match(p.node('rjNotice').textContent, /Unable to load schools/);
  assert.equal(p.node('rjAdd').disabled, true);
});
test('judge editor collects a volunteer for Add and locks competitor rank while certification remains editable', async () => {
  const p = frontend(), n = p.node;
  await p.workspace.load();
  n('rjAdd').handlers.click();
  assert.equal(n('rjVolunteerFields').hidden, false);
  assert.equal(n('rj-age').required, true);
  assert.equal(n('rj-primaryType').value, 'judging');
  assert.match(n('rj-primaryType').innerHTML, /Medical/);
  assert.match(n('rj-secondaryType').innerHTML, /None/);
  n('rj-age').value = '11';
  n('rj-age').handlers.input();
  assert.equal(n('rj-parentName').required, true);
  await n('rjForm').handlers.submit({ preventDefault() {} });
  const body = JSON.parse(p.requests.at(-1).options.body);
  assert.equal(body.volunteer.age, 11);
  assert.equal(body.volunteer.ageAsOf, '2027-01-09');
  assert.equal(body.volunteerRevision, null);
  const competitor = frontend({}, [{ id: 'one', competitorId: '1', ...judge }]);
  await competitor.workspace.load();
  competitor.node('rjBody').handlers.dblclick(nameEvent(2));
  assert.equal(competitor.node('rjVolunteerFields').hidden, true);
  assert.equal(competitor.node('rj-rank').disabled, true);
  assert.equal(competitor.node('rj-certification').disabled, false);
});
const nameEvent = (detail = 1) => ({
  detail, preventDefault() {},
  target: { closest: () => ({ getAttribute: () => 'one' }) }
});
test('single-click and keyboard activation open Edit Judge directly without the details screen', async () => {
  const p = frontend({ reviewNotes: '<Follow up>\nSecond line' }), n = p.node;
  await p.workspace.load();
  assert.match(n('rjBody').innerHTML, /<a .*data-rj-name="one"/);
  assert.match(n('rjBody').innerHTML, /Unknown/);
  assert.doesNotMatch(n('rjBody').innerHTML, /Follow up/);
  n('rjBody').handlers.click(nameEvent());
  assert.notEqual(n('rjDetailsDialog').open, true);
  assert.equal(n('rjDialog').open, true);
  assert.equal(n('rjDialogTitle').textContent, 'Edit Judge');
  assert.equal(n('rj-reviewNotes').value, '<Follow up>\nSecond line');
  assert.equal(n('rj-certification').value, '');
  assert.match(n('rj-certification').innerHTML, /Unknown.+Uncertified.+SK\/TK.+Corner.+Regional \(Center\).+International/);
  n('rjCancel').handlers.click();
  n('rjBody').handlers.click(nameEvent());
  n('rjBody').handlers.click(nameEvent(2));
  n('rjBody').handlers.dblclick(nameEvent(2));
  assert.equal(n('rjDialog').open, true);
  assert.equal(n('rjDetailsDialog').open, false);
  assert.equal(p.workspace.dirty(), false);
  n('rjCancel').handlers.click();
  n('rjBody').handlers.click(nameEvent(0));
  assert.equal(n('rjDialog').open, true);
  assert.equal(n('rjDialogTitle').textContent, 'Edit Judge');
  assert.equal(n('rj-firstName').value, 'Judge');
  assert.equal(n('rj-lastName').value, 'One');
  p.workspace.canLeave(); p.workspace.leave();
  assert.equal(n('rjDialog').open, false);
  assert.equal(n('rjDetailsDialog').open, false);
});
test('review flag clearing confirms, reports errors, guards writes and preserves notes', async () => {
  const p = frontend({ flaggedForReview: true, reviewNotes: 'Keep this note', certification: 'REGIONAL' }), n = p.node;
  await p.workspace.load();
  assert.equal(n('rjClearReview').disabled, true);
  n('rjAll').checked = true; n('rjAll').handlers.change();
  assert.equal(n('rjClearReview').disabled, false);
  p.confirm(false); await n('rjClearReview').handlers.click();
  assert.equal(p.requests.filter((r) => r.options).length, 0);
  p.confirm(true); p.fail(true); await n('rjClearReview').handlers.click();
  assert.match(n('rjNotice').textContent, /Request failed/);
  assert.equal(n('rjClearReview').disabled, false);
  p.fail(false); p.hold();
  const saving = n('rjClearReview').handlers.click();
  assert.equal(n('rjClearReview').disabled, true);
  assert.equal(p.workspace.canLeave(), false);
  p.finish(); await saving;
  assert.match(n('rjNotice').textContent, /Notes are unchanged/);
  assert.equal(n('rjClearReview').disabled, true);
  n('rjBody').handlers.click(nameEvent(0));
  assert.equal(n('rjDialog').open, true);
  assert.equal(n('rj-reviewNotes').value, 'Keep this note');
  assert.equal(n('rj-certification').value, 'REGIONAL');
  assert.equal(n('rj-flaggedForReview').checked, false);
  p.workspace.canLeave(); p.lock(); await p.workspace.load();
  n('rjBody').handlers.click(nameEvent(0));
  assert.equal(n('rjDetailsDialog').open, true);
  assert.equal(n('rjDetailsEdit').disabled, true);
  assert.equal(n('rjClearReview').disabled, true);
  const count = p.requests.length;
  await n('rjClearReview').handlers.click();
  n('rjDetailsEdit').handlers.click();
  assert.equal(p.requests.length, count);
  assert.notEqual(n('rjDialog').open, true);
});
