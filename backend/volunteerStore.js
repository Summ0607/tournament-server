const sqlite3 = require('sqlite3').verbose();
const crypto = require('node:crypto');
const { resolveMemberPerson, deleteOrphanPeople } = require('./eventPeople');

function openDatabase(file) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, sqlite3.OPEN_READWRITE, (error) => error ? reject(error) : resolve(db));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function callback(error) {
    if (error) return reject(error);
    resolve(this);
  }));
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (error, rows) =>
    error ? reject(error) : resolve(rows || [])));
}

function closeDatabase(db) {
  return new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
}

async function loadVolunteerDirectory(db) {
  const [settings] = await all(db, 'SELECT revision FROM volunteer_settings WHERE id = 1');
  if (!settings) throw new Error('Volunteer settings are missing from the event database.');
  const types = await all(db, 'SELECT id, name FROM volunteer_types ORDER BY rowid');
  const volunteers = await all(db, `SELECT id, first_name AS firstName, last_name AS lastName,
    person_id AS personId, association_id AS associationNumber, school, rank, certification, primary_type AS primaryType,
    COALESCE(secondary_type, '') AS secondaryType, age, age_as_of AS ageAsOf, parent_name AS parentName,
    contact_number AS contactNumber, gender, email FROM volunteers ORDER BY rowid`);
  return { revision: settings.revision, types, volunteers };
}

async function readVolunteerDirectory(file) {
  const db = await openDatabase(file);
  try { return await loadVolunteerDirectory(db); }
  finally { await closeDatabase(db); }
}

async function replaceVolunteerDirectory(file, expectedRevision, next, revision = crypto.randomUUID()) {
  const db = await openDatabase(file);
  let transaction = false;
  try {
    db.configure('busyTimeout', 5000);
    await run(db, 'PRAGMA foreign_keys = ON');
    await run(db, 'BEGIN IMMEDIATE');
    transaction = true;
    const current = await loadVolunteerDirectory(db);
    if (current.revision !== expectedRevision) {
      throw Object.assign(new Error('Volunteer data changed. Reload before saving.'), { statusCode: 409 });
    }
    await run(db, 'DELETE FROM volunteers');
    await run(db, 'DELETE FROM volunteer_types');
    for (const type of next.types) {
      await run(db, 'INSERT INTO volunteer_types (id, name) VALUES (?, ?)', [type.id, type.name]);
    }
    for (const row of next.volunteers) {
      const personId = row.associationNumber
        ? await resolveMemberPerson(db, row)
        : null;
      await run(db, `INSERT INTO volunteers
        (id, person_id, first_name, last_name, association_id, school, rank, certification, primary_type, secondary_type,
         age, age_as_of, parent_name, contact_number, gender, email)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        row.id, personId, row.firstName, row.lastName, row.associationNumber, row.school, row.rank, row.certification,
        row.primaryType, row.secondaryType || null, row.age, row.ageAsOf, row.parentName, row.contactNumber, row.gender, row.email
      ]);
    }
    await deleteOrphanPeople(db);
    await run(db, 'UPDATE volunteer_settings SET revision = ? WHERE id = 1', [revision]);
    await run(db, 'COMMIT');
    transaction = false;
    return await loadVolunteerDirectory(db);
  } catch (error) {
    if (transaction) {
      try { await run(db, 'ROLLBACK'); }
      catch (rollbackError) { console.error('Volunteer database rollback failed:', rollbackError); }
    }
    throw error;
  } finally {
    await closeDatabase(db);
  }
}

module.exports = { readVolunteerDirectory, loadVolunteerDirectory, replaceVolunteerDirectory };
