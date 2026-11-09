const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');
const { writeJsonAtomicSync } = require('./atomicJsonFile');
const { normalizeRank } = require('../db/rankNormalization');
const { normalizeCertification, certificationLevels, certificationRankIssue, certificationAgeIssue, isJudgeRank, judgeRankOptions } = require('../db/judgeCertification');
const { storedAge, lockAgeDate } = require('./tournamentAge');
const { validateVolunteer } = require('./volunteerRoutes');
const { readVolunteerDirectory, replaceVolunteerDirectory } = require('./volunteerStore');

// Strict validation rejects qualification problems; lenient validation (saved
// data migration and population) keeps the row, resets unrecognized
// certification text to Unknown and flags the judge for review instead.
function validateJudge(input, lenient = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Judge details are required.');
  const row = {};
  if (input.firstName !== undefined || input.lastName !== undefined) {
    for (const [key, label] of [['firstName', 'First Name'], ['lastName', 'Last Name']]) {
      if (typeof input[key] !== 'string' || !input[key].trim() || input[key].trim().length > 100) {
        throw new Error(`${label} must be nonempty text of at most 100 characters.`);
      }
      row[key] = input[key].trim();
    }
    input = { ...input, name: `${row.lastName}, ${row.firstName}` };
  }
  for (const [key, label, max, required] of [
    ['name', 'Name', 200, true], ['associationNumber', 'Association ID', 100, true],
    ['school', 'School', 200, false], ['rank', 'Rank', 100, true],
    ['certification', 'Certification', 200, false], ['reviewNotes', 'Review notes', 2000, false]
  ]) {
    if (typeof input[key] !== 'string' || input[key].trim().length > max || required && !input[key].trim()) {
      throw new Error(`${label} must be ${required ? 'nonempty ' : ''}text of at most ${max} characters.`);
    }
    row[key] = input[key].trim();
  }
  const rank = normalizeRank(row.rank);
  if (!rank.recognized) throw new Error('Enter a recognized rank code, such as D1, D4, CDB or G5.');
  row.rank = rank.code;
  const certification = normalizeCertification(row.certification);
  if (!certification.recognized && !lenient) {
    throw new Error(`Certification must be one of: ${certificationLevels().map((level) => level.label).join(', ')}.`);
  }
  row.certification = certification.code;
  const priority = input.priority === undefined ? 4 : input.priority;
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > 99) {
    throw new Error('Priority must be a whole number from 0 to 99.');
  }
  row.priority = priority;
  if (typeof input.flaggedForReview !== 'boolean') throw new Error('Flagged for Review must be true or false.');
  const issues = [];
  if (!certification.recognized) issues.push(`Certification "${certification.raw}" was not recognized and was reset to Unknown.`);
  if (!isJudgeRank(row.rank)) issues.push('Judge rank must be between G5 and D8.');
  else {
    const mismatch = certificationRankIssue(row.certification, row.rank);
    if (mismatch) issues.push(mismatch);
  }
  if (issues.length && !lenient) throw new Error(issues[0]);
  if (issues.length) {
    row.reviewNotes = [row.reviewNotes, ...issues.filter((issue) => !row.reviewNotes.includes(issue))]
      .filter(Boolean).join(' ').slice(0, 2000);
  }
  return { ...row, flaggedForReview: input.flaggedForReview || issues.length > 0 };
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
  const judgeAgeEligible = (rank, age, scope) => /^D[1-8]$/.test(rank) && age >= (scope === 'in-house' ? 15 : 18);
  async function volunteerDirectory(dir) {
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'event-config.json'), 'utf8'));
    return { ...await readVolunteerDirectory(path.join(dir, 'tournament.db')), tournamentDate: config.date };
  }
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
      return { id: row.id, competitorId: row.competitorId, volunteerId: row.volunteerId || null, ...validateJudge(row, true) };
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
        const commit = async (extra = {}, volunteerChange = null) => {
          writable();
          if (read(file).revision !== data.revision) fail('Judge directory changed. Reload before saving.', 409);
          data.revision = crypto.randomUUID();
          if (volunteerChange) {
            lockAgeDate(dir, volunteerChange.date);
            const saved = await replaceVolunteerDirectory(dbFile, volunteerChange.original.revision, volunteerChange.next);
            try { writeJsonAtomicSync(file, data); }
            catch (error) {
              try { await replaceVolunteerDirectory(dbFile, saved.revision, volunteerChange.original, volunteerChange.original.revision); }
              catch (rollbackError) {
                console.error('Volunteer/judge save rollback failed:', rollbackError);
                fail('Judge save failed and volunteer rollback failed. Reload both directories before retrying.', 500);
              }
              throw error;
            }
          } else writeJsonAtomicSync(file, data);
          return { ...data, volunteerDirectory: await volunteerDirectory(dir), certificationLevels: certificationLevels(), judgeRanks: judgeRankOptions(), eventName: name, ...configurationStatus(name), ...extra };
        };
        res.json(await callback(req, { name, dir, dbFile, data, commit }));
      } catch (error) {
        if (!error.statusCode) console.error('Unable to access ring judges:', error);
        res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Unable to access Ring Judges. Changes have not been saved.' });
      }
    };
  }
  router.get('/ring-judges', handle(async (_req, { name, data, dir }) => ({ ...data, volunteerDirectory: await volunteerDirectory(dir), certificationLevels: certificationLevels(), judgeRanks: judgeRankOptions(), eventName: name, ...configurationStatus(name) })));
  const save = handle(async (req, { data, commit, dir, dbFile }) => {
    const existing = req.params.id ? data.judges.find((judge) => judge.id === req.params.id) : null;
    if (req.params.id && !existing) fail('Judge not found. Reload the directory.', 404);
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'event-config.json'), 'utf8'));
    let row, volunteerChange = null, volunteerId = existing?.volunteerId || null;
    try {
      if (existing?.competitorId) {
        const competitor = (await readRoster(dbFile)).find((member) => String(member.id) === existing.competitorId);
        if (!competitor) fail('Source competitor not found. Correct the registration before editing this judge.', 409);
        if (normalizeRank(req.body.judge?.rank).code !== normalizeRank(competitor.rank).code) {
          fail('Judge rank must match the saved competitor registration. Correct the rank through registration.', 400);
        }
        row = validateJudge({ ...req.body.judge, rank: competitor.rank });
        const issue = certificationAgeIssue(row.certification, row.rank, storedAge(competitor, config.date), config.scope);
        if (issue) fail(issue, 400);
      } else {
        const original = await readVolunteerDirectory(dbFile);
        if (req.body.volunteerRevision !== original.revision) fail('Volunteer data changed. Reload before saving.', 409);
        const sourceVolunteer = volunteerId ? original.volunteers.find((member) => member.id === volunteerId) : null;
        if (volunteerId && !sourceVolunteer) fail('Source volunteer not found. Reload the directory.', 409);
        const judging = original.types.find((type) => type.name.toLowerCase() === 'judging');
        if (!judging) fail('A Volunteer Type named Judging is required.', 400);
        const supplied = req.body.volunteer;
        if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) fail('Volunteer details including age are required.', 400);
        row = validateJudge(req.body.judge);
        const volunteer = validateVolunteer({ ...sourceVolunteer, ...supplied,
          firstName: row.firstName, lastName: row.lastName, associationNumber: row.associationNumber,
          school: row.school, rank: row.rank, certification: row.certification }, original.types, config.date, false, config.scope);
        if (![volunteer.primaryType, volunteer.secondaryType].includes(judging.id)) {
          fail('The volunteer must have Judging as First or Second Choice.', 400);
        }
        if (!judgeAgeEligible(volunteer.rank, volunteer.age, config.scope) &&
            !(volunteer.certification === 'SK_TK' &&
              !certificationAgeIssue('SK_TK', volunteer.rank, volunteer.age, config.scope))) {
          fail('The volunteer must meet the tournament age and rank requirements for a judge or certified SK/TK candidate.', 400);
        }
        if (volunteer.associationNumber && original.volunteers.some((member) => member.id !== volunteerId &&
            member.associationNumber.toUpperCase() === volunteer.associationNumber.toUpperCase())) {
          fail('A volunteer with this Association ID already exists. Edit and populate that volunteer instead.', 409);
        }
        const next = structuredClone(original);
        volunteerId ||= crypto.randomUUID();
        const target = next.volunteers.find((member) => member.id === volunteerId);
        if (target) Object.assign(target, volunteer);
        else next.volunteers.push({ id: volunteerId, ...volunteer });
        volunteerChange = { original, next, date: config.date };
      }
    } catch (error) { if (error.statusCode) throw error; fail(error.message, 400); }
    if (row.associationNumber && data.judges.some((judge) => judge.id !== req.params.id &&
        judge.associationNumber.toUpperCase() === row.associationNumber.toUpperCase())) fail('A judge with this Association ID already exists.', 409);
    if (existing) Object.assign(existing, row, { volunteerId });
    else data.judges.push({ id: crypto.randomUUID(), competitorId: null, volunteerId, ...row });
    return commit({}, volunteerChange);
  }, true);
  router.post('/ring-judges', save);
  router.put('/ring-judges/:id', save);
  function selectedIds(req, data, action) {
    const ids = req.body.ids;
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length ||
        ids.some((id) => !data.judges.some((judge) => judge.id === id))) fail(`Select distinct existing judges to ${action}.`, 400);
    return ids;
  }
  router.post('/ring-judges/clear-review', handle((req, { data, commit }) => {
    const ids = selectedIds(req, data, 'clear review flags');
    data.judges.forEach((judge) => { if (ids.includes(judge.id)) judge.flaggedForReview = false; });
    return commit();
  }, true));
  router.post('/ring-judges/delete', handle((req, { data, commit }) => {
    const ids = selectedIds(req, data, 'delete');
    data.judges = data.judges.filter((judge) => !ids.includes(judge.id));
    return commit();
  }, true));
  const populate = (volunteers) => handle(async (_req, { dir, dbFile, data, commit }) => {
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'event-config.json'), 'utf8'));
    const volunteerData = volunteers ? await readVolunteerDirectory(dbFile) : null;
    const judgingIds = volunteerData ? volunteerData.types.filter((type) => type.name.toLowerCase() === 'judging').map((type) => type.id) : [];
    if (volunteers && !judgingIds.length) fail('A Volunteer Type named Judging is required for judge population.', 400);
    const roster = volunteers ? volunteerData.volunteers.filter((row) => row.associationNumber &&
      (judgingIds.includes(row.primaryType) || judgingIds.includes(row.secondaryType)))
      .map((row) => ({ ...row, studio: row.school })) : await readRoster(dbFile);
    let added = 0, skipped = 0;
    for (const member of roster) {
      if (!String(member.associationNumber || '').trim()) continue;
      const rank = normalizeRank(member.rank);
      const hasSktkCertification = volunteers && member.certification === 'SK_TK';
      if (!rank.recognized || !isJudgeRank(rank.code) ||
          volunteers && !/^D[1-8]$/.test(rank.code) && !hasSktkCertification) continue;
      let age;
      try { age = storedAge(member, config.date); }
      catch (error) { fail(`Cannot determine eligibility for ${member.firstName} ${member.lastName}: ${error.message}`, 400); }
      const judgeEligible = judgeAgeEligible(rank.code, age, config.scope);
      const sktkEligible = (!volunteers || hasSktkCertification) && !certificationAgeIssue('SK_TK', rank.code, age, config.scope);
      if (!judgeEligible && !sktkEligible) continue;
      const associationNumber = String(member.associationNumber || '').trim();
      if (data.judges.some((judge) => (volunteers ? judge.volunteerId : judge.competitorId) === String(member.id) || associationNumber &&
          judge.associationNumber.toUpperCase() === associationNumber.toUpperCase())) { skipped++; continue; }
      const row = validateJudge({ firstName: member.firstName, lastName: member.lastName, associationNumber,
        school: member.studio || '', rank: rank.code, certification: volunteers ? member.certification : '', flaggedForReview: false,
        reviewNotes: !volunteers && sktkEligible ? 'Meets SK/TK age and rank criteria; certification is unverified.' : '' }, true);
      data.judges.push({ id: crypto.randomUUID(), competitorId: volunteers ? null : String(member.id), volunteerId: volunteers ? String(member.id) : null, ...row }); added++;
    }
    return commit({ added, skipped });
  }, true);
  router.post('/ring-judges/populate', populate(false));
  router.post('/ring-judges/populate-volunteers', populate(true));
  return router;
}
module.exports = { createRingJudgeRouter, validateJudge };
