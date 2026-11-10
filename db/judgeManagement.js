const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { JUDGE_RANKS, certificationLevels } = require('./judgeCertification');

const APPLICATION_ID = 0x4a4d4744;
const SCHEMA_VERSION = 5;
const DEFAULT_JUDGE_DATABASE = path.join(__dirname, '..', 'judge-management-data', 'judges.db');

function open(file, flags) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, flags, (error) => error ? reject(error) : resolve(db));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (error) => error ? reject(error) : resolve()));
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
}

function close(db) {
  return new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
}

function sqlValues(values) {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(', ');
}

async function initializeJudgeDatabase(file = DEFAULT_JUDGE_DATABASE) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('An absolute judge database path is required.');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = await open(file, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
  db.configure('busyTimeout', 5000);
  try {
    await run(db, 'BEGIN IMMEDIATE');
    try {
      const { application_id: applicationId } = await get(db, 'PRAGMA application_id');
      const { user_version: version } = await get(db, 'PRAGMA user_version');
      const hasTable = async (name) => Boolean(await get(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]));
      const hasColumn = async (table, name) => (await new Promise((resolve, reject) =>
        db.all(`PRAGMA table_info(${table})`, (error, rows) => error ? reject(error) : resolve(rows)))).some((column) => column.name === name);
      if (applicationId !== 0 && applicationId !== APPLICATION_ID) throw new Error('Not a Judge Management database.');
      if (version > SCHEMA_VERSION) throw new Error('Judge Management database requires a newer server version.');
      if (applicationId === 0) {
        const { count } = await get(db, "SELECT count(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'");
        if (version !== 0 || count !== 0) throw new Error('Cannot initialize a nonempty unrecognized database.');
        await run(db, `PRAGMA application_id = ${APPLICATION_ID}`);
      }
      if (version === 0) {
        await run(db, `CREATE TABLE judges (
          id INTEGER PRIMARY KEY,
          association_id TEXT NOT NULL COLLATE NOCASE UNIQUE
            CHECK (length(trim(association_id)) > 0 AND association_id = trim(association_id)),
          first_name TEXT NOT NULL CHECK (length(trim(first_name)) > 0),
          last_name TEXT NOT NULL CHECK (length(trim(last_name)) > 0),
          school TEXT NOT NULL DEFAULT '',
          rank TEXT CHECK (rank IS NULL OR rank IN (${sqlValues(JUDGE_RANKS)})),
          certification TEXT NOT NULL DEFAULT 'UNKNOWN'
            CHECK (certification IN (${sqlValues(certificationLevels().map((level) => level.code))})),
          certification_expiration TEXT,
          status TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT ''
        )`);
      }
      if (version < 2) {
        if (!await hasTable('judge_management_settings')) await run(db, `CREATE TABLE judge_management_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          revision INTEGER NOT NULL DEFAULT 0,
          aliases TEXT NOT NULL DEFAULT '{}'
        )`);
        await run(db, "INSERT OR IGNORE INTO judge_management_settings (id) VALUES (1)");
      }
      if (version < 3) {
        if (!await hasColumn('judges', 'certification_granted_at')) await run(db, 'ALTER TABLE judges ADD COLUMN certification_granted_at TEXT');
        if (!await hasTable('judge_test_attempts')) await run(db, `CREATE TABLE judge_test_attempts (
          id INTEGER PRIMARY KEY,
          judge_id INTEGER NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
          target_level TEXT NOT NULL CHECK (target_level IN (${sqlValues(certificationLevels().filter((level) => !['UNKNOWN', 'UNCERTIFIED'].includes(level.code)).map((level) => level.code))})),
          written_date TEXT,
          written_score INTEGER CHECK (written_score IS NULL OR written_score BETWEEN 0 AND 100),
          practical_date TEXT,
          practical_passed INTEGER CHECK (practical_passed IS NULL OR practical_passed IN (0, 1)),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          CHECK (written_date IS NOT NULL OR practical_date IS NOT NULL)
        )`);
        if (!await hasTable('judge_experience')) await run(db, `CREATE TABLE judge_experience (
          id INTEGER PRIMARY KEY,
          judge_id INTEGER NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
          event_name TEXT NOT NULL CHECK (length(trim(event_name)) > 0),
          event_date TEXT NOT NULL,
          location TEXT NOT NULL DEFAULT '',
          role TEXT NOT NULL CHECK (role IN ('JUDGE', 'CORNER_JUDGE', 'CENTER_JUDGE', 'SCOREKEEPER', 'TIMEKEEPER', 'ARBITRATOR')),
          event_scope TEXT NOT NULL CHECK (event_scope IN ('REGIONAL', 'NATIONAL', 'WORLD', 'IN_HOUSE')),
          log_verified INTEGER NOT NULL DEFAULT 0 CHECK (log_verified IN (0, 1)),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (judge_id, event_name COLLATE NOCASE, event_date, role)
        )`);
        await run(db, 'CREATE INDEX IF NOT EXISTS idx_judge_tests_judge ON judge_test_attempts(judge_id, target_level, written_date, practical_date)');
        await run(db, 'CREATE INDEX IF NOT EXISTS idx_judge_experience_judge ON judge_experience(judge_id, event_date)');
      }
      if (version < 4 && !await hasColumn('judges', 'date_of_birth')) await run(db, 'ALTER TABLE judges ADD COLUMN date_of_birth TEXT');
      if (version < 5) {
        await run(db, `ALTER TABLE judge_experience RENAME TO judge_experience_previous`);
        await run(db, `CREATE TABLE judge_experience (
          id INTEGER PRIMARY KEY,
          judge_id INTEGER NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
          event_name TEXT NOT NULL CHECK (length(trim(event_name)) > 0),
          event_date TEXT NOT NULL, location TEXT NOT NULL DEFAULT '',
          role TEXT NOT NULL CHECK (role IN ('JUDGE','CORNER_JUDGE','CENTER_JUDGE','SCOREKEEPER','TIMEKEEPER','ARBITRATOR')),
          event_scope TEXT NOT NULL CHECK (event_scope IN ('REGIONAL','NATIONAL','WORLD','IN_HOUSE')),
          log_verified INTEGER NOT NULL DEFAULT 0 CHECK (log_verified IN (0,1)),
          event_id TEXT NOT NULL CHECK (length(trim(event_id)) > 0), phase TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','SIMULATION','TOURNAMENT')),
          source_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(judge_id, source_id),
          UNIQUE(judge_id, event_id, role, phase)
        )`);
        await run(db, `INSERT INTO judge_experience
          (id,judge_id,event_name,event_date,location,role,event_scope,log_verified,event_id,created_at)
          SELECT id,judge_id,event_name,event_date,location,role,event_scope,log_verified,
          'legacy:' || lower(trim(event_name)) || ':' || event_date,created_at FROM judge_experience_previous`);
        await run(db, 'DROP TABLE judge_experience_previous');
        await run(db, 'CREATE INDEX idx_judge_experience_judge ON judge_experience(judge_id,event_date)');
      }
      if (version < SCHEMA_VERSION) await run(db, `PRAGMA user_version = ${SCHEMA_VERSION}`);
      await run(db, 'COMMIT');
    } catch (error) {
      try { await run(db, 'ROLLBACK'); }
      catch (rollbackError) { console.error('Unable to roll back Judge Management database initialization:', rollbackError); }
      throw error;
    }
  } finally {
    await close(db);
  }
  await verifyJudgeDatabase(file);
}

