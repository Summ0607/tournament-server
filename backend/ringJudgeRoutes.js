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
const { assignmentCandidates, judgeSnapshot } = require('./judgeAssignmentCandidates');

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
  const priority = input.priority === undefined ? 6 : input.priority;
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
function createRingJudgeRouter({ eventsRoot, configurationStatus, judgeFile }) {
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
      if (row.inHousePoolApproved !== undefined && typeof row.inHousePoolApproved !== 'boolean') throw new Error('Invalid In-House judge approval.');
      return { id: row.id, competitorId: row.competitorId, volunteerId: row.volunteerId || null,
        ...validateJudge({ ...row, priority: row.priority ?? (row.competitorId ? 4 : 6) }, true),
        ...(row.inHousePoolApproved ? { inHousePoolApproved: true } : {}) };
    });
    return data;
  }
  async function inHouseCompetitorCandidates(dir, dbFile, data) {
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'event-config.json'), 'utf8'));
    if (config.scope !== 'in-house') fail('Uncertified competitor review is available only for In-House events.', 400);
    const [roster, snapshot] = await Promise.all([
      readRoster(dbFile),
      judgeFile ? judgeSnapshot(judgeFile, config.date) : Promise.resolve({ revision: null, judges: [] })
    ]);
    const members = new Map(snapshot.judges.map((member) => [member.associationId.toUpperCase(), member]));
    const existingIds = new Set(data.judges.map((row) => row.associationNumber.toUpperCase()));
    const existingCompetitors = new Set(data.judges.map((row) => row.competitorId).filter(Boolean));
    const candidates = [];
    for (const competitor of roster) {
      const associationNumber = String(competitor.associationNumber || '').trim();
      const associationId = associationNumber.toUpperCase();
      const competitorId = String(competitor.id);
      if (!associationId || existingIds.has(associationId) || existingCompetitors.has(competitorId)) continue;
      const member = members.get(associationId);
      if (member) {
        const sameName = (left, right) => String(left || '').trim().replace(/\s+/g, ' ').toLowerCase() ===
          String(right || '').trim().replace(/\s+/g, ' ').toLowerCase();
        if (!sameName(competitor.firstName, member.firstName) || !sameName(competitor.lastName, member.lastName) ||
            normalizeRank(competitor.rank).code !== member.rank ||
            /^(inactive|suspended|revoked)$/i.test(member.status) ||
            !['UNKNOWN', 'UNCERTIFIED'].includes(normalizeCertification(member.certification).code)) continue;
      }
      const rank = normalizeRank(competitor.rank);
      if (!rank.recognized || !isJudgeRank(rank.code)) continue;
      let age;
      try { age = storedAge(competitor, config.date); }
      catch (error) { fail(`Cannot determine eligibility for ${competitor.firstName} ${competitor.lastName}: ${error.message}`, 400); }
      if (!judgeAgeEligible(rank.code, age, config.scope) &&
          certificationAgeIssue('SK_TK', rank.code, age, config.scope)) continue;
      candidates.push({
        competitorId, firstName: competitor.firstName, lastName: competitor.lastName,
        name: `${competitor.lastName}, ${competitor.firstName}`, associationNumber, school: competitor.studio || '',
        rank: rank.code, age, certification: member ? normalizeCertification(member.certification).code : 'UNKNOWN'
      });
    }
    const candidateRevision = crypto.createHash('sha256').update(JSON.stringify([
      config, snapshot.revision, roster, data.revision
    ])).digest('hex');
    return { candidates, candidateRevision };
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
        const result = await callback(req, { name, dir, dbFile, data, commit });
        if (judgeFile) {
          result.certificationReadOnly = true;
          const config = JSON.parse(fs.readFileSync(path.join(dir, 'event-config.json'), 'utf8'));
          const linked = new Map((await assignmentCandidates({ eventFile: dbFile, judgeFile, config })).judges.map((judge) => [judge.id, judge]));
          result.judges = result.judges.map((judge) => {
            const candidate = linked.get(judge.associationNumber.toUpperCase());
            const approvedInHouse = config.scope === 'in-house' && judge.inHousePoolApproved === true;
            return { ...judge, certification: candidate?.certification || (approvedInHouse ? judge.certification : 'UNKNOWN'),
              flaggedForReview: judge.flaggedForReview || !candidate && !approvedInHouse || Boolean(candidate?.qualificationIssue),
              reviewNotes: [judge.reviewNotes, candidate?.qualificationIssue || (!candidate && !approvedInHouse ? 'No current event candidate matched to Judge Management.' : '')].filter(Boolean).join(' ') };
          });
        }
        res.json(result);
      } catch (error) {
        if (!error.statusCode) console.error('Unable to access ring judges:', error);
        res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Unable to access Ring Judges. Changes have not been saved.' });
      }
    };
  }
  router.get('/ring-judges', handle(async (_req, { name, data, dir }) => ({ ...data, volunteerDirectory: await volunteerDirectory(dir), certificationLevels: certificationLevels(), judgeRanks: judgeRankOptions(), eventName: name, eventScope: JSON.parse(fs.readFileSync(path.join(dir, 'event-config.json'), 'utf8')).scope, ...configurationStatus(name) })));
  const save = handle(async (req, { data, commit, dir, dbFile }) => {
    const existing = req.params.id ? data.judges.find((judge) => judge.id === req.params.id) : null;
    if (req.params.id && !existing) fail('Judge not found. Reload the directory.', 404);
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'event-config.json'), 'utf8'));
    let judgeInput = req.body.judge;
    if (judgeFile && judgeInput && typeof judgeInput.associationNumber === 'string') {
      const directory = await judgeSnapshot(judgeFile, config.date);
      const certification = directory.judges.find((judge) =>
        judge.associationId.toUpperCase() === judgeInput.associationNumber.trim().toUpperCase())?.certification || 'UNKNOWN';
      if (existing && normalizeCertification(judgeInput.certification).code !== certification) {
        fail('Certification comes from Judge Management. Reload Ring Judges; make certification corrections in Judge Management.', 409);
      }
      judgeInput = { ...judgeInput, certification };
    }
    let row, volunteerChange = null, volunteerId = existing?.volunteerId || null;
    try {
      if (existing?.competitorId) {
        const competitor = (await readRoster(dbFile)).find((member) => String(member.id) === existing.competitorId);
        if (!competitor) fail('Source competitor not found. Correct the registration before editing this judge.', 409);
        if (normalizeRank(judgeInput?.rank).code !== normalizeRank(competitor.rank).code) {
          fail('Judge rank must match the saved competitor registration. Correct the rank through registration.', 400);
        }
        row = validateJudge({ ...judgeInput, rank: competitor.rank });
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
        row = validateJudge(judgeInput);
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
  router.get('/ring-judges/in-house-competitors', handle(async (_req, { dir, dbFile, data }) => ({
    ...data, ...(await inHouseCompetitorCandidates(dir, dbFile, data))
  })));
  router.post('/ring-judges/approve-in-house-competitors', handle(async (req, { dir, dbFile, data, commit }) => {
    const ids = req.body.competitorIds;
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length ||
        ids.some((id) => typeof id !== 'string')) fail('Select distinct In-House competitors to approve.', 400);
    const { candidates, candidateRevision } = await inHouseCompetitorCandidates(dir, dbFile, data);
    if (req.body.candidateRevision !== candidateRevision) fail('Competitor review candidates changed. Reload before approving.', 409);
    const selected = new Map(candidates.map((candidate) => [candidate.competitorId, candidate]));
    if (ids.some((id) => !selected.has(id))) fail('A selected competitor is no longer available for In-House review. Reload the list.', 409);
    for (const id of ids) {
      const candidate = selected.get(id);
      const row = validateJudge({
        firstName: candidate.firstName, lastName: candidate.lastName, associationNumber: candidate.associationNumber,
        school: candidate.school, rank: candidate.rank, certification: candidate.certification, priority: 4,
        flaggedForReview: false,
        reviewNotes: 'Coordinator-approved for the In-House Ring Judges pool only; not certified or eligible for phase assignment.'
      }, true);
      data.judges.push({ id: crypto.randomUUID(), competitorId: candidate.competitorId, volunteerId: null,
        ...row, inHousePoolApproved: true });
    }
    return commit({ added: ids.length, skipped: 0 });
  }, true));
  router.post('/ring-judges/delete', handle((req, { data, commit }) => {
    const ids = selectedIds(req, data, 'delete');
    data.judges = data.judges.filter((judge) => !ids.includes(judge.id));
    return commit();
  }, true));
  const populate = (volunteers) => handle(async (_req, { dir, dbFile, data, commit }) => {
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'event-config.json'), 'utf8'));
    if (!volunteers && !judgeFile && config.scope === 'in-house') {
      fail('Use coordinator review to select In-House competitors when Judge Management is unavailable.', 400);
    }
    const linked = judgeFile ? new Map((await assignmentCandidates({ eventFile: dbFile, judgeFile, config })).judges
      .map((judge) => [judge.id, judge])) : null;
    const volunteerData = volunteers ? await readVolunteerDirectory(dbFile) : null;
    const judgingIds = volunteerData ? volunteerData.types.filter((type) => type.name.toLowerCase() === 'judging').map((type) => type.id) : [];
    if (volunteers && !judgingIds.length) fail('A Volunteer Type named Judging is required for judge population.', 400);
    const roster = volunteers ? volunteerData.volunteers.filter((row) => row.associationNumber &&
      (judgingIds.includes(row.primaryType) || judgingIds.includes(row.secondaryType)))
      .map((row) => ({ ...row, studio: row.school })) : await readRoster(dbFile);
    let added = 0, updated = 0, skipped = 0;
    for (const member of roster) {
      if (!String(member.associationNumber || '').trim()) continue;
      const verified = linked?.get(String(member.associationNumber).trim().toUpperCase());
      if (linked && !volunteers && (!verified || !Object.values(verified.roles).some(Boolean))) { skipped++; continue; }
      const rank = normalizeRank(member.rank);
      const hasSktkCertification = volunteers && (verified?.certification || member.certification) === 'SK_TK';
      if (!rank.recognized || !isJudgeRank(rank.code) ||
          volunteers && !/^D[1-8]$/.test(rank.code) && !hasSktkCertification) continue;
      let age;
      try { age = storedAge(member, config.date); }
      catch (error) { fail(`Cannot determine eligibility for ${member.firstName} ${member.lastName}: ${error.message}`, 400); }
      const judgeEligible = judgeAgeEligible(rank.code, age, config.scope);
      const sktkEligible = (!volunteers || hasSktkCertification) && !certificationAgeIssue('SK_TK', rank.code, age, config.scope);
      if (!judgeEligible && !sktkEligible && !verified?.roles.corner) continue;
      const associationNumber = String(member.associationNumber || '').trim();
      const existing = data.judges.find((judge) =>
        (volunteers ? judge.volunteerId : judge.competitorId) === String(member.id) ||
        associationNumber && judge.associationNumber.toUpperCase() === associationNumber.toUpperCase());
      if (existing) {
        if (volunteers && existing.priority === 4) {
          existing.priority = 6;
          updated++;
        } else skipped++;
        continue;
      }
      const row = validateJudge({ firstName: member.firstName, lastName: member.lastName, associationNumber,
        school: member.studio || '', rank: rank.code, certification: verified?.certification || (volunteers ? member.certification : ''), flaggedForReview: Boolean(verified?.qualificationIssue),
        priority: volunteers ? 6 : 4,
        reviewNotes: verified ? [verified.qualificationIssue, !volunteers ? 'Certified directory match; potential judge only. Coordinator must confirm phase availability before assignment.' : 'Matched to Judge Management by Association ID.'].filter(Boolean).join(' ') :
          !volunteers && sktkEligible ? 'Meets SK/TK age and rank criteria; certification is unverified.' : '' }, true);
      data.judges.push({ id: crypto.randomUUID(), competitorId: volunteers ? null : String(member.id), volunteerId: volunteers ? String(member.id) : null, ...row }); added++;
    }
    return commit({ added, updated, skipped });
  }, true);
  router.post('/ring-judges/populate', populate(false));
  router.post('/ring-judges/populate-volunteers', populate(true));
  return router;
}
module.exports = { createRingJudgeRouter, validateJudge };
