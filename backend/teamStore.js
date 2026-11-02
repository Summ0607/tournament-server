const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { normalizeRank } = require('../db/rankNormalization');
const { ageOf } = require('../assets/division-rules');
const { compareCaptains } = require('../assets/team-rules');

const DEFAULT_SETTINGS = Object.freeze({ teamSize: 3, genderPolicy: 'single' });
function fail(message, statusCode = 400) {
  throw Object.assign(new Error(message), { statusCode });
}
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function (error) {
    error ? reject(error) : resolve(this);
  }));
}
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
}
function validateSettings(settings) {
  if (!settings || !Number.isSafeInteger(settings.teamSize) || settings.teamSize < 1 || settings.teamSize > 50 ||
      !['single', 'mixed'].includes(settings.genderPolicy)) {
    fail('Team size must be a whole number from 1 to 50; gender policy must be single or mixed.');
  }
  return { teamSize: settings.teamSize, genderPolicy: settings.genderPolicy };
}
function validateDisciplineSettings(settings) {
  if (!settings || typeof settings !== 'object' || !Object.keys(settings).length ||
      Object.keys(settings).some((key) => !['TS', 'TH'].includes(key))) fail('Provide TS and/or TH settings.');
  return Object.fromEntries(Object.entries(settings).map(([discipline, rules]) => [discipline, validateSettings(rules)]));
}
function deriveTeam(team, members, settings) {
  if (members.length !== settings.teamSize) fail(`Teams require exactly ${settings.teamSize} members.`);
  const prepared = members.map((member) => {
    const rank = normalizeRank(member.rank);
    if (!rank.recognized) fail(`Competitor ${member.id} has an unknown rank. Correct the roster before selecting this member.`);
    const gender = String(member.gender || '').trim().toLowerCase();
    if (!['male', 'female'].includes(gender)) fail(`Competitor ${member.id} has an unknown gender. Correct the roster first.`);
    const age = ageOf(member);
    if (!Number.isInteger(age) || age < 0 || age > 120) fail(`Competitor ${member.id} has an invalid age/date of birth.`);
    return { ...member, rank: rank.code, age, gender: gender === 'male' ? 'Male' : 'Female' };
  });
  const genders = new Set(prepared.map((member) => member.gender));
  if (settings.genderPolicy === 'single' && genders.size !== 1) fail('This discipline requires single-gender teams.');
  const captain = [...prepared].sort(compareCaptains)[0];
  return { ...team, members: prepared, memberIds: prepared.map((member) => member.id),
    captain, gender: genders.size === 1 ? prepared[0].gender : 'Mixed', division: 'Unassigned' };
}