async function verifyJudgeDatabase(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('An absolute judge database path is required.');
  const db = await open(file, sqlite3.OPEN_READONLY);
  try {
    const { application_id: applicationId } = await get(db, 'PRAGMA application_id');
    const { user_version: version } = await get(db, 'PRAGMA user_version');
    if (applicationId !== APPLICATION_ID || version < 1 || version > SCHEMA_VERSION) throw new Error('Unrecognized Judge Management database or schema version.');
    const result = await get(db, 'PRAGMA integrity_check');
    if (!result || result.integrity_check !== 'ok') throw new Error(`Judge Management database integrity check failed: ${result?.integrity_check || 'no result'}`);
    const table = await get(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'judges'");
    if (!table) throw new Error('Judge Management database is missing the judges table.');
    if (version >= 2) {
      const settings = await get(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'judge_management_settings'");
      if (!settings) throw new Error('Judge Management database is missing its settings table.');
    }
    if (version >= 3) {
      for (const tableName of ['judge_test_attempts', 'judge_experience']) {
        const table = await get(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [tableName]);
        if (!table) throw new Error(`Judge Management database is missing ${tableName}.`);
      }
      if (version >= 4) {
        const columns = await new Promise((resolve, reject) =>
          db.all('PRAGMA table_info(judges)', (error, rows) => error ? reject(error) : resolve(rows)));
        if (!columns.some((column) => column.name === 'date_of_birth')) throw new Error('Judge Management database is missing the private date-of-birth field.');
      }
      if (version >= 5) {
        const columns = await new Promise((resolve, reject) =>
          db.all('PRAGMA table_info(judge_experience)', (error, rows) => error ? reject(error) : resolve(rows)));
        for (const name of ['event_id', 'phase', 'source', 'source_id']) {
          if (!columns.some((column) => column.name === name)) throw new Error(`Judge Management experience is missing ${name}.`);
        }
      }
    }
  } finally {
    await close(db);
  }
}

module.exports = { DEFAULT_JUDGE_DATABASE, initializeJudgeDatabase, verifyJudgeDatabase };
