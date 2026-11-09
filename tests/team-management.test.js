const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const express = require('express');
const { createTeamStore, deriveTeam, validateSettings } = require('../backend/teamStore');
const { createTeamRouter } = require('../backend/teamRoutes');
const { createEventConfigStore } = require('../backend/eventConfig');
const { create } = require('../tournament-management/team-management');
const importCSV = require('../db/import-csv');

const members = [
  { id: 1, firstName: 'One', lastName: 'A', rank: 'G1', gender: 'Male', age: 20, studio: 'A' },
  { id: 2, firstName: 'Two', lastName: 'B', rank: 'D1', gender: 'Male', age: 18, studio: 'B' },
  { id: 3, firstName: 'Three', lastName: 'C', rank: 'D1', gender: 'Male', age: 30, studio: 'C' },
  { id: 4, firstName: 'Four', lastName: 'D', rank: 'D1', gender: 'Male', age: 30 },
  { id: 5, firstName: 'Five', lastName: 'E', rank: 'CDB', gender: 'Female', age: 50 },
  { id: 6, firstName: 'Six', lastName: 'F', rank: '', gender: 'Male', age: 25 }
];
function query(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (error) => error ? reject(error) : resolve()));
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(__dirname, 'team-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['A', 'B']) {
    fs.mkdirSync(path.join(root, name));
    const db = new sqlite3.Database(path.join(root, name, 'tournament.db'));
    await query(db, 'CREATE TABLE competitors(id INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT, rank TEXT, gender TEXT, age INTEGER, studio TEXT, dob TEXT)');
    for (const member of members) await query(db, 'INSERT INTO competitors VALUES (?,?,?,?,?,?,?,?)',
      [member.id, member.firstName, member.lastName, member.rank, member.gender, member.age, member.studio || '', '1990-01-01']);
    await new Promise((resolve) => db.close(resolve));
  }
  return { root, store: createTeamStore(path.join(root, 'A', 'tournament.db')) };
}
const input = (ids = [1, 2, 3], discipline = 'TS') => ({ name: 'Team', discipline, memberIds: ids });
const settings = (TS = { teamSize: 3, genderPolicy: 'single' }, TH = { teamSize: 3, genderPolicy: 'single' }) => ({ TS, TH });
test('captain uses normalized rank, oldest age then ID; unknown rank, age and gender rejected', () => {
  assert.equal(deriveTeam({}, members.slice(0, 3), { teamSize: 3, genderPolicy: 'single' }).captain.id, 3);
  assert.equal(deriveTeam({}, [members[3], members[2], { ...members[0], rank: 'first gup' }], { teamSize: 3, genderPolicy: 'single' }).captain.id, 3);
  assert.equal(deriveTeam({}, [{ ...members[0], rank: 'TTLD' }, { ...members[1], rank: 'G10' }, { ...members[2], rank: 'CDB' }], { teamSize: 3, genderPolicy: 'single' }).captain.id, 3);
  for (const change of [{ rank: 'W' }, { age: -1 }, { gender: 'Unknown' }]) {
    assert.throws(() => deriveTeam({}, [{ ...members[0], ...change }, members[1], members[2]], { teamSize: 3, genderPolicy: 'single' }));
  }
  for (const change of [{ teamSize: 0 }, { teamSize: 2.5 }, { teamSize: '3' }, { genderPolicy: 'anything' }]) {
    assert.throws(() => validateSettings({ teamSize: 3, genderPolicy: 'single', ...change }));
  }
});
test('persisted CRUD, per-discipline uniqueness, update exclusion and rollback; isolated events', async (t) => {
  const { root, store } = await fixture(t);
  assert.deepEqual((await store.load()).settings, settings());
  const first = await store.save(input());
  assert.equal(first.captain.id, 3);
  assert.equal(first.division, 'Unassigned');
  assert.equal((await store.save({ ...input(), name: 'Renamed' }, first.id)).name, 'Renamed');
  const other = await store.save(input([1, 2, 3], 'TH'));
  await assert.rejects(store.save(input()), { statusCode: 409 });
  await assert.rejects(store.save(input([1, 2, 3], 'TH'), first.id), { statusCode: 409 });
  assert.equal((await store.load()).teams.find((team) => team.id === first.id).discipline, 'TS');
  assert.equal((await createTeamStore(path.join(root, 'B', 'tournament.db')).load()).teams.length, 0);
  await store.delete(first.id);
  assert.equal((await store.load()).teams.length, 1);
  await store.delete(other.id);
  assert.equal((await store.load()).roster.length, members.length);
  await assert.rejects(store.delete(999), { statusCode: 404 });
});
test('invalid members/settings, mixed policy and noninvalidating settings enforcement', async (t) => {
  const { store } = await fixture(t);
  for (const value of [input([1, 1, 2]), input([1, 2, 999]), input(['1', 2, 3]), input([1, 2]), input([1, 2, 6]), input([1, 2, 5]), input([1, 2, 3], 'sparring'), { ...input(), name: ' ' }]) {
    await assert.rejects(store.save(value), { statusCode: 400 });
  }
  await store.saveSettings(settings({ teamSize: 3, genderPolicy: 'mixed' }));
  const mixed = await store.save(input([1, 2, 5]));
  assert.equal(mixed.gender, 'Mixed');
  await assert.rejects(store.saveSettings(settings()), { statusCode: 409 });
  await assert.rejects(store.saveSettings(settings({ teamSize: 2, genderPolicy: 'mixed' })), { statusCode: 409 });
  assert.deepEqual((await store.load()).settings, settings({ teamSize: 3, genderPolicy: 'mixed' }));
  await store.delete(mixed.id);
  await store.saveSettings(settings({ teamSize: 2, genderPolicy: 'single' }));
  await store.save(input([1, 2]));
});
test('discipline settings persist independently and validate only the matching teams', async (t) => {
  const { root, store } = await fixture(t);
  const independent = settings({ teamSize: 2, genderPolicy: 'single' }, { teamSize: 3, genderPolicy: 'mixed' });
  assert.deepEqual(await store.saveSettings(independent), independent);
  const sparring = await store.save(input([1, 2]));
  const hyung = await store.save(input([1, 2, 5], 'TH'));
  assert.equal(sparring.gender, 'Male');
  assert.equal(hyung.gender, 'Mixed');
  await assert.rejects(store.save(input([3, 5])), { statusCode: 400 });
  await assert.rejects(store.save(input([3, 4], 'TH')), { statusCode: 400 });
  await assert.rejects(store.saveSettings(settings({ teamSize: 2, genderPolicy: 'mixed' },
    { teamSize: 2, genderPolicy: 'single' })), { statusCode: 409 });
  await store.saveSettings({ TS: independent.TS });
  await assert.rejects(store.saveSettings({}), { statusCode: 400 });
  await assert.rejects(store.saveSettings({ Other: independent.TS }), { statusCode: 400 });
  await assert.rejects(store.saveSettings(settings(independent.TS, { teamSize: 0, genderPolicy: 'mixed' })), { statusCode: 400 });
  const reloaded = await createTeamStore(path.join(root, 'A', 'tournament.db')).load();
  assert.deepEqual(reloaded.settings, independent);
  assert.ok(reloaded.teams.every((team) => !team.error));
  assert.deepEqual((await createTeamStore(path.join(root, 'B', 'tournament.db')).load()).settings, settings());
});
test('legacy shared settings migrate to both disciplines without changing teams or values', async (t) => {
  const { root, store } = await fixture(t);
  await store.save(input());
  await store.save(input([1, 2, 3], 'TH'));
  const db = new sqlite3.Database(path.join(root, 'A', 'tournament.db'));
  try {
    await query(db, 'DROP TABLE team_settings');
    await query(db, 'CREATE TABLE team_settings(id INTEGER PRIMARY KEY CHECK(id=1), teamSize INTEGER NOT NULL, genderPolicy TEXT NOT NULL)');
    await query(db, "INSERT INTO team_settings VALUES (1, 3, 'mixed')");
  } finally { await new Promise((resolve) => db.close(resolve)); }
  const migrated = await store.load();
  assert.deepEqual(migrated.settings, settings({ teamSize: 3, genderPolicy: 'mixed' }, { teamSize: 3, genderPolicy: 'mixed' }));
  assert.equal(migrated.teams.length, 2);
  assert.ok(migrated.teams.every((team) => !team.error));
  await store.saveSettings(settings({ teamSize: 3, genderPolicy: 'single' }, migrated.settings.TH));
  assert.equal((await store.load()).settings.TH.genderPolicy, 'mixed');
});
test('concurrent membership claims serialize and a lock appearing before commit rolls back updates', async (t) => {
  const { root, store } = await fixture(t);
  const attempts = await Promise.allSettled([store.save(input()), store.save(input())]);
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.find((result) => result.status === 'rejected').reason.statusCode, 409);
  const original = (await store.load()).teams[0];
  let checks = 0;
  const lockedStore = createTeamStore(path.join(root, 'A', 'tournament.db'), { assertWritable: () => {
    if (++checks === 2) throw Object.assign(new Error('Configuration locked before commit'), { statusCode: 409 });
  } });
  await assert.rejects(lockedStore.save({ ...input(), name: 'Must not persist' }, original.id), { statusCode: 409 });
  assert.equal((await store.load()).teams[0].name, original.name);
  const db = new sqlite3.Database(path.join(root, 'A', 'tournament.db'));
  try {
    await query(db, 'PRAGMA foreign_keys=ON');
    await assert.rejects(query(db, 'INSERT INTO team_members VALUES (?,?,?)', [original.id, 'TH', 4]), /FOREIGN KEY/);
    await query(db, "UPDATE competitors SET rank='D10', firstName='Current name' WHERE id=1");
  } finally { await new Promise((resolve) => db.close(resolve)); }
  const updated = (await store.load()).teams[0];
  assert.equal(updated.captain.id, 1);
  assert.equal(updated.captain.firstName, 'Current name');
});
test('roster replacement is rejected with teams, FK/trigger protection and stale members reported', async (t) => {
  const { root, store } = await fixture(t);
  const team = await store.save(input());
  const csv = path.join(root, 'roster.csv');
  fs.writeFileSync(csv, 'First Name,Last Name,DOB,Association Number\nReplacement,Person,2000-01-01,TSD-002\n');
  await assert.rejects(importCSV(csv, path.join(root, 'A', 'tournament.db'), { clearExisting: true, tournamentDate: '2027-01-09' }),
    { statusCode: 409 });
  const db = new sqlite3.Database(path.join(root, 'A', 'tournament.db'));
  try {
    await assert.rejects(query(db, 'DELETE FROM competitors WHERE id=1'), /Teams exist/);
    await query(db, 'DROP TRIGGER protect_team_roster');
    await query(db, 'DELETE FROM competitors WHERE id=1');
  } finally { await new Promise((resolve) => db.close(resolve)); }
  const stale = (await store.load()).teams.find((row) => row.id === team.id);
  assert.match(stale.error, /Stale competitor IDs: 1/);
  assert.equal(stale.memberIds.length, 3);
});
test('router requires explicit scope, rejects missing DB and locks all writes; Reset Run preserves teams', async (t) => {
  const { root, store } = await fixture(t);
  const config = createEventConfigStore(root);
  const team = await store.save(input());
  const app = express();
  app.use(express.json());
  app.use('/api', createTeamRouter({ eventsRoot: root, configurationStatus: config.configurationStatus }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/teams`;
  for (const suffix of ['', '?eventName=..', '?eventName=..%2FA', '?eventName=A&eventName=B']) assert.equal((await fetch(base + suffix)).status, 400);
  assert.equal((await fetch(base + '?eventName=Missing')).status, 404);
  assert.equal((await (await fetch(base + '?eventName=B')).json()).teams.length, 0);
  fs.writeFileSync(path.join(root, 'A', 'ring-assignments.json'), JSON.stringify({ rings: {}, eventStartedAt: 'started' }));
  assert.equal((await (await fetch(base + '?eventName=A')).json()).configurationLocked, true);
  for (const [suffix, method, body] of [['', 'POST', input()], [`/${team.id}`, 'PUT', input()], [`/${team.id}`, 'DELETE'], ['/settings', 'PUT', settings()]]) {
    const response = await fetch(base + suffix + '?eventName=A', { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /locked/);
  }
  config.resetRun('A');
  assert.equal((await store.load()).teams.length, 1);
  assert.equal((await fetch(base + `/${team.id}?eventName=A`, { method: 'DELETE' })).status, 200);
});

function frontend({ requestOverride, locked = false } = {}) {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', hidden: false, disabled: false, textContent: '', innerHTML: '', handlers: {},
      addEventListener(name, callback) { this.handlers[name] = callback; }, setAttribute() {}, focus() {} });
    return nodes.get(id);
  };
  let scope = 'A';
  const requests = [];
  const data = { roster: members, settings: settings(), teams: [], configurationLocked: locked };
  const workspace = create({ document: { getElementById: get }, selectedEvent: () => scope, confirm: () => true,
    request: async (url, options) => {
      requests.push({ url, options });
      if (requestOverride) return requestOverride(url, options, data);
      if (options && options.method === 'POST') data.teams.push({ ...JSON.parse(options.body), id: 1, members: members.slice(0, 3), captain: members[2], gender: 'Male' });
      if (options && options.method === 'DELETE') data.teams = [];
      if (options && options.method === 'PUT' && url.startsWith('/api/teams/settings')) {
        const saved = JSON.parse(options.body);
        data.settings = { ...data.settings, ...saved };
        return saved;
      }
      return data;
    } });
  const select = (id) => get('tmRosterBody').handlers.change({ target: { checked: true, getAttribute: () => String(id) } });
  return { workspace, get, select, requests, data, scope: (value) => { scope = value; } };
}
test('frontend create/edit/delete, retained selections through filters, dirty form and settings guards', async () => {
  const page = frontend();
  await page.workspace.load('team-management');
  page.get('tmAdd').handlers.click();
  page.get('tmName').value = 'Manual';
  [1, 2, 3].forEach(page.select);
  assert.equal(page.workspace.dirty(), true);
  page.get('tmSearch').value = 'No matches';
  page.get('tmSearch').handlers.input();
  assert.match(page.get('tmSelected').textContent, /One A.*Two B.*Three C/);
  assert.match(page.get('tmCaptain').textContent, /Three C/);
  assert.equal(page.get('tmSave').disabled, false);
  await page.get('tmForm').handlers.submit({ preventDefault() {} });
  const post = page.requests.find((row) => row.options && row.options.method === 'POST');
  assert.deepEqual(JSON.parse(post.options.body).memberIds, [1, 2, 3]);
  assert.equal(post.url, '/api/teams?eventName=A');
  assert.equal(page.workspace.dirty(), false);
  page.get('tmTeamsBody').handlers.click({ target: { closest: () => ({ getAttribute: () => '1' }) } });
  assert.match(page.get('tmSelected').textContent, /Selected 3/);
  await page.get('tmDelete').handlers.click();
  assert.equal(page.data.teams.length, 0);
  page.get('tmSize').value = '2';
  assert.equal(page.workspace.dirty(), true);
  page.workspace.discard();
  await page.workspace.load();
  assert.equal(page.workspace.dirty(), false);
  page.scope('B');
  await page.workspace.load('team-settings');
  assert.match(page.requests.at(-1).url, /eventName=B$/);
});
test('frontend assignment exclusion, gender validation, membership changes and pagination', async () => {
  const page = frontend();
  page.data.roster = Array.from({ length: 70 }, (_, index) => ({ ...members[0], id: index + 1, firstName: `Person ${index + 1}` }));
  page.data.teams = [{ id: 9, name: 'Other discipline', discipline: 'TH', memberIds: [1, 2, 3],
    members: page.data.roster.slice(0, 3), captain: page.data.roster[0], gender: 'Male' }];
  await page.workspace.load();
  page.get('tmAdd').handlers.click();
  [1, 2, 3].forEach(page.select);
  assert.equal(page.get('tmSave').disabled, false);
  page.get('tmDiscipline').value = 'TH';
  page.get('tmDiscipline').handlers.input();
  assert.equal(page.get('tmSave').disabled, true);
  assert.match(page.get('tmRosterBody').innerHTML, /Already assigned/);
  page.get('tmRosterBody').handlers.change({ target: { checked: false, getAttribute: () => '3' } });
  assert.match(page.get('tmSelected').textContent, /Selected 2/);
  page.get('tmNext').handlers.click();
  assert.match(page.get('tmPage').textContent, /Page 2 of 3/);
  assert.doesNotMatch(page.get('tmRosterBody').innerHTML, /data-member="1"/);
  assert.match(page.get('tmSelected').textContent, /Person 1/);
  page.get('tmSearch').value = 'Person 70';
  page.get('tmSearch').handlers.input();
  assert.match(page.get('tmPage').textContent, /Page 1 of 1/);
  assert.match(page.get('tmRosterBody').innerHTML, /data-member="70"/);
});
test('frontend card saves preserve the other draft and discipline changes apply size and gender rules', async () => {
  const page = frontend();
  await page.workspace.load('team-settings');
  page.get('tmSize').value = '2';
  page.get('tmHyungPolicy').value = 'mixed';
  assert.equal(page.workspace.dirty(), true);
  await page.get('tmSettingsForm').handlers.submit({ preventDefault() {} });
  const saved = page.requests.find((row) => row.options && row.options.method === 'PUT');
  assert.deepEqual(JSON.parse(saved.options.body), { TS: { teamSize: 2, genderPolicy: 'single' } });
  assert.equal(page.data.settings.TH.genderPolicy, 'single');
  assert.equal(page.get('tmHyungPolicy').value, 'mixed');
  assert.equal(page.workspace.dirty(), true);
  assert.match(page.get('tmSettingsNotice').textContent, /Team Sparring settings saved/);
  await page.get('tmHyungSettingsForm').handlers.submit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(page.requests.at(-1).options.body), { TH: { teamSize: 3, genderPolicy: 'mixed' } });
  assert.equal(page.workspace.dirty(), false);
  assert.equal(page.get('tmHyungSize').value, 3);
  assert.equal(Number(page.get('tmSize').value), 2);
  page.get('tmAdd').handlers.click();
  [1, 5].forEach(page.select);
  assert.match(page.get('tmSelected').textContent, /Selected 2 \/ 2/);
  assert.equal(page.get('tmSave').disabled, true);
  page.get('tmDiscipline').value = 'TH';
  page.get('tmDiscipline').handlers.input();
  assert.match(page.get('tmSelected').textContent, /Selected 2 \/ 3/);
  assert.equal(page.get('tmSave').disabled, true);
  page.select(2);
  assert.equal(page.get('tmSave').disabled, false);
});
test('frontend loading failures, locks, late scoped responses and settings errors do not report success', async () => {
  const locked = frontend({ locked: true });
  await locked.workspace.load();
  assert.equal(locked.get('tmAdd').disabled, true);
  assert.match(locked.get('tmLock').textContent, /reset the run/);
  const failing = frontend({ requestOverride: async (_url, options, data) => {
    if (options) throw new Error('Settings would invalidate existing teams');
    return data;
  } });
  await failing.workspace.load('team-settings');
  failing.get('tmSize').value = '2';
  await failing.get('tmSettingsForm').handlers.submit({ preventDefault() {} });
  assert.match(failing.get('tmSettingsNotice').textContent, /invalidate/);
  assert.equal(failing.workspace.dirty(), true);
  let release;
  const late = frontend({ requestOverride: () => new Promise((resolve) => { release = resolve; }) });
  const loading = late.workspace.load();
  late.scope('');
  await late.workspace.load();
  release({ ...late.data, teams: [{ id: 9, name: 'Wrong scope' }] });
  await loading;
  assert.doesNotMatch(late.get('tmTeamsBody').innerHTML, /Wrong scope/);
  assert.equal(late.get('tmAdd').disabled, true);
  const error = frontend({ requestOverride: async () => { throw new Error('Roster unavailable'); } });
  await error.workspace.load();
  assert.match(error.get('tmNotice').textContent, /Roster unavailable/);
  assert.equal(error.get('tmAdd').disabled, true);
});
