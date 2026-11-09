const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const express = require('express');
const { test } = require('node:test');
const initializeDatabase = require('../db/init');
const importCSV = require('../db/import-csv');
const { createRingJudgeRouter } = require('../backend/ringJudgeRoutes');
const { createVolunteerRouter } = require('../backend/volunteerRoutes');
const { readVolunteerDirectory, replaceVolunteerDirectory } = require('../backend/volunteerStore');

function query(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (error, row) =>
    error ? reject(error) : resolve(row)));
}

test('member roles share one Association ID identity and nonmember volunteers stay unlinked', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'event-people-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbFile = path.join(root, 'tournament.db'), csvFile = path.join(root, 'competitors.csv');
  await initializeDatabase(dbFile);
  fs.writeFileSync(csvFile, 'First Name,Last Name,DOB,Association Number,Current Rank\nJane,Doe,2000-01-09,TSD-001,D1');
  await importCSV(csvFile, dbFile, { tournamentDate: '2027-01-09' });

  let directory = await readVolunteerDirectory(dbFile);
  directory.volunteers.push({
    id: 'member-volunteer', firstName: 'Jane', lastName: 'Doe', associationNumber: 'tsd-001',
    school: 'School', rank: 'D1', certification: 'UNKNOWN', primaryType: 'judging', secondaryType: '',
    age: 27, ageAsOf: '2027-01-09', parentName: '', contactNumber: '', gender: '', email: ''
  });
  directory = await replaceVolunteerDirectory(dbFile, directory.revision, directory);

  const db = new sqlite3.Database(dbFile);
  try {
    const competitor = await query(db, 'SELECT personId FROM competitors WHERE associationNumber = ?', ['TSD-001']);
    const member = await query(db, 'SELECT person_id FROM volunteers WHERE id = ?', ['member-volunteer']);
    assert.equal(member.person_id, competitor.personId);
    assert.equal((await query(db, 'SELECT COUNT(*) AS count FROM event_people')).count, 1);
  } finally { await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve())); }

  directory.volunteers.push({
    id: 'nonmember-volunteer', firstName: 'Alex', lastName: 'Parent', associationNumber: '',
    school: 'School', rank: 'G1', certification: 'UNKNOWN', primaryType: 'setup', secondaryType: '',
    age: 40, ageAsOf: '2027-01-09', parentName: '', contactNumber: '', gender: '', email: ''
  });
  directory = await replaceVolunteerDirectory(dbFile, directory.revision, directory);
  const verify = new sqlite3.Database(dbFile);
  try {
    const nonmember = await query(verify, 'SELECT person_id FROM volunteers WHERE id = ?', ['nonmember-volunteer']);
    assert.equal(nonmember.person_id, null);
    assert.equal((await query(verify, 'SELECT COUNT(*) AS count FROM event_people')).count, 1);
  } finally { await new Promise((resolve, reject) => verify.close((error) => error ? reject(error) : resolve())); }

  directory.volunteers.find((row) => row.id === 'member-volunteer').firstName = 'Different';
  await assert.rejects(replaceVolunteerDirectory(dbFile, directory.revision, directory), /already linked to Jane Doe/);
  assert.equal((await readVolunteerDirectory(dbFile)).revision, directory.revision);
});

test('competitor imports require unique Association IDs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'event-people-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbFile = path.join(root, 'tournament.db'), csvFile = path.join(root, 'competitors.csv');
  await initializeDatabase(dbFile);
  fs.writeFileSync(csvFile, 'First Name,Last Name,DOB,Current Rank\nJane,Doe,2000-01-09,D1');
  await assert.rejects(importCSV(csvFile, dbFile, { tournamentDate: '2027-01-09' }), /Association ID is required/);
  fs.writeFileSync(csvFile, 'First Name,Last Name,DOB,Association Number,Current Rank\nJane,Doe,2000-01-09,TSD-001,D1\nAlex,Smith,2000-01-09,tsd-001,D1');
  await assert.rejects(importCSV(csvFile, dbFile, { tournamentDate: '2027-01-09' }), /Duplicate Association ID/);
  const db = new sqlite3.Database(dbFile);
  try { assert.equal((await query(db, 'SELECT COUNT(*) AS count FROM competitors')).count, 0); }
  finally { await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve())); }
  fs.writeFileSync(csvFile, 'First Name,Last Name,DOB,Association Number,Current Rank\nJane,Doe,2000-01-09,TSD-001,D1\nJane,Doe,2000-01-09,TSD-002,D1');
  await importCSV(csvFile, dbFile, { tournamentDate: '2027-01-09' });
  const distinct = new sqlite3.Database(dbFile);
  try {
    assert.equal((await query(distinct, 'SELECT COUNT(*) AS count FROM event_people')).count, 2);
    assert.equal((await query(distinct, 'SELECT COUNT(DISTINCT personId) AS count FROM competitors')).count, 2);
  } finally { await new Promise((resolve, reject) => distinct.close((error) => error ? reject(error) : resolve())); }
});

