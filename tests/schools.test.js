const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createSchoolRouter, initialSchools } = require('../backend/schoolRoutes');
const { create } = require('../tournament-management/schools');

test('school directory seeds once, persists create/edit/archive and rejects invalid or duplicate schools', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'school-directory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'schools.json');
  const app = express();
  app.use(express.json());
  app.use('/api', createSchoolRouter(file));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/schools`;
  assert.deepEqual((await (await fetch(url)).json()).schools, initialSchools);
  const write = (body, id) => fetch(url + (id ? `/${id}` : ''), { method: id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const draft = { name: 'New School', alternateNames: 'Alias One; Alias Two', chiefInstructor: 'Instructor', archived: false };
  const response = await write(draft);
  assert.equal(response.status, 201);
  const school = (await response.json()).schools.at(-1);
  assert.equal((await write({ ...draft, archived: true }, school.id)).status, 200);
  assert.equal((await write({ ...draft, name: 'new school' })).status, 409);
  for (const change of [{ name: '' }, { archived: 'false' }, { name: 'x'.repeat(201) }, { alternateNames: null }]) {
    assert.equal((await write({ ...draft, ...change })).status, 400);
  }
  assert.equal((await write(draft, 'missing')).status, 404);
  assert.equal((await (await fetch(url)).json()).schools.length, 4);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schools.at(-1).archived, true);
  const remove = (body) => fetch(`${url}/delete`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const body of [{}, { ids: [] }, { ids: [school.id, school.id] }, { ids: [null] }, { ids: [''] }]) {
    assert.equal((await remove(body)).status, 400);
  }
  assert.equal((await remove({ ids: [school.id, 'missing'] })).status, 409);
  assert.equal((await (await fetch(url)).json()).schools.length, 4);
  assert.equal((await remove({ ids: [school.id, initialSchools[0].id] })).status, 200);
  const remaining = initialSchools.slice(1);
  assert.deepEqual((await (await fetch(url)).json()).schools, remaining);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).schools, remaining);
  assert.equal((await remove({ ids: remaining.map((row) => row.id) })).status, 200);
  assert.deepEqual((await (await fetch(url)).json()).schools, []);
  t.mock.method(console, 'error', () => {});
  fs.writeFileSync(file, '{bad');
  assert.equal((await fetch(url)).status, 500);
  assert.equal((await remove({ ids: [school.id] })).status, 500);
  assert.equal(fs.readFileSync(file, 'utf8'), '{bad');
});

test('school deletion supports selection, cancellation, busy guards and visible failures', async () => {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, handlers: {}, addEventListener(k, fn) { this.handlers[k] = fn; },
      setAttribute() {}, showModal() {}, close() {}, focus() {} });
    return nodes.get(id);
  };
  let confirmed = false, fail = false, calls = 0, finish;
  let schools = initialSchools.map((row) => ({ ...row }));
  const workspace = create({ document: { getElementById: get }, confirm: () => confirmed,
    request: async (url, options) => {
      if (options) {
        assert.equal(url, '/api/schools/delete');
        calls++;
        if (fail) throw new Error('Delete failed');
        await new Promise((resolve) => { finish = resolve; });
        schools = schools.filter((row) => !JSON.parse(options.body).ids.includes(row.id));
      }
      return { schools };
    } });
  await workspace.load();
  assert.equal(get('deleteSchools').disabled, true);
  get('schoolsBody').handlers.change({ target: { checked: true, getAttribute: () => schools[0].id } });
  assert.equal(get('schoolsSelectAll').indeterminate, true);
  await get('deleteSchools').handlers.click();
  assert.equal(calls, 0);
  confirmed = true; fail = true;
  await get('deleteSchools').handlers.click();
  assert.match(get('schoolsNotice').textContent, /Delete failed/);
  assert.equal(get('deleteSchools').disabled, false);
  get('schoolsSelectAll').checked = true;
  get('schoolsSelectAll').handlers.change();
  assert.equal(get('schoolsSelectAll').checked, true);
  fail = false;
  const pending = get('deleteSchools').handlers.click();
  assert.equal(workspace.busy(), true);
  assert.equal(get('deleteSchools').disabled, true);
  assert.equal(get('addSchool').disabled, true);
  await get('deleteSchools').handlers.click();
  assert.equal(calls, 2);
  finish(); await pending;
  assert.equal(workspace.busy(), false);
  assert.equal(get('deleteSchools').disabled, true);
  assert.match(get('schoolsBody').innerHTML, /colspan="5">No schools yet/);
  assert.match(get('schoolsNotice').textContent, /Selected schools deleted/);
});

test('school overlay supports add/edit, escaped display, unsaved cancel and save errors', async () => {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, handlers: {}, addEventListener(k, fn) { this.handlers[k] = fn; },
      setAttribute() {}, showModal() { this.open = true; }, close() { this.open = false; }, focus() {} });
    return nodes.get(id);
  };
  let schoolData = initialSchools.map((school) => ({ ...school }));
  let failure = false;
  const workspace = create({ document: { getElementById: get }, confirm: () => false, request: async (_url, options) => {
    if (options) {
      if (failure) throw new Error('Save failed');
      schoolData.push({ id: 'new', ...JSON.parse(options.body) });
    }
    return { schools: schoolData };
  } });
  await workspace.load();
  assert.match(get('schoolsBody').innerHTML, /Phoenixville.*Master David Painter/);
  get('addSchool').handlers.click();
  get('schoolName').value = '<School>';
  assert.equal(workspace.dirty(), true);
  get('schoolCancel').handlers.click();
  assert.equal(get('schoolDialog').open, true);
  failure = true;
  await get('schoolForm').handlers.submit({ preventDefault() {} });
  assert.equal(workspace.dirty(), true);
  assert.match(get('schoolError').textContent, /Save failed/);
  failure = false;
  await get('schoolForm').handlers.submit({ preventDefault() {} });
  assert.equal(get('schoolDialog').open, false);
  assert.match(get('schoolsBody').innerHTML, /&lt;School&gt;/);
  get('schoolsBody').handlers.click({ target: { closest: () => ({ getAttribute: () => initialSchools[0].id }) } });
  assert.equal(get('schoolName').value, initialSchools[0].name);
  assert.equal(get('schoolDialogTitle').textContent, 'Edit School');
});
