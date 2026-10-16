const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { createCompetitorStore } = require('../backend/competitorStore');

async function createFixture(t, rows) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'competitor-save-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, 'tournament.db');
  const db = await new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(dbPath, error => {
      if (error) reject(error);
      else resolve(connection);
    });
  });
  const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, error => error ? reject(error) : resolve());
  });
  try {
    await run(`CREATE TABLE competitors (
      id INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT, dob TEXT,
      associationNumber TEXT, email TEXT, rank TEXT,
      weaponsDivision TEXT, hyungsDivision TEXT, sparringDivision TEXT,
      groupDivisionNumber INTEGER, competitionDivisionNumber INTEGER
    )`);
    for (const row of rows) {
      await run(`INSERT INTO competitors (
        id, firstName, lastName, dob, associationNumber, email, rank,
        weaponsDivision, hyungsDivision, sparringDivision,
        groupDivisionNumber, competitionDivisionNumber
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unassigned', '90', '91', 90, 90)`,
      [row.id, row.firstName || '', row.lastName || '', row.dob || '',
        row.associationNumber || '', row.email || '', row.rank || 'W']);
    }
  } finally {
    await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
  }
  return createCompetitorStore(dbPath);
}

function group(competitors) {
  return { groupId: 'review-group', name: 'Reviewed division', competitors };
}

test('save remaps stale IDs by association number and persists all divisions', async t => {
  const store = await createFixture(t, [
    { id: 101, associationNumber: 'A001', rank: 'G1' },
    { id: 102, associationNumber: 'A002' }
  ]);
  const result = await store.saveDivisionAssignments([group([
    { id: '1', associationNumber: ' a001 ', rank: 'G1' },
    { id: '2', associationNumber: 'A002', rank: 'W' }
  ])]);
  assert.equal(result.updatedCompetitors, 2);
  assert.deepEqual(result.groups[0].competitors.map(c => c.id), ['101', '102']);
  const rows = await store.loadCompetitors();
  assert.deepEqual(rows.map(row => row.groupDivisionNumber), [20, 20]);
  assert.deepEqual(rows.map(row => row.competitionDivisionNumber), [21, 21]);
  assert.deepEqual(rows.map(row => row.weaponsDivision), ['20', 'unassigned']);
  assert.deepEqual(rows.map(row => row.hyungsDivision), ['21', '21']);
  assert.deepEqual(rows.map(row => row.sparringDivision), ['22', '22']);
});

test('identity matching takes precedence over a stale ID reused by another competitor', async t => {
  const store = await createFixture(t, [
    { id: 1, firstName: 'Different', lastName: 'Person', dob: '2000-01-01' },
    { id: 101, firstName: 'Pat', lastName: 'Smith', dob: '2010-02-03' }
  ]);
  const result = await store.saveDivisionAssignments([group([
    { id: '1', firstName: ' pat ', lastName: 'SMITH', dobIso: '2010-02-03', rank: 'W' }
  ])]);
  assert.equal(result.groups[0].competitors[0].id, '101');
  const rows = await store.loadCompetitors();
  assert.equal(rows.find(row => row.id === 1).groupDivisionNumber, null);
  assert.equal(rows.find(row => row.id === 101).groupDivisionNumber, 20);
});

test('save still accepts current numeric IDs without identity fields', async t => {
  const store = await createFixture(t, [{ id: 101 }]);
  const result = await store.saveDivisionAssignments([group([{ id: '101', rank: 'W' }])]);
  assert.equal(result.updatedCompetitors, 1);
  assert.equal((await store.loadCompetitors())[0].groupDivisionNumber, 20);
});

test('save can resolve a stale ID using a unique email', async t => {
  const store = await createFixture(t, [{ id: 101, email: 'pat@example.test' }]);
  const result = await store.saveDivisionAssignments([group([
    { id: '1', email: ' PAT@example.test ', rank: 'W' }
  ])]);
  assert.equal(result.groups[0].competitors[0].id, '101');
});

test('shared email cannot silently assign a division to the wrong competitor', async t => {
  const store = await createFixture(t, [
    { id: 101, email: 'family@example.test' },
    { id: 102, email: 'family@example.test' }
  ]);
  await assert.rejects(store.saveDivisionAssignments([group([
    { id: '1', email: 'family@example.test', rank: 'W' }
  ])]), /Cannot uniquely match competitor/);
  assert.deepEqual((await store.loadCompetitors()).map(row => row.groupDivisionNumber), [90, 90]);
});

test('an unmatched competitor rolls back earlier writes and preserves existing assignments', async t => {
  const store = await createFixture(t, [{ id: 101, associationNumber: 'A001' }]);
  await assert.rejects(store.saveDivisionAssignments([group([
    { id: '1', associationNumber: 'A001', rank: 'W' },
    { id: '999', associationNumber: 'MISSING', rank: 'W' }
  ])]), /Cannot uniquely match competitor 999/);
  const rows = await store.loadCompetitors();
  assert.equal(rows[0].groupDivisionNumber, 90);
  assert.equal(rows[0].hyungsDivision, '90');
  assert.equal(rows[0].sparringDivision, '91');
});