test('volunteer management links member saves to imported competitors and rejects name conflicts', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'event-people-api-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const eventDir = path.join(root, 'Event');
  fs.mkdirSync(eventDir);
  const dbFile = path.join(eventDir, 'tournament.db'), csvFile = path.join(root, 'competitors.csv');
  await initializeDatabase(dbFile);
  fs.writeFileSync(path.join(eventDir, 'event-config.json'), JSON.stringify({ date: '2027-01-09', scope: 'regional' }));
  fs.writeFileSync(csvFile, 'First Name,Last Name,DOB,Association Number,Current Rank\nJane,Doe,2000-01-09,TSD-001,D1');
  await importCSV(csvFile, dbFile, { tournamentDate: '2027-01-09' });

  const app = express();
  app.use(express.json());
  app.use('/api', createVolunteerRouter({ eventsRoot: root, configurationStatus: () => ({ configurationLocked: false }) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/volunteers?eventName=Event`;
  const get = async () => (await fetch(base)).json();
  const initial = await get();
  const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    revision: initial.revision,
    volunteer: { firstName: 'Jane', lastName: 'Doe', associationNumber: 'tsd-001', school: 'School', rank: 'D1',
      certification: '', primaryType: 'judging', secondaryType: '', age: 27, ageAsOf: '2027-01-09',
      parentName: '', contactNumber: '' }
  }) });
  assert.equal(response.status, 200);
  const saved = await response.json();
  const db = new sqlite3.Database(dbFile);
  let competitor;
  try { competitor = await query(db, 'SELECT personId FROM competitors WHERE associationNumber = ?', ['TSD-001']); }
  finally { await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve())); }
  assert.equal(saved.volunteers[0].personId, competitor.personId);

  const conflict = await fetch(`${base.split('?')[0]}/${saved.volunteers[0].id}?eventName=Event`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      revision: saved.revision,
      volunteer: { firstName: 'Different', lastName: 'Person', associationNumber: 'TSD-001', school: 'School', rank: 'D1',
        certification: '', primaryType: 'judging', secondaryType: '', age: 27, ageAsOf: '2027-01-09',
        parentName: '', contactNumber: '' }
    })
  });
  assert.equal(conflict.status, 409);
  assert.equal((await get()).volunteers[0].firstName, 'Jane');
});

test('fresh event databases isolate member identities and enforce scope-specific volunteer and judge rules', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'event-people-fresh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = [
    { name: 'Sanctioned', scope: 'regional' },
    { name: 'In House', scope: 'in-house' }
  ];
  for (const event of events) {
    const directory = path.join(root, event.name);
    fs.mkdirSync(directory);
    await initializeDatabase(path.join(directory, 'tournament.db'));
    fs.writeFileSync(path.join(directory, 'event-config.json'), JSON.stringify({ date: '2027-01-09', scope: event.scope }));
    const csvFile = path.join(directory, 'competitors.csv');
    fs.writeFileSync(csvFile, 'First Name,Last Name,DOB,Association Number,Current Rank\nJane,Doe,1980-01-09,TSD-001,D1');
    await importCSV(csvFile, path.join(directory, 'tournament.db'), { tournamentDate: '2027-01-09' });
  }

  const app = express();
  app.use(express.json());
  const options = { eventsRoot: root, configurationStatus: () => ({ configurationLocked: false }) };
  app.use('/api', createVolunteerRouter(options), createRingJudgeRouter(options));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const volunteerUrl = (event) => `${base}/volunteers?eventName=${encodeURIComponent(event)}`;
  const postVolunteer = async (event, revision, volunteer) => fetch(volunteerUrl(event), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision, volunteer })
  });
  const member = (associationNumber, primaryType = 'judging') => ({
    firstName: 'Jane', lastName: 'Doe', associationNumber, school: 'School', rank: 'D1',
    certification: 'Unknown', primaryType, secondaryType: '', age: 47, ageAsOf: '2027-01-09',
    parentName: '', contactNumber: ''
  });

  const sanctioned = await (await fetch(volunteerUrl('Sanctioned'))).json();
  assert.equal(sanctioned.eventScope, 'regional');
  assert.equal((await postVolunteer('Sanctioned', sanctioned.revision, member(''))).status, 400);
  const sanctionedSave = await postVolunteer('Sanctioned', sanctioned.revision, member('TSD-001'));
  assert.equal(sanctionedSave.status, 200);
  const sanctionedData = await sanctionedSave.json();

  const inHouse = await (await fetch(volunteerUrl('In House'))).json();
  assert.equal(inHouse.eventScope, 'in-house');
  const memberSave = await postVolunteer('In House', inHouse.revision, member('tsd-001'));
  assert.equal(memberSave.status, 200);
  const memberData = await memberSave.json();
  const nonmemberSave = await postVolunteer('In House', memberData.revision,
    member('', 'judging'));
  assert.equal(nonmemberSave.status, 200);
  const inHouseData = await nonmemberSave.json();
  assert.notEqual(sanctionedData.volunteers[0].personId, memberData.volunteers[0].personId);
  assert.equal(inHouseData.volunteers[1].personId, null);
  assert.deepEqual((await (await fetch(volunteerUrl('Sanctioned'))).json()).volunteers.map((row) => row.associationNumber), ['TSD-001']);

  const judgeResponse = await fetch(`${base}/ring-judges/populate-volunteers?eventName=${encodeURIComponent('In House')}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: null })
  });
  assert.equal(judgeResponse.status, 200);
  const judges = await judgeResponse.json();
  assert.equal(judges.added, 1);
  assert.equal(judges.judges.length, 1);
  assert.equal(judges.judges[0].associationNumber, 'tsd-001');
  assert.equal(judges.judges[0].volunteerId, inHouseData.volunteers[0].id);

  for (const event of events) {
    const db = new sqlite3.Database(path.join(root, event.name, 'tournament.db'));
    try { assert.equal((await query(db, 'SELECT COUNT(*) AS count FROM event_people')).count, 1); }
    finally { await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve())); }
  }
});
