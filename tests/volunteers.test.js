const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { createVolunteerRouter, headers } = require('../backend/volunteerRoutes');
const { createRingJudgeRouter } = require('../backend/ringJudgeRoutes');
const { create } = require('../tournament-management/volunteers');
const volunteer = { firstName: 'Jane', lastName: 'Doe', dob: '2000-01-09', associationNumber: 'D100', school: 'School',
  rank: 'D2', certification: 'Regional', primaryType: 'setup', secondaryType: 'judging' };
const csvRow = (association = 'D100', first = 'Jane') => `${first},Doe,2000-01-09,${association},School,D2,,Setup,Judging`;
const csvText = (...rows) => Object.keys(headers).join(',') + '\n' + rows.join('\n');
test('volunteer CRUD, CSV atomic upsert, type references, scope, revision and operational locks', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'volunteers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['A', 'B']) {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, 'tournament.db'), '');
    fs.writeFileSync(path.join(root, name, 'event-config.json'), JSON.stringify({ date: '2027-01-09' }));
  }
  let locked = false;
  const options = { eventsRoot: root, configurationStatus: () => ({ configurationLocked: locked }) };
  const app = express(); app.use(express.json({ limit: '3mb' }));
  app.use('/api', createVolunteerRouter(options)); app.use('/api', createRingJudgeRouter(options));
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const get = async (name = 'A') => (await (await fetch(`${base}/volunteers?eventName=${name}`)).json());
  const write = (route, body, method = 'POST') => fetch(`${base}/${route}?eventName=A`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await fetch(`${base}/volunteers`)).status, 400);
  assert.equal((await fetch(`${base}/volunteers?eventName=..`)).status, 400);
  let data = await get();
  assert.deepEqual(data.types.map((r) => r.name), ['Setup', 'Teardown', 'Judging', 'Security']);
  assert.equal(fs.existsSync(path.join(root, 'A', 'volunteers.json')), false);
  const response = await write('volunteers', { revision: null, volunteer });
  assert.equal(response.status, 200); data = await response.json();
  assert.equal(data.volunteers[0].age, 27);
  assert.equal(data.volunteers[0].ageAsOf, '2027-01-09');
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'A', 'volunteers.json'), 'utf8'), /"dob"/i);
  const originalId = data.volunteers[0].id;
  for (const change of [{ rank: '' }, { dob: '' }, { dob: '2000-02-30' }, { secondaryType: 'setup' }, { primaryType: 'missing' }]) {
    assert.equal((await write('volunteers', { revision: data.revision, volunteer: { ...volunteer, associationNumber: '', ...change } })).status, 400);
  }
  assert.equal((await write('volunteers', { revision: null, volunteer })).status, 409);
  assert.equal((await write('volunteer-types/delete', { revision: data.revision, ids: ['judging'] })).status, 409);
  let imported = await write('volunteers/import', { revision: data.revision, csv: csvText(csvRow('d100', 'Updated'), csvRow('', 'Blank')) });
  assert.equal(imported.status, 200); data = await imported.json();
  assert.equal(data.added, 1); assert.equal(data.updated, 1); assert.equal(data.volunteers[0].id, originalId);
  const unchanged = JSON.stringify(data.volunteers);
  for (const text of [csvText(csvRow('D200'), csvRow('d200')), csvText(csvRow('D200'), csvRow('D201').replace('Setup', 'Unknown')), 'Bad,Headers\nA,B', csvText()]) {
    assert.equal((await write('volunteers/import', { revision: data.revision, csv: text })).status, 400);
    assert.equal(JSON.stringify((await get()).volunteers), unchanged);
  }
  const concurrent = await Promise.all([
    write('volunteers/import', { revision: data.revision, csv: csvText(csvRow('D100', 'Updated')) }),
    write('volunteers/import', { revision: data.revision, csv: csvText(csvRow('D100', 'Updated')) })
  ]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
  data = await get();
  const { dob, ...ageOnly } = volunteer;
  data = await (await write(`volunteers/${originalId}`, { revision: data.revision, volunteer: { ...ageOnly, age: 27, ageAsOf: '2027-01-09' } }, 'PUT')).json();
  assert.equal(data.volunteers[0].age, 27);
  assert.equal((await write('volunteers', { revision: data.revision, volunteer: { ...ageOnly, associationNumber: '', age: 27, ageAsOf: '2028-01-09' } })).status, 400);
  data = await (await write('volunteer-types', { revision: data.revision, name: 'Hospitality' })).json();
  const type = data.types.at(-1);
  data = await (await write(`volunteer-types/${type.id}`, { revision: data.revision, name: 'Welcome' }, 'PUT')).json();
  data = await (await write('volunteer-types/delete', { revision: data.revision, ids: [type.id] })).json();
  assert.deepEqual((await get('B')).volunteers, []);
  let judges = await (await write('ring-judges/populate-volunteers', { revision: null })).json();
  assert.equal(judges.added, 2);
  assert.equal(judges.judges[0].volunteerId, originalId);
  assert.equal(judges.judges[0].certification, 'Regional');
  judges = await (await write('ring-judges/populate-volunteers', { revision: judges.revision })).json();
  assert.equal(judges.added, 0); assert.equal(judges.skipped, 2);
  data = await (await write('volunteers', { revision: data.revision, volunteer: { ...volunteer, associationNumber: 'D300', dob: '2010-01-01' } })).json();
  data = await (await write('volunteers', { revision: data.revision, volunteer: { ...volunteer, associationNumber: 'G300', rank: 'G1' } })).json();
  judges = await (await write('ring-judges/populate-volunteers', { revision: judges.revision })).json();
  assert.equal(judges.added, 0);
  locked = true;
  for (const route of ['volunteers', 'volunteers/import', 'volunteers/delete', 'volunteer-types', 'volunteer-types/delete']) {
    assert.equal((await write(route, { revision: data.revision, volunteer, ids: [originalId] })).status, 409);
  }
  assert.equal((await write('ring-judges/populate-volunteers', { revision: judges.revision })).status, 409);
  locked = false;
  data = await (await write('volunteers/delete', { revision: data.revision, ids: [originalId] })).json();
  assert.equal(data.volunteers.some((r) => r.id === originalId), false);
  t.mock.method(console, 'error', () => {});
  fs.writeFileSync(path.join(root, 'A', 'volunteers.json'), '{bad');
  assert.equal((await fetch(`${base}/volunteers?eventName=A`)).status, 500);
});
test('volunteer editor switches types, protects drafts, filters and surfaces import errors', async () => {
  const nodes = new Map(), requests = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', files: [], handlers: {}, addEventListener(k, fn) { this.handlers[k] = fn; },
      setAttribute() {}, showModal() { this.open = true; }, close() { this.open = false; }, focus() {} });
    return nodes.get(id);
  };
  let allowed = false, failure = false;
  const data = { revision: null, types: [{ id: 'setup', name: 'Setup' }, { id: 'judging', name: 'Judging' }], volunteers: [{ id: 'one', ...volunteer }] };
  const workspace = create({ document: { getElementById: node }, selectedEvent: () => 'A', confirm: () => allowed, request: async (url, options) => {
    requests.push({ url, options }); if (failure) throw new Error('Import failed'); return data;
  } });
  await workspace.load('volunteers'); node('vmAdd').handlers.click();
  node('vm-firstName').value = 'New';
  assert.equal(workspace.canLeave(), false);
  assert.equal(workspace.dirty(), true);
  allowed = true; node('vmCancel').handlers.click();
  node('vmSearch').value = 'absent'; node('vmSearchForm').handlers.submit({ preventDefault() {} });
  assert.match(node('vmBody').innerHTML, /No matching/);
  node('vmCsv').files = [{ size: 100, text: async () => csvText(csvRow()) }];
  failure = true; await node('vmImport').handlers.click();
  assert.match(node('vmNotice').textContent, /Import failed/);
  assert.equal(workspace.busy(), false);
  failure = false; await workspace.load('volunteer-types');
  node('vmAdd').handlers.click();
  assert.equal(node('vm-firstName').disabled, true);
  assert.equal(node('vm-typeName').disabled, false);
  node('vm-typeName').value = 'Welcome';
  await node('vmForm').handlers.submit({ preventDefault() {} });
  assert.equal(requests.at(-1).url, '/api/volunteer-types?eventName=A');
  assert.equal(JSON.parse(requests.at(-1).options.body).name, 'Welcome');
});
