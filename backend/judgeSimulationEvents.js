const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sqlite3 = require('sqlite3');
const initializeDatabase = require('../db/init');
const { createEventConfigStore } = require('./eventConfig');
const { resolveMemberPerson } = require('./eventPeople');
const { ageOnDate, validDate, lockAgeDate, assertNoBirthDates } = require('./tournamentAge');
const { validateVolunteer } = require('./volunteerRoutes');

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const all = (db, sql, args = []) => new Promise((resolve, reject) => db.all(sql, args, (error, rows) => error ? reject(error) : resolve(rows)));
const run = (db, sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, (error) => error ? reject(error) : resolve()));
async function database(file, mode, action) {
  const db = await new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(file, mode, (error) => error ? reject(error) : resolve(connection));
  });
  try { db.configure('busyTimeout', 5000); return await action(db); }
  finally { await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve())); }
}
function createSimulationEventRouter({ directory }) {
  const router = express.Router();
  const eventsRoot = path.join(directory, 'events');
  fs.mkdirSync(eventsRoot, { recursive: true });
  const judgeFile = path.join(directory, 'judges.db');
  const { readEventConfig, writeEventConfig, configurationStatus } = createEventConfigStore(eventsRoot);
  const nameOf = (value) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}$/.test(value) || value !== value.trim() ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value)) fail('Use an event name of 1-80 letters, numbers, spaces, underscores or hyphens.');
    return value;
  };
  const event = (name) => {
    name = nameOf(name);
    const file = path.join(eventsRoot, name, 'tournament.db');
    if (!fs.existsSync(file)) fail('Isolated event not found.', 404);
    return { name, file, config: readEventConfig(name) };
  };
  const handle = (action) => async (req, res) => {
    try { res.json(await action(req)); }
    catch (error) {
      if (!error.statusCode) console.error('Simulation event preparation failed:', error);
      res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Unable to prepare the isolated event. Check the server log.' });
    }
  };
  async function judges(date) {
    return database(judgeFile, sqlite3.OPEN_READONLY, async (db) => {
      await run(db, 'BEGIN');
      const [settings] = await all(db, 'SELECT revision FROM judge_management_settings WHERE id=1');
      const rows = await all(db, `SELECT association_id AS associationId,first_name AS firstName,last_name AS lastName,
        school,rank,certification,date_of_birth AS birth FROM judges ORDER BY last_name,first_name,association_id`);
      return { revision: settings.revision, judges: rows.map(({ birth, ...judge }) => {
        let age = null, ageIssue = '';
        try { age = ageOnDate(birth, date); } catch (error) { ageIssue = error.message; }
        return { ...judge, age, ageIssue };
      }) };
    });
  }
  async function participants(db) {
    const [settings] = await all(db, 'SELECT revision FROM volunteer_settings WHERE id=1');
    const volunteers = await all(db, 'SELECT association_id AS associationId FROM volunteers ORDER BY id');
    const competitors = await all(db, 'SELECT id,associationNumber AS associationId,firstName,lastName,rank,age,ageAsOf FROM competitors ORDER BY id');
    return { volunteers, competitors, revision: crypto.createHash('sha256')
      .update(JSON.stringify([settings.revision, competitors])).digest('hex') };
  }
  router.get('/simulation/events', handle(() => ({
    events: fs.readdirSync(eventsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(eventsRoot, entry.name, 'tournament.db')))
      .map((entry) => readEventConfig(entry.name)).sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name))
  })));
  router.get('/schools', handle(async () => ({
    schools: await database(judgeFile, sqlite3.OPEN_READONLY, (db) =>
      all(db, "SELECT DISTINCT school AS name, 0 AS archived FROM judges WHERE school != '' ORDER BY school"))
  })));
  router.post('/simulation/events', handle(async (req) => {
    const name = nameOf(req.body?.name);
    if (typeof req.body.date !== 'string') fail('A valid tournament date is required.');
    try { validDate(req.body.date); } catch (error) { fail(error.message); }
    if (![1, 2].includes(req.body.tournamentDays) || ![8, 16, 20].includes(req.body.ringCount)) fail('Select one/two days and 8, 16 or 20 rings.');
    if (!['regional', 'national', 'world', 'in-house'].includes(req.body.scope)) fail('Select an event scope.');
    const dir = path.join(eventsRoot, name);
    try { fs.mkdirSync(dir); }
    catch (error) { if (error.code === 'EEXIST') fail('An isolated event with this name already exists.', 409); throw error; }
    try {
      await initializeDatabase(path.join(dir, 'tournament.db'));
      return { event: writeEventConfig(name, { name, date: req.body.date, scope: req.body.scope,
        location: 'Fabricated simulation venue', tournamentDays: req.body.tournamentDays,
        ringConfigX: 4, ringConfigY: req.body.ringCount / 4 }) };
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }));
  router.get('/simulation/participation', handle(async (req) => {
    const { file, config } = event(req.query.eventName);
    const source = await judges(config.date);
    return { judges: source.judges, judgeRevision: source.revision,
      ...await database(file, sqlite3.OPEN_READONLY, async (db) => {
        await run(db, 'BEGIN');
        return participants(db);
      }), config };
  }));
  router.post('/simulation/participation', handle(async (req) => {
    const { name, file, config } = event(req.query.eventName);
    assertNoBirthDates(req.body);
    if (configurationStatus(name).configurationLocked) fail('Event preparation is locked.', 409);
    const source = await judges(config.date);
    if (source.revision !== req.body?.judgeRevision) fail('Judge directory changed. Reload before adding participants.', 409);
    const rows = req.body.members;
    if (!Array.isArray(rows) || !rows.length || rows.length > 500 ||
      rows.some((row) => typeof row?.associationId !== 'string') ||
      new Set(rows.map((row) => row.associationId.toUpperCase())).size !== rows.length) fail('Select 1-500 distinct directory members.');
    const byId = new Map(source.judges.map((judge) => [judge.associationId.toUpperCase(), judge]));
    const selected = rows.map((row) => {
      const judge = byId.get(String(row?.associationId || '').toUpperCase());
      if (!judge || typeof row.volunteer !== 'boolean' || typeof row.competitor !== 'boolean' || !row.volunteer && !row.competitor) fail('Select a directory member and at least one participation role.');
      const age = judge.age ?? row.age;
      if (!Number.isInteger(age) || age < 0 || age > 120) fail(`Enter an event-date age for ${judge.associationId}; the directory DOB is unavailable.`);
      if (row.volunteer && !judge.school) fail(`A school is required for volunteer ${judge.associationId}; correct Judge Management first.`);
      return { ...judge, age, volunteer: row.volunteer, competitor: row.competitor };
    });
    return database(file, sqlite3.OPEN_READWRITE, async (db) => {
      await run(db, 'PRAGMA foreign_keys=ON');
      await run(db, 'ATTACH DATABASE ? AS directory', [judgeFile]);
      await run(db, 'BEGIN IMMEDIATE');
      try {
        const [settings] = await all(db, 'SELECT revision FROM directory.judge_management_settings WHERE id=1');
        if (settings.revision !== source.revision) fail('Judge directory changed. Reload before adding participants.', 409);
        const current = await participants(db);
        if (current.revision !== req.body.revision) fail('Event participation changed. Reload before adding participants.', 409);
        const types = await all(db, 'SELECT id,name FROM volunteer_types');
        const judging = types.find((type) => type.name.toLowerCase() === 'judging');
        if (!judging && selected.some((row) => row.volunteer)) fail('Create a volunteer type named Judging first.');
        let addedVolunteers = 0, addedCompetitors = 0;
        for (const row of selected) {
          const member = { associationNumber: row.associationId, firstName: row.firstName, lastName: row.lastName };
          const personId = await resolveMemberPerson(db, member);
          if (row.volunteer && !current.volunteers.some((item) => item.associationId.toUpperCase() === row.associationId.toUpperCase())) {
            let volunteer;
            try {
              volunteer = validateVolunteer({ ...member, school: row.school, rank: row.rank, certification: 'UNKNOWN',
                primaryType: judging.id, secondaryType: '', age: row.age, ageAsOf: config.date,
                parentName: row.age < 18 ? 'Fabricated guardian' : '' }, types, config.date, false, config.scope);
            } catch (error) { fail(error.message); }
            await run(db, `INSERT INTO volunteers
              (id,person_id,association_id,first_name,last_name,school,rank,certification,primary_type,age,age_as_of,parent_name,contact_number,gender,email)
              VALUES(?,?,?,?,?,?,?,'UNKNOWN',?,?,?,?,'','','')`,
            [crypto.randomUUID(), personId, row.associationId, row.firstName, row.lastName, volunteer.school, volunteer.rank,
              judging.id, row.age, config.date, volunteer.parentName]);
            addedVolunteers++;
          }
          if (row.competitor && !current.competitors.some((item) => String(item.associationId).toUpperCase() === row.associationId.toUpperCase())) {
            await run(db, `INSERT INTO competitors(personId,associationNumber,firstName,lastName,studio,rank,age,ageAsOf)
              VALUES(?,?,?,?,?,?,?,?)`, [personId, row.associationId, row.firstName, row.lastName, row.school, row.rank, row.age, config.date]);
            addedCompetitors++;
          }
        }
        if (addedVolunteers) await run(db, 'UPDATE volunteer_settings SET revision=? WHERE id=1', [crypto.randomUUID()]);
        lockAgeDate(path.join(eventsRoot, name), config.date);
        await run(db, 'COMMIT');
        return { addedVolunteers, addedCompetitors };
      } catch (error) {
        await run(db, 'ROLLBACK');
        throw error;
      }
    });
  }));
  return router;
}
module.exports = { createSimulationEventRouter };
