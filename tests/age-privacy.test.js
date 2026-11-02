const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const sqlite3 = require('sqlite3');
const initialize = require('../db/init');
const importCSV = require('../db/import-csv');
const { ageOnDate, storedAge, lockAgeDate, assertNoBirthDates } = require('../backend/tournamentAge');
const { writeJsonAtomicSync } = require('../backend/atomicJsonFile');
const { createSimulatorRunStore } = require('../backend/simulatorRunStore');
const { createEventConfigStore } = require('../backend/eventConfig');
async function database(file, callback) {
  const db = new sqlite3.Database(file);
  const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, (e) => e ? reject(e) : resolve()));
  const all = (sql) => new Promise((resolve, reject) => db.all(sql, (e, rows) => e ? reject(e) : resolve(rows)));
  try { return await callback(run, all); }
  finally { await new Promise((resolve, reject) => db.close((e) => e ? reject(e) : resolve())); }
}
test('age conversion validates real dates and stores tournament age only', () => {
  assert.equal(ageOnDate('01/10/2009', '2027-01-09'), 17);
  assert.equal(ageOnDate('2009-01-09', '2027-01-09'), 18);
  assert.throws(() => ageOnDate('2000-02-30', '2027-01-09'));
  assert.throws(() => ageOnDate('2000-01-01', '2027-02-30'));
  assert.throws(() => storedAge({ age: 18, ageAsOf: '2027-01-09' }, '2027-01-10'), /stale/);
  assert.throws(() => assertNoBirthDates({ nested: [{ DOB: '2000-01-09' }] }), /cannot be saved/);
});
test('competitor import retains age/date but no DOB, and invalid rows preserve the saved roster', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'age-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = path.join(root, 'tournament.db'), csv = path.join(root, 'input.csv');
  await initialize(db);
  assert.throws(() => writeJsonAtomicSync(path.join(root, 'bad.json'), { dob: '2000-01-09' }), /cannot be saved/);
  assert.equal(fs.existsSync(path.join(root, 'bad.json')), false);
  fs.writeFileSync(csv, 'First Name,Last Name,DOB,Current Rank\nTest,Person,2000-01-09,D1');
  await assert.rejects(importCSV(csv, db), /date/);
  const result = await importCSV(csv, db, { tournamentDate: '2027-01-09' });
  assert.equal(result.normalizedCompetitors[0].age, 27);
  assert.equal(Object.hasOwn(result.normalizedCompetitors[0], 'dob'), false);
  await database(db, async (_run, all) => {
    assert.equal((await all('PRAGMA table_info(competitors)')).some((r) => r.name === 'dob'), false);
    assert.equal((await all('SELECT * FROM competitors'))[0].ageAsOf, '2027-01-09');
  });
  fs.writeFileSync(csv, 'First Name,Last Name,DOB,Current Rank\nTest,Person,2000-01-09,D1\nBad,Date,broken,D1');
  await assert.rejects(importCSV(csv, db, { clearExisting: true, tournamentDate: '2027-01-09' }), /CSV row 3/);
  await database(db, async (_run, all) => assert.equal((await all('SELECT * FROM competitors')).length, 1));
});
test('new simulation snapshots preserve tournament date and reject stale ages or birth dates', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'age-simulation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createSimulatorRunStore({ runsRoot: root });
  const input = {
    eventName: 'Test', tournamentDate: '2027-01-09',
    groups: [{ groupDivisionNumber: 1, competitors: [{ id: '1', age: 18, ageAsOf: '2027-01-09' }] }],
    assignments: { config: { letterCount: 1, numberCount: 1 }, rings: {} }
  };
  assert.equal(store.createRun(input).tournamentDate, '2027-01-09');
  assert.throws(() => store.createRun({ ...input, tournamentDate: '2028-01-09' }), /stale/);
  input.groups[0].competitors[0].dob = '2009-01-09';
  assert.throws(() => store.createRun(input), /cannot be saved/);
  assert.equal(fs.readdirSync(root).length, 1);
});
test('saving tournament ages locks the event date', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'age-date-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const event = path.join(root, 'events', 'Test');
  fs.mkdirSync(event, { recursive: true });
  const store = createEventConfigStore(path.join(root, 'events'));
  store.writeEventConfig('Test', { date: '2027-01-09', ringConfigX: 1, ringConfigY: 1 });
  lockAgeDate(event, '2027-01-09');
  assert.throws(() => store.writeEventConfig('Test', { date: '2027-01-10' }), /date is fixed/);
  assert.equal(store.configurationStatus('Test').ageDateLocked, true);
});
