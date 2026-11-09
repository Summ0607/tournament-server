const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { initializeJudgeDatabase, verifyJudgeDatabase } = require('../db/judgeManagement');

function open(file) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, sqlite3.OPEN_READWRITE, (error) => error ? reject(error) : resolve(db));
  });
}
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (error) => error ? reject(error) : resolve()));
}
function get(db, sql) {
  return new Promise((resolve, reject) => db.get(sql, (error, row) => error ? reject(error) : resolve(row)));
}
function close(db) {
  return new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
}
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-database-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'judges.db');
}

test('standalone judge database initializes safely and enforces member IDs and shared codes', async (t) => {
  const file = temporary(t);
  await Promise.all([initializeJudgeDatabase(file), initializeJudgeDatabase(file)]);
  const db = await open(file);
  try {
    assert.equal((await get(db, 'PRAGMA user_version')).user_version, 4);
    const judgeColumns = await new Promise((resolve, reject) =>
      db.all('PRAGMA table_info(judges)', (error, rows) => error ? reject(error) : resolve(rows)));
    assert.ok(judgeColumns.some((column) => column.name === 'date_of_birth'));
    await run(db, `INSERT INTO judges (association_id, first_name, last_name, rank, certification)
      VALUES ('TSD-001', 'First', 'Last', 'D1', 'CORNER')`);
    await assert.rejects(run(db, "INSERT INTO judges (association_id, first_name, last_name) VALUES ('tsd-001', 'Other', 'Judge')"), /UNIQUE/);
    for (const id of ['', ' ', ' padded ']) {
      await assert.rejects(run(db, "INSERT INTO judges (association_id, first_name, last_name) VALUES (?, 'First', 'Last')", [id]), /CHECK/);
    }
    await assert.rejects(run(db, "INSERT INTO judges (first_name, last_name) VALUES ('First', 'Last')"), /NOT NULL/);
    await assert.rejects(run(db, "INSERT INTO judges (association_id, first_name, last_name, rank) VALUES ('2', 'First', 'Last', 'G10')"), /CHECK/);
    await assert.rejects(run(db, "INSERT INTO judges (association_id, first_name, last_name, certification) VALUES ('2', 'First', 'Last', 'INVALID')"), /CHECK/);
    assert.equal((await get(db, 'SELECT count(*) AS count FROM judges')).count, 1);
  } finally { await close(db); }
  await initializeJudgeDatabase(file);
  await verifyJudgeDatabase(file);
  const reopened = await open(file);
  try { assert.equal((await get(reopened, 'SELECT count(*) AS count FROM judges')).count, 1); }
  finally { await close(reopened); }
});

test('backup copy verifies and unrecognized or missing databases are rejected', async (t) => {
  const file = temporary(t);
  await initializeJudgeDatabase(file);
  const original = await open(file);
  try { await run(original, "INSERT INTO judges (association_id, first_name, last_name) VALUES ('ID1', 'First', 'Last')"); }
  finally { await close(original); }
  const backup = path.join(path.dirname(file), 'backup.db');
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  await verifyJudgeDatabase(backup);
  const changed = await open(file);
  try { await run(changed, "DELETE FROM judges"); } finally { await close(changed); }
  const safety = path.join(path.dirname(file), 'before-restore.db');
  fs.renameSync(file, safety);
  fs.copyFileSync(backup, file, fs.constants.COPYFILE_EXCL);
  await verifyJudgeDatabase(file);
  const restored = await open(file);
  try { assert.equal((await get(restored, 'SELECT count(*) AS count FROM judges')).count, 1); }
  finally { await close(restored); }
  await assert.rejects(verifyJudgeDatabase(path.join(path.dirname(file), 'missing.db')), /SQLITE_CANTOPEN/);
  const foreign = path.join(path.dirname(file), 'foreign.db');
  fs.writeFileSync(foreign, 'not a sqlite database');
  await assert.rejects(initializeJudgeDatabase(foreign));
  await assert.rejects(verifyJudgeDatabase(foreign));
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'not a sqlite database');
  const db = await open(file);
  try { await run(db, 'DROP TABLE judges'); } finally { await close(db); }
  await assert.rejects(initializeJudgeDatabase(file), /missing the judges table/);
  await assert.rejects(verifyJudgeDatabase(file), /missing the judges table/);
});

test('version 1 backups remain verifiable and upgrade without losing judge data', async (t) => {
  const file = temporary(t);
  await initializeJudgeDatabase(file);
  const db = await open(file);
  try {
    await run(db, "INSERT INTO judges (association_id, first_name, last_name) VALUES ('ID1', 'First', 'Last')");
    await run(db, 'DROP TABLE judge_management_settings');
    await run(db, 'PRAGMA user_version = 1');
  } finally { await close(db); }
  await verifyJudgeDatabase(file);
  await initializeJudgeDatabase(file);
  await verifyJudgeDatabase(file);
  const upgraded = await open(file);
  try { assert.equal((await get(upgraded, 'SELECT count(*) AS count FROM judges')).count, 1); }
  finally { await close(upgraded); }
});
