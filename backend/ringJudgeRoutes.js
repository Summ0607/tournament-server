const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');
const { writeJsonAtomicSync } = require('./atomicJsonFile');
const { normalizeRank } = require('../db/rankNormalization');
const { storedAge } = require('./tournamentAge');
const { readVolunteers } = require('./volunteerRoutes');

function validateJudge(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Judge details are required.');
  const row = {};
  for (const [key, label, max, required] of [
    ['name', 'Name', 200, true], ['associationNumber', 'Association ID', 100, false],
    ['school', 'School', 200, false], ['rank', 'Rank', 100, true],
    ['certification', 'Certification', 200, false], ['reviewNotes', 'Review notes', 2000, false]
  ]) {
    if (typeof input[key] !== 'string' || input[key].trim().length > max || required && !input[key].trim()) {
      throw new Error(`${label} must be ${required ? 'nonempty ' : ''}text of at most ${max} characters.`);
    }
    row[key] = input[key].trim();
  }
  const rank = normalizeRank(row.rank);
  if (!rank.recognized) throw new Error('Enter a recognized rank code, such as D1, D4, CDB or G1.');
  row.rank = rank.code;
  if (typeof input.flaggedForReview !== 'boolean') throw new Error('Flagged for Review must be true or false.');
  return { ...row, flaggedForReview: input.flaggedForReview };
}
function readRoster(file) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (error) => {
      if (error) return reject(error);
      db.all('SELECT id, firstName, lastName, associationNumber, studio, rank, age, ageAsOf FROM competitors', (error, rows) => {
        db.close((closeError) => error || closeError ? reject(error || closeError) : resolve(rows));
      });
    });
  });
}
function createRingJudgeRouter({ eventsRoot, configurationStatus }) {
  const router = express.Router();
  function read(file) {
    if (!fs.existsSync(file)) return { revision: null, judges: [] };
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof data.revision !== 'string' || !data.revision || !Array.isArray(data.judges)) throw new Error('Invalid saved judge directory.');
    const ids = new Set();
    data.judges = data.judges.map((row) => {
      if (typeof row.id !== 'string' || !row.id || ids.has(row.id) ||
          row.competitorId !== null && typeof row.competitorId !== 'string') throw new Error('Invalid saved judge identity.');
      ids.add(row.id);
      if (row.volunteerId !== undefined && row.volunteerId !== null && typeof row.volunteerId !== 'string') throw new Error('Invalid volunteer judge identity.');
      return { id: row.id, competitorId: row.competitorId, volunteerId: row.volunteerId || null, ...validateJudge(row) };
    });
    return data;
  }
  const fail = (message, statusCode) => { throw Object.assign(new Error(message), { statusCode }); };
  function handle(callback, write = false) {
    return async (req, res) => {
      try {
        const name = req.query.eventName;
        if (typeof name !== 'string' || !name.trim() || name !== name.trim() ||
            /[<>:"/\\|?*\x00-\x1F]/.test(name) || ['.', '..'].includes(name)) fail('An explicit valid eventName is required.', 400);
        const dir = path.join(eventsRoot, name), dbFile = path.join(dir, 'tournament.db'), file = path.join(dir, 'ring-judges.json');
        if (!fs.existsSync(dbFile)) fail('Tournament database not found.', 404);
        const writable = () => {
          const status = configurationStatus(name);
          if (status.configurationLocked) fail(status.configurationLockReason || 'Ring Judges are locked. Reset Run before editing.', 409);
        };
        if (write) writable();
        const data = read(file);
        if (write && (!req.body || req.body.revision !== data.revision)) fail('Judge directory changed. Reload before saving.', 409);
        const commit = (extra = {}) => {
          writable();
          if (read(file).revision !== data.revision) fail('Judge directory changed. Reload before saving.', 409);
          data.revision = crypto.randomUUID();
          writeJsonAtomicSync(file, data);
          return { ...data, eventName: name, ...configurationStatus(name), ...extra };
        };
        res.json(await callback(req, { name, dir, dbFile, data, commit }));
      } catch (error) {
        if (!error.statusCode) console.error('Unable to access ring judges:', error);
        res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Unable to access Ring Judges. Changes have not been saved.' });
      }
    };
  }
  router.get('/ring-judges', handle((_req, { name, data }) => ({ ...data, eventName: name, ...configurationStatus(name) })));
  const save = handle((req, { data, commit }) => {
    let row;
    try { row = validateJudge(req.body.judge); } catch (error) { fail(error.message, 400); }
    const existing = req.params.id ? data.judges.find((judge) => judge.id === req.params.id) : null;
    if (req.params.id && !existing) fail('Judge not found. Reload the directory.', 404);
    if (row.associationNumber && data.judges.some((judge) => judge.id !== req.params.id &&
        judge.associationNumber.toUpperCase() === row.associationNumber.toUpperCase())) fail('A judge with this Association ID already exists.', 409);
    if (existing) Object.assign(existing, row);
    else data.judges.push({ id: crypto.randomUUID(), competitorId: null, ...row });
    return commit();
  }, true);
  router.post('/ring-judges', save);
  router.put('/ring-judges/:id', save);
  router.post('/ring-judges/delete', handle((req, { data, commit }) => {
    const ids = req.body.ids;
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length ||
        ids.some((id) => !data.judges.some((judge) => judge.id === id))) fail('Select distinct existing judges to delete.', 400);
    data.judges = data.judges.filter((judge) => !ids.includes(judge.id));
    return commit();
  }, true));
  const populate = (volunteers) => handle(async (_req, { dir, dbFile, data, commit }) => {
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'event-config.json'), 'utf8'));
    const volunteerData = volunteers ? readVolunteers(path.join(dir, 'volunteers.json')) : null;
    const judgingIds = volunteerData ? volunteerData.types.filter((type) => type.name.toLowerCase() === 'judging').map((type) => type.id) : [];
    if (volunteers && !judgingIds.length) fail('A Volunteer Type named Judging is required for judge population.', 400);
    const roster = volunteers ? volunteerData.volunteers.filter((row) => judgingIds.includes(row.primaryType) || judgingIds.includes(row.secondaryType))
      .map((row) => ({ ...row, studio: row.school })) : await readRoster(dbFile);
    let added = 0, skipped = 0;
    for (const member of roster) {
      const rank = normalizeRank(member.rank);
      if (!rank.recognized || !/^D(?:[1-9]|10)$/.test(rank.code)) continue;
      let age;
      try { age = storedAge(member, config.date); }
      catch (error) { fail(`Cannot determine eligibility for ${member.firstName} ${member.lastName}: ${error.message}`, 400); }
      if (age < 18) continue;
      const associationNumber = String(member.associationNumber || '').trim();
      if (data.judges.some((judge) => (volunteers ? judge.volunteerId : judge.competitorId) === String(member.id) || associationNumber &&
          judge.associationNumber.toUpperCase() === associationNumber.toUpperCase())) { skipped++; continue; }
      const row = validateJudge({ name: `${member.lastName}, ${member.firstName}`, associationNumber,
        school: member.studio || '', rank: rank.code, certification: volunteers ? member.certification : '', flaggedForReview: false, reviewNotes: '' });
      data.judges.push({ id: crypto.randomUUID(), competitorId: volunteers ? null : String(member.id), volunteerId: volunteers ? String(member.id) : null, ...row }); added++;
    }
    return commit({ added, skipped });
  }, true);
  router.post('/ring-judges/populate', populate(false));
  router.post('/ring-judges/populate-volunteers', populate(true));
  return router;
}
module.exports = { createRingJudgeRouter, validateJudge };