function createTeamStore(dbFilePath, { assertWritable = () => {} } = {}) {
  async function access(callback, write = false) {
    if (!dbFilePath || !fs.existsSync(dbFilePath)) fail('Selected tournament database not found.', 404);
    const db = await new Promise((resolve, reject) => {
      const connection = new sqlite3.Database(dbFilePath, sqlite3.OPEN_READWRITE, (error) =>
        error ? reject(error) : resolve(connection));
    });
    let transaction = false;
    try {
      await run(db, 'PRAGMA busy_timeout = 5000');
      await run(db, 'PRAGMA foreign_keys = ON');
      await run(db, 'BEGIN IMMEDIATE');
      transaction = true;
      if (!(await all(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='competitors'")).length) {
        fail('Selected tournament roster is not initialized.', 409);
      }
      await run(db, `CREATE TABLE IF NOT EXISTS teams (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
        discipline TEXT NOT NULL CHECK(discipline IN ('TS','TH')), UNIQUE(id, discipline))`);
      await run(db, `CREATE TABLE IF NOT EXISTS team_members (
        teamId INTEGER NOT NULL, discipline TEXT NOT NULL, competitorId INTEGER NOT NULL,
        PRIMARY KEY(teamId, competitorId), UNIQUE(discipline, competitorId),
        FOREIGN KEY(teamId, discipline) REFERENCES teams(id, discipline) ON DELETE CASCADE,
        FOREIGN KEY(competitorId) REFERENCES competitors(id) ON DELETE RESTRICT)`);
      const settingsColumns = await all(db, 'PRAGMA table_info(team_settings)');
      if (settingsColumns.some((column) => column.name === 'id')) {
        await run(db, 'ALTER TABLE team_settings RENAME TO legacy_team_settings');
      }
      await run(db, `CREATE TABLE IF NOT EXISTS team_settings (
        discipline TEXT PRIMARY KEY CHECK(discipline IN ('TS','TH')), teamSize INTEGER NOT NULL CHECK(teamSize BETWEEN 1 AND 50),
        genderPolicy TEXT NOT NULL CHECK(genderPolicy IN ('single','mixed')))`);
      if (settingsColumns.some((column) => column.name === 'id')) {
        for (const discipline of ['TS', 'TH']) {
          await run(db, 'INSERT INTO team_settings SELECT ?, teamSize, genderPolicy FROM legacy_team_settings WHERE id=1', [discipline]);
        }
        await run(db, 'DROP TABLE legacy_team_settings');
      }
      for (const discipline of ['TS', 'TH']) {
        await run(db, "INSERT OR IGNORE INTO team_settings VALUES (?, 3, 'single')", [discipline]);
      }
      // Protect roster replacement even when another SQLite connection does not enable foreign keys.
      await run(db, `CREATE TRIGGER IF NOT EXISTS protect_team_roster BEFORE DELETE ON competitors
        WHEN EXISTS (SELECT 1 FROM team_members WHERE competitorId = OLD.id)
        BEGIN SELECT RAISE(ABORT, 'Teams exist. Delete all teams before replacing the competitor roster.'); END`);
      if (write) assertWritable();
      const result = await callback(db);
      if (write) assertWritable();
      await run(db, 'COMMIT');
      transaction = false;
      return result;
    } catch (error) {
      if (transaction) await run(db, 'ROLLBACK');
      if (String(error.code).startsWith('SQLITE_CONSTRAINT') && !error.statusCode) {
        error.statusCode = 409;
        error.message = 'A competitor already belongs to another team in this discipline, or the roster changed. Reload and review members.';
      }
      throw error;
    } finally {
      await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
    }
  }
  async function snapshot(db, override) {
    const settings = override || Object.fromEntries((await all(db, 'SELECT * FROM team_settings'))
      .map(({ discipline, teamSize, genderPolicy }) => [discipline, { teamSize, genderPolicy }]));
    const roster = (await all(db, 'SELECT * FROM competitors ORDER BY lastName, firstName, id'))
      .map((member) => ({ ...member, rank: normalizeRank(member.rank).code, age: ageOf(member) }));
    const lookup = new Map(roster.map((row) => [row.id, row]));
    const memberships = await all(db, 'SELECT * FROM team_members ORDER BY competitorId');
    const teams = (await all(db, 'SELECT * FROM teams ORDER BY name, id')).map((team) => {
      const ids = memberships.filter((row) => row.teamId === team.id).map((row) => row.competitorId);
      try {
        if (ids.some((id) => !lookup.has(id))) fail(`Stale competitor IDs: ${ids.filter((id) => !lookup.has(id)).join(', ')}`);
        return deriveTeam(team, ids.map((id) => lookup.get(id)), settings[team.discipline]);
      } catch (error) {
        return { ...team, memberIds: ids, members: ids.map((id) => lookup.get(id) || { id, firstName: 'Missing competitor' }),
          captain: null, gender: 'Unknown', division: 'Unassigned', error: error.message };
      }
    });
    return { settings, roster, teams };
  }
  return {
    load: () => access((db) => snapshot(db)),
    save: (input, teamId) => access(async (db) => {
      if (teamId !== undefined && (!Number.isSafeInteger(teamId) || teamId < 1)) fail('Invalid team ID.');
      if (teamId !== undefined && !(await all(db, 'SELECT id FROM teams WHERE id=?', [teamId])).length) fail('Team not found.', 404);
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name || name.length > 100) fail('Team name is required and must be at most 100 characters.');
      if (!['TS', 'TH'].includes(input.discipline)) fail('Discipline must be TS (Team Sparring) or TH (Team Hyung).');
      const ids = input.memberIds;
      if (!Array.isArray(ids) || ids.some((id) => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) {
        fail('Select distinct, valid registered competitor IDs.');
      }
      const data = await snapshot(db);
      const members = ids.map((id) => data.roster.find((row) => row.id === id));
      if (members.some((member) => !member)) fail('One or more selected competitors are not registered in this tournament.');
      deriveTeam({ name, discipline: input.discipline }, members, data.settings[input.discipline]);
      if (teamId === undefined) teamId = (await run(db, 'INSERT INTO teams(name, discipline) VALUES (?,?)', [name, input.discipline])).lastID;
      else {
        await run(db, 'DELETE FROM team_members WHERE teamId=?', [teamId]);
        await run(db, 'UPDATE teams SET name=?, discipline=? WHERE id=?', [name, input.discipline, teamId]);
      }
      for (const id of ids) await run(db, 'INSERT INTO team_members VALUES (?,?,?)', [teamId, input.discipline, id]);
      return (await snapshot(db)).teams.find((team) => team.id === teamId);
    }, true),
    delete: (teamId) => access(async (db) => {
      if (!Number.isSafeInteger(teamId) || teamId < 1) fail('Invalid team ID.');
      if (!(await run(db, 'DELETE FROM teams WHERE id=?', [teamId])).changes) fail('Team not found.', 404);
      return { ok: true };
    }, true),
    saveSettings: (input) => access(async (db) => {
      const settings = validateDisciplineSettings(input);
      const current = await snapshot(db);
      const data = await snapshot(db, { ...current.settings, ...settings });
      const invalid = data.teams.find((team) => team.error);
      if (invalid) fail(`Settings would invalidate team "${invalid.name}": ${invalid.error} Edit or delete existing teams first.`, 409);
      for (const discipline of Object.keys(settings)) {
        await run(db, 'UPDATE team_settings SET teamSize=?, genderPolicy=? WHERE discipline=?',
          [settings[discipline].teamSize, settings[discipline].genderPolicy, discipline]);
      }
      return settings;
    }, true)
  };
}
module.exports = { createTeamStore, DEFAULT_SETTINGS, validateSettings, deriveTeam };
