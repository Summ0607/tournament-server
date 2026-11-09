const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const csv = require('csv-parser');
const { normalizeRank } = require('../db/rankNormalization');
const { normalizeCertification, certificationLevels, certificationRankIssue, certificationAgeIssue, judgeRankOptions } = require('../db/judgeCertification');
const { ageOnDate, storedAge, lockAgeDate } = require('./tournamentAge');
const { readVolunteerDirectory, replaceVolunteerDirectory } = require('./volunteerStore');

const headers = { 'First Name': 'firstName', 'Last Name': 'lastName', 'DOB': 'dob', 'Assoc ID': 'associationNumber',
  'School': 'school', 'Rank': 'rank', 'Certification': 'certification', 'Primary Volunteer Type': 'primaryType', 'Secondary Volunteer Type': 'secondaryType' };
const optionalHeaders = { 'Parent/Guardian Name': 'parentName', 'Contact Number': 'contactNumber',
  'Gender': 'gender', 'Email': 'email' };
// Strict validation rejects qualification problems; lenient validation
// (saved data migration) resets unrecognized certification text to Unknown
// and keeps the row instead.
function validateVolunteer(input, types, date, lenient = false, scope = '') {
  if (!input || typeof input !== 'object') throw new Error('Volunteer details are required.');
  const row = {};
  for (const [key, required, max] of [['firstName', true, 100], ['lastName', true, 100],
    ['associationNumber', false, 100], ['school', true, 200], ['rank', true, 100], ['certification', false, 200],
    ['primaryType', true, 100], ['secondaryType', false, 100]]) {
    if (typeof input[key] !== 'string' || input[key].trim().length > max || required && !input[key].trim()) throw new Error(`Invalid ${key}.`);
    row[key] = input[key].trim();
  }
  if (scope !== 'in-house' && !row.associationNumber) throw new Error('Association ID is required for volunteers at sanctioned events.');
  const ageAsOf = date || input.ageAsOf;
  const age = input.dob ? ageOnDate(input.dob, ageAsOf) : storedAge({ age: input.age, ageAsOf: input.ageAsOf }, ageAsOf);
  for (const [key, label, max] of [['parentName', 'Parent/guardian name', 200], ['contactNumber', 'Contact number', 100],
    ['gender', 'Gender', 100], ['email', 'Email', 254]]) {
    const value = input[key] === undefined ? '' : input[key];
    if (typeof value !== 'string' || value.trim().length > max) throw new Error(`Invalid ${label.toLowerCase()}.`);
    row[key] = value.trim();
  }
  const rank = normalizeRank(row.rank);
  if (!rank.recognized) throw new Error('Rank must be a recognized rank code.');
  row.rank = rank.code;
  const certification = normalizeCertification(row.certification);
  if (!certification.recognized && !lenient) throw new Error(`Certification must be one of: ${certificationLevels().map((level) => level.label).join(', ')}.`);
  row.certification = certification.code;
  const mismatch = certificationRankIssue(row.certification, row.rank);
  if (mismatch && !lenient) throw new Error(mismatch);
  const ageMismatch = certificationAgeIssue(row.certification, row.rank, age, scope);
  if (ageMismatch && !lenient) throw new Error(ageMismatch);
  if (age < 18 && !row.parentName && !lenient) throw new Error('Parent/guardian name is required for volunteers under 18.');
  for (const key of ['primaryType', 'secondaryType']) if (row[key] && !types.some((type) => type.id === row[key])) throw new Error(`Unknown ${key}.`);
  if (row.primaryType === row.secondaryType) throw new Error('Primary and secondary types must differ.');
  return { ...row, age, ageAsOf };
}
function parseCsv(text) {
  return new Promise((resolve, reject) => {
    const rows = [];
    const parser = csv({ strict: true, maxRowBytes: 10000, mapHeaders: ({ header }) => header.replace(/^\uFEFF/, '').trim() });
    parser.on('headers', (values) => {
      if (new Set(values).size !== values.length || values.some((key) => !Object.hasOwn(headers, key) && !Object.hasOwn(optionalHeaders, key)) ||
          Object.keys(headers).some((key) => !values.includes(key))) {
        parser.destroy(new Error(`CSV headers must include: ${Object.keys(headers).join(', ')}. Optional: ${Object.keys(optionalHeaders).join(', ')}.`));
      }
    });
    parser.on('data', (row) => rows.push(row));
    parser.on('error', reject); parser.on('end', () => resolve(rows));
    Readable.from([text]).pipe(parser);
  });
}
function createVolunteerRouter({ eventsRoot, configurationStatus }) {
  const router = express.Router();
  const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
  function handle(callback, write = false) {
    return async (req, res) => {
      try {
        const name = req.query.eventName;
        if (typeof name !== 'string' || !name.trim() || name !== name.trim() || /[<>:"/\\|?*\x00-\x1F]/.test(name) || ['.', '..'].includes(name)) fail('An explicit valid eventName is required.');
        const dir = path.join(eventsRoot, name), dbFile = path.join(dir, 'tournament.db');
        if (!fs.existsSync(dbFile)) fail('Tournament database not found.', 404);
        const writable = () => { const status = configurationStatus(name); if (status.configurationLocked) fail(status.configurationLockReason || 'Volunteer preparation is locked. Reset Run before editing.', 409); };
        if (write) writable();
        const data = await readVolunteerDirectory(dbFile);
        if (write && (!req.body || req.body.revision !== data.revision)) fail('Volunteer data changed. Reload before saving.', 409);
        const commit = async (extra = {}) => {
          writable();
          if (data.volunteers.length) lockAgeDate(dir, date);
          const saved = await replaceVolunteerDirectory(dbFile, data.revision, data);
          return { ...saved, certificationLevels: certificationLevels(), rankOptions: judgeRankOptions(), eventName: name, eventScope: config.scope, tournamentDate: date, ...configurationStatus(name), ...extra };
        };
        const config = JSON.parse(fs.readFileSync(path.join(dir, 'event-config.json'), 'utf8'));
        const date = config.date;
        res.json(await callback(req, { data, commit, name, date, scope: config.scope, fail }));
      } catch (error) {
        if (!error.statusCode) console.error('Unable to access volunteers:', error);
        res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Unable to access volunteer data. Changes have not been saved.' });
      }
    };
  }
  router.get('/volunteers', handle((_req, { data, name, date, scope }) => ({ ...data, certificationLevels: certificationLevels(), rankOptions: judgeRankOptions(), eventName: name, eventScope: scope, tournamentDate: date, ...configurationStatus(name) })));
  const save = handle((req, { data, commit, date, scope }) => {
    const existing = req.params.id ? data.volunteers.find((r) => r.id === req.params.id) : null;
    if (req.params.id && !existing) fail('Volunteer not found.', 404);
    let row;
    try { row = validateVolunteer({ gender: existing?.gender, email: existing?.email, ...req.body.volunteer }, data.types, date, false, scope); } catch (error) { fail(error.message); }
    if (row.associationNumber && data.volunteers.some((r) => r.id !== req.params.id && r.associationNumber.toUpperCase() === row.associationNumber.toUpperCase())) fail('Association ID already exists.', 409);
    if (existing) Object.assign(existing, row); else data.volunteers.push({ id: crypto.randomUUID(), ...row });
    return commit();
  }, true);
  router.post('/volunteers', save); router.put('/volunteers/:id', save);
  router.post('/volunteers/delete', handle((req, { data, commit }) => {
    const ids = req.body.ids;
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some((id) => !data.volunteers.some((r) => r.id === id))) fail('Select distinct existing volunteers.');
    data.volunteers = data.volunteers.filter((r) => !ids.includes(r.id)); return commit();
  }, true));
  const saveType = handle((req, { data, commit }) => {
    const name = req.body.name;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) fail('Type name is required (100 characters maximum).');
    const existing = req.params.id ? data.types.find((r) => r.id === req.params.id) : null;
    if (req.params.id && !existing) fail('Volunteer type not found.', 404);
    if (data.types.some((r) => r.id !== req.params.id && r.name.toLowerCase() === name.trim().toLowerCase())) fail('Type name already exists.', 409);
    if (existing) existing.name = name.trim(); else data.types.push({ id: crypto.randomUUID(), name: name.trim() });
    return commit();
  }, true);
  router.post('/volunteer-types', saveType); router.put('/volunteer-types/:id', saveType);
  router.post('/volunteer-types/delete', handle((req, { data, commit }) => {
    const ids = req.body.ids;
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some((id) => !data.types.some((r) => r.id === id))) fail('Select distinct existing types.');
    if (data.volunteers.some((r) => ids.includes(r.primaryType) || ids.includes(r.secondaryType))) fail('A selected type is used by volunteers. Reassign them before deleting.', 409);
    data.types = data.types.filter((r) => !ids.includes(r.id)); return commit();
  }, true));
  router.post('/volunteers/import', handle(async (req, { data, commit, date, scope }) => {
    if (typeof req.body.csv !== 'string' || !req.body.csv.trim() || Buffer.byteLength(req.body.csv) > 2 * 1024 * 1024) fail('Choose a nonempty CSV file of at most 2 MB.');
    let records;
    try { records = await parseCsv(req.body.csv); } catch (error) { fail(error.message); }
    if (!records.length) fail('CSV has no volunteer rows.');
    const seen = new Set(); let added = 0, updated = 0, unrecognizedCertifications = 0;
    for (const [index, raw] of records.entries()) {
      try {
        const input = Object.fromEntries(Object.entries(headers).map(([header, key]) => [key, raw[header]]));
        for (const [header, key] of Object.entries(optionalHeaders)) {
          if (Object.hasOwn(raw, header)) input[key] = raw[header];
        }
        const certification = normalizeCertification(input.certification);
        if (!certification.recognized) unrecognizedCertifications++;
        input.certification = certification.code;
        for (const key of ['primaryType', 'secondaryType']) {
          if (input[key].trim()) {
            const type = data.types.find((r) => r.name.toLowerCase() === input[key].trim().toLowerCase());
            if (!type) throw new Error(`Unknown volunteer type: ${input[key]}.`);
            input[key] = type.id;
          }
        }
        const key = input.associationNumber.trim().toUpperCase();
        const existing = key && data.volunteers.find((r) => r.associationNumber.toUpperCase() === key);
        const row = validateVolunteer({ parentName: existing?.parentName, contactNumber: existing?.contactNumber,
          gender: existing?.gender, email: existing?.email, ...input }, data.types, date, false, scope);
        if (key && seen.has(key)) throw new Error('Duplicate Assoc ID within CSV.');
        if (key) seen.add(key);
        if (existing) { Object.assign(existing, row); updated++; } else { data.volunteers.push({ id: crypto.randomUUID(), ...row }); added++; }
      } catch (error) { fail(`CSV row ${index + 2}: ${error.message}`); }
    }
    return commit({ added, updated, unrecognizedCertifications });
  }, true));
  return router;
}
module.exports = { createVolunteerRouter, validateVolunteer, headers };
