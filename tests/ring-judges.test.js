const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const sqlite3 = require('sqlite3');
const express = require('express');
const { createRingJudgeRouter, validateJudge } = require('../backend/ringJudgeRoutes');
const { create } = require('../tournament-management/ring-judges');
const judge = { name: 'Judge One', associationNumber: 'D100', school: 'School', rank: 'D1',
  certification: '', flaggedForReview: false, reviewNotes: '' };
test('judge validation preserves optional certification and review observations', () => {
  assert.equal(validateJudge({ ...judge, rank: 'Cho Dan' }).rank, 'D1');
  for (const change of [{ name: '' }, { rank: 'unknown' }, { flaggedForReview: 'false' }, { reviewNotes: 'x'.repeat(2001) }, { certification: null }]) {
    assert.throws(() => validateJudge({ ...judge, ...change }));
  }
  assert.equal(validateJudge({ ...judge, flaggedForReview: true, reviewNotes: 'Follow up' }).reviewNotes, 'Follow up');
});
async function seed(file) {
  const db = new sqlite3.Database(file);
  const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, (error) => error ? reject(error) : resolve()));
  await run('CREATE TABLE competitors (id INTEGER, firstName TEXT, lastName TEXT, associationNumber TEXT, studio TEXT, rank TEXT, age INTEGER, ageAsOf TEXT)');
  for (const [id, rank, dob, association] of [
    [1, 'D1', '01/09/2009', 'D101'], [2, 'D3', '01/10/2009', 'D102'],
    [3, 'CDB', '01/01/2000', 'G103'], [4, 'D10', '01/01/1950', 'D104'],
    [5, 'G1', '01/01/2000', 'G105']
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
  let response = await write('', { revision: null, judge: { ...judge, associationNumber: 'D101' } });
  assert.equal(response.status, 200);
  let data = await response.json();
  const manualId = data.judges[0].id;
  assert.equal((await write('', { revision: null, judge })).status, 409);
  assert.equal((await write('', { revision: data.revision, judge: { ...judge, associationNumber: 'd101' } })).status, 409);
  data = await (await write('/populate', { revision: data.revision })).json();
  assert.equal(data.added, 1); assert.equal(data.skipped, 1);
  assert.equal(data.judges.length, 2);
  assert.equal(data.judges.find((row) => row.competitorId !== null).rank, 'D10');
  data = await (await write('/populate', { revision: data.revision })).json();
  assert.equal(data.added, 0); assert.equal(data.skipped, 2);
  const concurrent = await Promise.all([
    write('/populate', { revision: data.revision }), write('/populate', { revision: data.revision })
  ]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
  data = await get();
  const linked = data.judges.find((row) => row.competitorId !== null);
  data = await (await write(`/${linked.id}`, { revision: data.revision, judge: { ...linked, flaggedForReview: true, certification: 'Regional', reviewNotes: 'Follow up' } }, 'PUT')).json();
  data = await (await write('/populate', { revision: data.revision })).json();
  assert.equal(data.judges.find((row) => row.id === linked.id).reviewNotes, 'Follow up');
  assert.deepEqual((await get('B')).judges, []);
  locked = true;
  assert.equal((await get()).configurationLocked, true);
  for (const [suffix, body, method] of [
    ['', { judge }, 'POST'], [`/${manualId}`, { judge }, 'PUT'],
    ['/populate', {}, 'POST'], ['/delete', { ids: [manualId] }, 'POST']
  ]) assert.equal((await write(suffix, { revision: data.revision, ...body }, method)).status, 409);
  locked = false;
  assert.equal((await write('/delete', { revision: data.revision, ids: [manualId, 'missing'] })).status, 400);
  data = await (await write('/delete', { revision: data.revision, ids: [manualId] })).json();
  assert.equal(data.judges.length, 1);
  assert.deepEqual((await get()).judges, data.judges);
  t.mock.method(console, 'error', () => {});
  fs.writeFileSync(path.join(root, 'A', 'ring-judges.json'), '{bad');
  assert.equal((await fetch(`${url}?eventName=A`)).status, 500);
  assert.equal((await write('/populate', { revision: data.revision })).status, 500);
});
function frontend() {
  const nodes = new Map(), confirmations = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, handlers: {}, addEventListener(key, fn) { this.handlers[key] = fn; },
      setAttribute() {}, showModal() { this.open = true; }, close() { this.open = false; }, focus() {} });
    return nodes.get(id);
  };
  let event = 'A', allowed = true, failure = false, locked = false, hold, pending = false;
  let judges = [{ id: 'one', competitorId: null, ...judge }];
  const requests = [];
  const workspace = create({ document: { getElementById: node }, selectedEvent: () => event,
    confirm: (message) => { confirmations.push(message); return allowed; },
    request: async (url, options) => {
      requests.push({ url, options });
      if (pending) await new Promise((resolve) => { hold = resolve; });
      if (failure) throw new Error('Request failed');
      if (options) {
        const body = JSON.parse(options.body);
        if (url.includes('/delete?')) judges = [];
        else if (!url.includes('/populate?')) judges = [{ id: 'one', competitorId: null, ...body.judge }];
      }
      return { judges, revision: 'r1', configurationLocked: locked, added: 0, skipped: 1 };
    } });
  return { workspace, node, requests, confirmations, setEvent: (v) => { event = v; },
    confirm: (v) => { allowed = v; }, fail: (v) => { failure = v; }, lock: () => { locked = true; },
    hold: () => { pending = true; }, finish: () => { pending = false; hold(); } };
}
test('judge editor filters, escapes, confirms changes, preserves errors and guards pending writes', async () => {
  const p = frontend(), n = p.node;
  await p.workspace.load();
  assert.equal(n('rjDelete').disabled, true);
  n('rjAdd').handlers.click(); n('rj-name').value = '<New>';
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
  assert.equal(n('rj-name').disabled, true);
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
