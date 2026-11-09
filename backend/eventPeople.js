const crypto = require('node:crypto');

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (error) =>
    error ? reject(error) : resolve()));
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (error, row) =>
    error ? reject(error) : resolve(row)));
}

async function resolveMemberPerson(db, { associationNumber, firstName, lastName }) {
  const associationId = String(associationNumber || '').trim();
  if (!associationId) throw new Error('Association ID is required for member identity.');
  const existing = await get(db, `SELECT id, first_name AS firstName, last_name AS lastName
    FROM event_people WHERE association_id = ? COLLATE NOCASE`, [associationId]);
  if (existing) {
    const sameName = existing.firstName.trim().toLowerCase() === String(firstName || '').trim().toLowerCase() &&
      existing.lastName.trim().toLowerCase() === String(lastName || '').trim().toLowerCase();
    if (!sameName) {
      throw Object.assign(new Error(`Association ID ${associationId} is already linked to ${existing.firstName} ${existing.lastName}. Correct the name or Association ID before saving.`), { statusCode: 409 });
    }
    return existing.id;
  }
  const id = crypto.randomUUID();
  await run(db, `INSERT INTO event_people (id, association_id, first_name, last_name)
    VALUES (?, ?, ?, ?)`, [id, associationId, String(firstName || '').trim(), String(lastName || '').trim()]);
  return id;
}

async function deleteOrphanPeople(db) {
  await run(db, `DELETE FROM event_people
    WHERE NOT EXISTS (SELECT 1 FROM competitors WHERE competitors.personId = event_people.id)
      AND NOT EXISTS (SELECT 1 FROM volunteers WHERE volunteers.person_id = event_people.id)`);
}

module.exports = { resolveMemberPerson, deleteOrphanPeople };
