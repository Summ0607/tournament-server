const express = require('express');
const sqlite3 = require('sqlite3');
const csv = require('csv-parser');
const { Readable } = require('node:stream');
const crypto = require('node:crypto');
const { normalizeRank } = require('../db/rankNormalization');
const { normalizeCertification, certificationLevels, judgeRankOptions, JUDGE_RANKS, isJudgeRank } = require('../db/judgeCertification');
const { validDate } = require('./tournamentAge');

const fields = ['associationId', 'firstName', 'lastName', 'school', 'rank', 'certification', 'expiration', 'status', 'notes'];
const dateOfBirthColumn = 'date_of_birth';
const csvFields = [...fields, 'dateOfBirth'];
const testLevels = ['SK_TK', 'CORNER', 'REGIONAL', 'INTERNATIONAL'];
const defaults = {
  associationId: ['wtsda_id', 'idNumber'], firstName: ['first_name', 'firstName'],
  lastName: ['last_name', 'lastName'], school: ['school', 'studioName'],
  rank: ['rank', 'current_rank'], certification: ['certification_level', 'level'],
  expiration: ['certification_expiration', 'judgingLevelExpDate'], status: ['status', 'judge_status'],
  notes: ['notes', 'judging_notes'],
  dateOfBirth: ['dateOfBirth', 'date_of_birth', 'DOB', 'birthDate']
};
const columns = { associationId: 'association_id', firstName: 'first_name', lastName: 'last_name', school: 'school',
  rank: 'rank', certification: 'certification', expiration: 'certification_expiration', status: 'status', notes: 'notes',
  dateOfBirth: dateOfBirthColumn };
const levels = ['SK_TK', 'CORNER', 'REGIONAL', 'INTERNATIONAL'];
const experienceRoles = ['JUDGE', 'CORNER_JUDGE', 'CENTER_JUDGE', 'SCOREKEEPER', 'TIMEKEEPER', 'ARBITRATOR'];
const scopes = ['REGIONAL', 'NATIONAL', 'WORLD', 'IN_HOUSE'];
const invalid = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const key = (value) => value.toLowerCase().replace(/[\s_]+/g, '');
const run = (db, sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, function (e) { e ? reject(e) : resolve(this); }));
const all = (db, sql, args = []) => new Promise((resolve, reject) => db.all(sql, args, (e, rows) => e ? reject(e) : resolve(rows)));
const close = (db) => new Promise((resolve, reject) => db.close((e) => e ? reject(e) : resolve()));
const manualSourceId = (eventId, role, phase) => `manual:${crypto.createHash('sha256').update(JSON.stringify([eventId, role, phase])).digest('hex')}`;
function date(value, label) {
  try { return validDate(value); } catch { throw invalid(`${label} must be a valid YYYY-MM-DD date.`); }
}
function ageOn(dateOfBirth, asOf) {
  const birth = new Date(`${dateOfBirth}T00:00:00.000Z`), date = new Date(`${asOf}T00:00:00.000Z`);
  let age = date.getUTCFullYear() - birth.getUTCFullYear();
  if (date.getUTCMonth() < birth.getUTCMonth() || date.getUTCMonth() === birth.getUTCMonth() && date.getUTCDate() < birth.getUTCDate()) age--;
  if (age < 0 || age > 120) throw invalid('Date of birth must produce an age from 0 to 120.');
  return age;
}
function addFiveYears(value) {
  const result = new Date(`${value}T00:00:00.000Z`);
  result.setUTCFullYear(result.getUTCFullYear() + 5);
  return result.toISOString().slice(0, 10);
}
function subtractFiveYears(value) {
  const result = new Date(`${value}T00:00:00.000Z`);
  result.setUTCFullYear(result.getUTCFullYear() - 5);
  return result.toISOString().slice(0, 10);
}
function testPassed(records, level, type, after, asOf) {
  return records.some((row) => row.targetLevel === level &&
    (type === 'written' ? Boolean(row.writtenDate) && row.writtenDate >= after && row.writtenDate <= asOf && row.writtenScore >= 80 :
      Boolean(row.practicalDate) && row.practicalDate >= after && row.practicalDate <= asOf && row.practicalPassed === 1));
}
function evaluateEligibility(judge, tests, experience, today = new Date().toISOString().slice(0, 10)) {
  const currentIndex = levels.indexOf(judge.certification);
  const expired = judge.expiration && judge.expiration < today;
  const recertifying = Boolean(expired && currentIndex >= 0);
  const target = recertifying ? judge.certification : levels[currentIndex + 1] || (currentIndex < 0 ? levels[0] : null);
  const rankIndex = JUDGE_RANKS.indexOf(judge.rank);
  if (!target) return { judgeId: judge.id, targetLevel: judge.certification, eligible: false,
    reason: 'No higher certification level is available.', status: 'Highest certification level',
    recertifying: false, reviewRequired: false, writtenPassed: false, practicalRequired: false,
    practicalPassed: false, experienceCount: 0, requiredExperience: 0,
    mayJudge: !(judge.certification === 'CORNER' && judge.rank === 'CDB') };
  const grantedAt = judge.grantedAt || '';
  const logExempt = rankIndex >= JUDGE_RANKS.indexOf('D5');
  const records = experience.filter((item) => item.judgeId === judge.id && (item.logVerified || logExempt) &&
    item.eventDate <= today && item.eventScope !== 'IN_HOUSE' && (!grantedAt || item.eventDate >= grantedAt));
  const minimumRank = target === 'INTERNATIONAL' ? JUDGE_RANKS.indexOf('D2') :
    ['CORNER', 'REGIONAL'].includes(target) ? JUDGE_RANKS.indexOf('D1') : 0;
  const cdbCorner = target === 'CORNER' && judge.rank === 'CDB';
  const minimumAge = target === 'SK_TK' ? (judge.rank === 'CDB' ? 14 : 16) :
    target === 'CORNER' ? 16 : 0;
  const currentAge = judge.dateOfBirth ? ageOn(judge.dateOfBirth, today) : null;
  let requiredExperience = 0, requiredRole = null, reason = '';
  if (target === 'SK_TK' && rankIndex < 0) reason = 'A recognized judge rank is required.';
  else if (!recertifying && ['SK_TK', 'CORNER'].includes(target) && currentAge === null) reason = 'Date of birth must be available to verify the minimum age requirement.';
  else if (!recertifying && target === 'SK_TK' && currentAge < minimumAge) reason = `Scorekeeper certification requires age ${minimumAge} or older for rank ${judge.rank}.`;
  else if (target === 'CORNER' && judge.certification !== 'SK_TK' && !recertifying) reason = 'Certified Scorekeeper level is required before Corner.';
  else if (target === 'CORNER' && !cdbCorner && rankIndex < minimumRank) reason = 'Dan rank is required for Corner certification.';
  else if (!recertifying && target === 'CORNER' && currentAge < minimumAge) reason = 'Corner certification requires age 16 or older.';
  else if (target === 'REGIONAL' && judge.certification !== 'CORNER' && !recertifying) reason = 'Certified Corner level is required before Regional Center.';
  else if (target === 'REGIONAL' && rankIndex < minimumRank) reason = 'Dan rank is required for Regional Center.';
  else if (target === 'INTERNATIONAL' && judge.certification !== 'REGIONAL' && !recertifying) reason = 'Certified Regional Center level is required before International.';
  else if (target === 'INTERNATIONAL' && rankIndex < minimumRank) reason = 'International certification requires E Dan (D2) or higher.';
  else if (target === 'CORNER' && !recertifying) { requiredExperience = 1; }
  else if (target === 'REGIONAL') { requiredExperience = 2; }
  else if (target === 'INTERNATIONAL') { requiredExperience = 1; requiredRole = 'CENTER_JUDGE'; }
  if (target === 'REGIONAL') requiredRole = 'CORNER_JUDGE';
  const qualifying = requiredRole ? records.filter((row) => row.role === requiredRole) : records;
  const experienceCount = new Set(qualifying.map((row) => row.eventId || `legacy:${row.eventName?.trim().toLowerCase()}:${row.eventDate}`)).size;
  if (!reason && target === 'CORNER' && !recertifying && experienceCount < requiredExperience) reason = 'At least 1 verified sanctioned Championship judging-experience log is required.';
  if (!reason && target === 'REGIONAL' && experienceCount < requiredExperience) reason = `At least ${requiredExperience} verified sanctioned Championships as a Corner Judge are required.`;
  if (!reason && target === 'INTERNATIONAL' && experienceCount < requiredExperience) reason = 'At least 1 verified sanctioned Championship experience record as a Regional Center Judge is required.';
  if (!reason && target === 'INTERNATIONAL' && !records.some((row) => row.eventScope === 'WORLD' && ['JUDGE', 'CORNER_JUDGE', 'CENTER_JUDGE'].includes(row.role))) reason = 'Verified experience judging at a World Championship is required.';
  const needsReview = recertifying && ['REGIONAL', 'INTERNATIONAL'].includes(target) && Boolean(reason);
  const testAfter = judge.grantedAt || (judge.expiration ? subtractFiveYears(judge.expiration) : '');
  const judgeTests = tests.filter((row) => row.judgeId === judge.id);
  const writtenPassed = testPassed(judgeTests, target, 'written', testAfter, today);
  const practicalRequired = target !== 'SK_TK';
  const practicalPassed = !practicalRequired || testPassed(judgeTests, target, 'practical', testAfter, today);
  return { judgeId: judge.id, targetLevel: target || 'SK_TK', eligible: !reason, reason,
    status: needsReview ? 'Coordinator review required' : reason ? 'Not eligible' :
      recertifying ? 'Eligible to recertify' : 'Eligible to test',
    recertifying, reviewRequired: needsReview, writtenPassed, practicalRequired, practicalPassed,
    experienceCount, requiredExperience,
    mayJudge: !(judge.certification === 'CORNER' && judge.rank === 'CDB') };
}

function validate(input, today) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Judge details are required.');
  const result = {};
  for (const field of fields) {
    const value = input[field] == null ? '' : input[field];
    if (typeof value !== 'string') throw invalid(`${field} must be text.`);
    const text = value.trim();
    const limit = field === 'notes' ? 2000 : 200;
    if (text.length > limit || (['associationId', 'firstName', 'lastName'].includes(field) && !text)) throw invalid(`${field} is required or exceeds ${limit} characters.`);
    result[field] = text;
  }
  if (result.rank) {
    const rank = normalizeRank(result.rank);
    if (!rank.recognized || !isJudgeRank(rank.code)) throw invalid('Rank must be a recognized judge rank from G5 to D8.');
    result.rank = rank.code;
  }
  const certification = normalizeCertification(result.certification);
  if (!certification.recognized) throw invalid('Certification level is not recognized.');
  result.certification = certification.code;
  if (result.certification === 'SK_TK' && result.rank && !JUDGE_RANKS.includes(result.rank)) throw invalid('Scorekeeper certification requires an eligible judge rank.');
  if (result.certification === 'CORNER' && result.rank && !['CDB', ...JUDGE_RANKS.slice(JUDGE_RANKS.indexOf('D1'))].includes(result.rank)) throw invalid('Corner certification requires Cho Dan Bo or Dan rank.');
  if (result.certification === 'REGIONAL' && result.rank && !JUDGE_RANKS.slice(JUDGE_RANKS.indexOf('D1')).includes(result.rank)) throw invalid('Regional Center certification requires Dan rank.');
  if (result.certification === 'INTERNATIONAL' && result.rank && !JUDGE_RANKS.slice(JUDGE_RANKS.indexOf('D2')).includes(result.rank)) throw invalid('International certification requires E Dan (D2) or higher.');
  if (result.expiration) {
    const usDate = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(result.expiration);
    if (usDate) result.expiration = `${usDate[3]}-${usDate[1].padStart(2, '0')}-${usDate[2].padStart(2, '0')}`;
    try { validDate(result.expiration); }
    catch { throw invalid('Expiration must be a valid YYYY-MM-DD or MM/DD/YYYY date.'); }
  }
  const rawBirthDate = input.dateOfBirth || '';
  const birthUsDate = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(rawBirthDate);
  result.dateOfBirth = rawBirthDate
    ? date(birthUsDate ? `${birthUsDate[3]}-${birthUsDate[1].padStart(2, '0')}-${birthUsDate[2].padStart(2, '0')}` : rawBirthDate, 'Date of birth')
    : '';
  if (result.dateOfBirth) {
    if (result.dateOfBirth > today) throw invalid('Date of birth cannot be in the future.');
    ageOn(result.dateOfBirth, today);
  }
  return result;
}

function validateTest(input, today) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Test details are required.');
  const result = { targetLevel: input.targetLevel };
  if (!testLevels.includes(result.targetLevel)) throw invalid('Select a certification level for this test.');
  result.writtenDate = input.writtenDate ? date(input.writtenDate, 'Written test date') : null;
  if (result.writtenDate && result.writtenDate > today) throw invalid('Written test date cannot be in the future.');
  result.writtenScore = input.writtenScore === '' || input.writtenScore === null || input.writtenScore === undefined
    ? null : Number(input.writtenScore);
  if (result.writtenDate && (!Number.isInteger(result.writtenScore) || result.writtenScore < 0 || result.writtenScore > 100)) throw invalid('Written score must be a whole percentage from 0 to 100.');
  if (!result.writtenDate && result.writtenScore !== null) throw invalid('A written score requires a written test date.');
  result.practicalDate = input.practicalDate ? date(input.practicalDate, 'Practical test date') : null;
  if (result.practicalDate && result.practicalDate > today) throw invalid('Practical test date cannot be in the future.');
  result.practicalPassed = input.practicalPassed === '' || input.practicalPassed === null || input.practicalPassed === undefined
    ? null : input.practicalPassed === true || input.practicalPassed === 1 ? 1 : input.practicalPassed === false || input.practicalPassed === 0 ? 0 : NaN;
  if (result.practicalDate && ![0, 1].includes(result.practicalPassed)) throw invalid('Record the practical test result as pass or fail.');
  if (!result.practicalDate && result.practicalPassed !== null) throw invalid('A practical result requires a practical test date.');
  if (!result.writtenDate && !result.practicalDate) throw invalid('Enter a written or practical test date.');
  return result;
}

function validateExperience(input, today) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Experience details are required.');
  if (typeof input.eventName !== 'string' || !input.eventName.trim() || input.eventName.trim().length > 200) throw invalid('Event name is required and must be at most 200 characters.');
  if (typeof input.location !== 'string' || input.location.trim().length > 200) throw invalid('Location must be at most 200 characters.');
  if (!experienceRoles.includes(input.role)) throw invalid('Select a valid judging experience role.');
  if (!scopes.includes(input.eventScope)) throw invalid('Select a valid event scope.');
  if (typeof input.logVerified !== 'boolean') throw invalid('Confirm whether the experience log was verified.');
  const eventDate = date(input.eventDate, 'Event date');
  if (eventDate > today) throw invalid('Event date cannot be in the future.');
  return { eventName: input.eventName.trim(), eventDate,
    location: input.location.trim(), role: input.role, eventScope: input.eventScope, logVerified: Number(input.logVerified) };
}

function validateAliases(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('CSV aliases are required.');
  const aliases = {}, seen = new Map();
  for (const field of csvFields) {
    const values = field === 'dateOfBirth' && input[field] === undefined ? defaults[field] : input[field];
    if (!Array.isArray(values) || !values.length || values.some((v) => typeof v !== 'string' || !v.trim() || v.length > 100)) throw invalid(`Provide at least one valid alias for ${field}.`);
    aliases[field] = values.map((v) => v.trim());
    for (const alias of aliases[field]) {
      const normalized = key(alias);
      if (!normalized || (seen.has(normalized) && seen.get(normalized) !== field)) throw invalid(`Duplicate CSV alias: ${alias}.`);
      seen.set(normalized, field);
    }

  }
  return aliases;
}

async function replaceRecords(db, judgeId, body, today) {
  if (Object.hasOwn(body, 'tests')) {
    if (!Array.isArray(body.tests) || body.tests.length > 100) throw invalid('Testing records must be an array of at most 100 records.');
    const tests = body.tests.map((record) => validateTest(record, today));
    await run(db, 'DELETE FROM judge_test_attempts WHERE judge_id = ?', [judgeId]);
    for (const record of tests) {
      await run(db, `INSERT INTO judge_test_attempts
        (judge_id, target_level, written_date, written_score, practical_date, practical_passed)
        VALUES (?, ?, ?, ?, ?, ?)`, [judgeId, record.targetLevel, record.writtenDate, record.writtenScore,
        record.practicalDate, record.practicalPassed]);
    }
  }
  if (Object.hasOwn(body, 'experience')) {
    if (!Array.isArray(body.experience) || body.experience.length > 200) throw invalid('Experience records must be an array of at most 200 records.');
    for (const record of body.experience.filter((item) => item?.sourceId)) {
      const validated = validateExperience(record, today);
      const [existing] = await all(db, `SELECT event_name AS eventName,event_date AS eventDate,
        location,role,event_scope AS eventScope,log_verified AS logVerified
        FROM judge_experience WHERE judge_id = ? AND source_id = ?`, [judgeId, record.sourceId]);
      if (!existing || Object.keys(validated).some((field) => validated[field] !== existing[field])) {
        throw invalid('API service records are read-only here. Use the experience verification action.', 409);
      }
    }
    const records = body.experience.filter((record) => !record?.sourceId).map((record) => validateExperience(record, today));
    await run(db, 'DELETE FROM judge_experience WHERE judge_id = ? AND source_id IS NULL', [judgeId]);
    for (const record of records) {
      await run(db, `INSERT INTO judge_experience
        (judge_id, event_name, event_date, location, role, event_scope, log_verified, event_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [judgeId, record.eventName, record.eventDate, record.location,
        record.role, record.eventScope, record.logVerified, `legacy:${record.eventName.toLowerCase()}:${record.eventDate}`]);
    }
  }
}

async function parseCsv(text, aliases) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 2 * 1024 * 1024) throw invalid('Choose a nonempty CSV file of at most 2 MB.');
  return new Promise((resolve, reject) => {
    const mapping = new Map(csvFields.flatMap((field) => aliases[field].map((a) => [key(a), field])));
    const rows = [], seen = new Set();
    const parser = csv({ strict: true, maxRowBytes: 10000, mapHeaders: ({ header }) => mapping.get(key(header.replace(/^\uFEFF/, '').trim())) || null });
    parser.on('headers', (headers) => {
      const mapped = headers.filter(Boolean);
      if (mapped.some((header) => seen.has(header) || !seen.add(header))) return parser.destroy(invalid('CSV contains multiple columns for the same field.'));
      if (['associationId', 'firstName', 'lastName'].some((field) => !seen.has(field))) parser.destroy(invalid('CSV must contain Association ID, first name, and last name columns.'));
    });
    parser.on('data', (row) => rows.push(row));
    parser.on('error', (error) => reject(error.statusCode ? error : invalid(`Invalid CSV: ${error.message}`)));
    parser.on('end', () => rows.length ? resolve(rows) : reject(invalid('CSV contains no judge rows.')));
    Readable.from([text]).pipe(parser);
  });
}

function createJudgeManagementRouter({ file, currentDate = () => new Date().toISOString().slice(0, 10), allowSimulation = false }) {
  const router = express.Router();
  async function handle(req, res, operation, write = false) {
    let db;
    try {
      const today = date(currentDate(), 'Current date');
      db = await new Promise((resolve, reject) => {
        const instance = new sqlite3.Database(file, sqlite3.OPEN_READWRITE, (error) => error ? reject(error) : resolve(instance));
      });
      db.configure('busyTimeout', 5000);
      try {
        await run(db, 'PRAGMA foreign_keys = ON');
        if (write) await run(db, 'BEGIN IMMEDIATE');
        const [settings] = await all(db, 'SELECT revision, aliases FROM judge_management_settings WHERE id = 1');
        if (!settings) throw new Error('Judge Management settings are missing.');
        if (write && (!Number.isSafeInteger(req.body?.revision) || req.body.revision !== settings.revision)) throw invalid('Judge data changed. Reload before saving.', 409);
        const aliases = Object.keys(JSON.parse(settings.aliases)).length ? validateAliases(JSON.parse(settings.aliases)) : defaults;
        const extra = await operation(db, aliases, today);
        if (write) await run(db, 'UPDATE judge_management_settings SET revision = revision + 1 WHERE id = 1');
        const [next] = await all(db, 'SELECT revision, aliases FROM judge_management_settings WHERE id = 1');
        const judges = await all(db, `SELECT id, association_id AS associationId, first_name AS firstName, last_name AS lastName,
          school, rank, certification, certification_expiration AS expiration, certification_granted_at AS grantedAt,
          ${dateOfBirthColumn} AS dateOfBirth, status, notes
          FROM judges ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE, association_id`);
        const tests = await all(db, `SELECT id, judge_id AS judgeId, target_level AS targetLevel, written_date AS writtenDate,
          written_score AS writtenScore, practical_date AS practicalDate, practical_passed AS practicalPassed
          FROM judge_test_attempts ORDER BY written_date DESC, practical_date DESC, id DESC`);
        const experience = await all(db, `SELECT id, judge_id AS judgeId, event_name AS eventName, event_date AS eventDate,
          location, role, event_scope AS eventScope, log_verified AS logVerified,
          event_id AS eventId, phase, source, source_id AS sourceId
          FROM judge_experience ORDER BY event_date DESC, id DESC`);
        const eligibility = judges.map((judge) => evaluateEligibility(judge, tests, experience, today));
        const publicJudges = judges.map(({ dateOfBirth, ...judge }) => judge);
        if (write) await run(db, 'COMMIT');
        const payload = { asOf: today, revision: next.revision, aliases: Object.keys(JSON.parse(next.aliases)).length ? JSON.parse(next.aliases) : defaults,
          judges: publicJudges, tests, experience, eligibility, certificationLevels: certificationLevels(), ranks: judgeRankOptions(), ...extra };
        if (req.path === '/judge-management/profile') {
          const judge = publicJudges.find((row) => row.associationId.toUpperCase() === String(req.query.associationId || '').trim().toUpperCase());
          if (!judge) throw invalid('Judge not found by Association ID.', 404);
          return res.json({ asOf: today, revision: next.revision, judge,
            tests: tests.filter((row) => row.judgeId === judge.id),
            experience: experience.filter((row) => row.judgeId === judge.id),
            eligibility: eligibility.find((row) => row.judgeId === judge.id) });
        }
        res.json(payload);
      } catch (error) {
        if (write) {
          try { await run(db, 'ROLLBACK'); } catch (rollbackError) { console.error('Judge Management rollback failed:', rollbackError); }
        }
        throw error;
      }
    } catch (error) {
      if (!error.statusCode) console.error('Judge Management request failed:', error);
      res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Unable to access Judge Management data. Check the server log.' });
    } finally { if (db) await close(db); }
  }
  const endpoint = (operation, write = false) => (req, res) => handle(req, res, (db, aliases, today) => operation(req, db, aliases, today), write);
  router.get('/judge-management', endpoint(() => ({})));
  router.get('/judge-management/profile', endpoint(() => ({})));
  async function member(db, associationId) {
    if (typeof associationId !== 'string' || !associationId.trim()) throw invalid('Association ID is required.');
    const [judge] = await all(db, 'SELECT id FROM judges WHERE association_id = ? COLLATE NOCASE', [associationId.trim()]);
    if (!judge) throw invalid('Judge not found by Association ID.', 404);
    return judge;
  }
  router.post('/judge-management/experience', endpoint(async (req, db, _aliases, today) => {
    const judge = await member(db, req.body.associationId);
    if (!Array.isArray(req.body.records) || !req.body.records.length || req.body.records.length > 200) throw invalid('Provide 1 to 200 experience records.');
    let added = 0, duplicates = 0;
    for (const supplied of req.body.records) {
      const input = { ...supplied };
      if (input.source === 'MANUAL') {
        if (req.body.confirmedCompleted !== true) throw invalid('Confirm actual completed service; assignments or check-in alone do not qualify.');
        if (typeof input.eventId !== 'string' || !input.eventId.trim() || input.eventId.length > 200) throw invalid('eventId is required and must be at most 200 characters.');
        if (!['P1', 'P2'].includes(input.phase)) throw invalid('Select P1 or P2 for completed service.');
        input.sourceId = manualSourceId(input.eventId.trim(), input.role, input.phase);
      }
      const record = validateExperience({ ...input, logVerified: false }, today);
      for (const field of ['eventId', 'sourceId']) {
        if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > 200) throw invalid(`${field} is required and must be at most 200 characters.`);
      }
      if (!['MANUAL', 'SIMULATION', 'TOURNAMENT'].includes(input.source) || input.source === 'SIMULATION' && !allowSimulation) throw invalid('Experience source is not permitted.');
      if (input.logVerified !== undefined && input.logVerified !== false) throw invalid('Submitted experience must await coordinator verification.');
      if (!['', 'P1', 'P2'].includes(input.phase ?? '')) throw invalid('Phase must be blank, P1 or P2.');
      const values = [record.eventName, record.eventDate, record.location, record.role, record.eventScope,
        input.eventId.trim(), input.phase || '', input.source, input.sourceId.trim()];
      const [existing] = await all(db, `SELECT event_name,event_date,location,role,event_scope,event_id,phase,source,source_id
        FROM judge_experience WHERE judge_id = ? AND (source_id = ? OR (event_id = ? AND role = ? AND phase = ?))`,
      [judge.id, values[8], values[5], values[3], values[6]]);
      if (existing) {
        if (JSON.stringify(Object.values(existing)) !== JSON.stringify(values)) throw invalid('Experience identity already exists with different details.', 409);
        duplicates++; continue;
      }
      const [event] = await all(db, `SELECT event_name,event_date,event_scope,event_id FROM judge_experience
        WHERE event_id = ? OR (event_name = ? COLLATE NOCASE AND event_date = ?) LIMIT 1`, [values[5], record.eventName, record.eventDate]);
      if (event && event.event_id !== values[5]) throw invalid('This event already uses a different eventId.', 409);
      if (event && (event.event_name !== record.eventName || event.event_date !== record.eventDate || event.event_scope !== record.eventScope)) throw invalid('Event identity has conflicting name, date or scope.', 409);
      await run(db, `INSERT INTO judge_experience
        (judge_id,event_name,event_date,location,role,event_scope,event_id,phase,source,source_id)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, [judge.id, ...values]);
      added++;
    }
    return { added, duplicates };
  }, true));
  router.put('/judge-management/experience/:id', endpoint(async (req, db, _aliases, today) => {
    const [existing] = await all(db, 'SELECT * FROM judge_experience WHERE id = ?', [req.params.id]);
    if (!existing) throw invalid('Experience record not found.', 404);
    if (existing.source !== 'MANUAL' || !existing.source_id) throw invalid('Only coordinator-recorded completed service can be corrected here.', 409);
    if (req.body.confirmedCompleted !== true) throw invalid('Confirm the corrected record describes actual completed service.');
    if (!req.body.record || typeof req.body.record !== 'object' || Array.isArray(req.body.record)) throw invalid('Corrected service details are required.');
    for (const [field, stored] of [['eventId', 'event_id'], ['eventName', 'event_name'], ['eventDate', 'event_date'], ['eventScope', 'event_scope']]) {
      if (req.body.record[field] !== undefined && req.body.record[field] !== existing[stored]) throw invalid('Event identity cannot be changed in a service correction. Withdraw an incorrect event record and enter it again.');
    }
    const judge = await member(db, req.body.associationId);
    const record = validateExperience({ ...req.body.record, eventName: existing.event_name, eventDate: existing.event_date,
      eventScope: existing.event_scope, logVerified: false }, today);
    if (!['P1', 'P2'].includes(req.body.record?.phase)) throw invalid('Select P1 or P2.');
    try {
      await run(db, `UPDATE judge_experience SET judge_id=?,location=?,role=?,phase=?,source_id=?,log_verified=0 WHERE id=?`,
        [judge.id, record.location, record.role, req.body.record.phase,
          manualSourceId(existing.event_id, record.role, req.body.record.phase), existing.id]);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT' && /UNIQUE/.test(error.message)) throw invalid('That judge already has this event, role and phase recorded.', 409);
      throw error;
    }
    return {};
  }, true));
  router.delete('/judge-management/experience/:id', endpoint(async (req, db) => {
    const [existing] = await all(db, 'SELECT source,source_id FROM judge_experience WHERE id=?', [req.params.id]);
    if (!existing) throw invalid('Experience record not found.', 404);
    if (existing.source !== 'MANUAL' || !existing.source_id) throw invalid('Only coordinator-recorded completed service can be withdrawn here.', 409);
    if (req.body.confirmedWithdrawal !== true) throw invalid('Confirm withdrawal of this service and its experience credit.');
    await run(db, 'DELETE FROM judge_experience WHERE id=?', [req.params.id]);
    return {};
  }, true));
  router.post('/judge-management/experience-verify', endpoint(async (req, db) => {
    const judge = await member(db, req.body.associationId);
    const ids = req.body.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 200 || new Set(ids).size !== ids.length ||
        ids.some((id) => !Number.isSafeInteger(id) || id < 1) || typeof req.body.verified !== 'boolean') throw invalid('Select distinct experience IDs and a verification decision.');
    const result = await run(db, `UPDATE judge_experience SET log_verified = ? WHERE judge_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
      [Number(req.body.verified), judge.id, ...ids]);
    if (result.changes !== ids.length) throw invalid('One or more experience records do not belong to this judge.', 409);
    return {};
  }, true));
  router.post('/judge-management', endpoint(async (req, db, _aliases, today) => {
    const judge = validate(req.body.judge, today);
    const values = [...fields.map((f) => judge[f] || (f === 'rank' || f === 'expiration' ? null : '')), judge.dateOfBirth || null];
    let result;
    try { result = await run(db, `INSERT INTO judges (${[...fields.map((f) => columns[f]), dateOfBirthColumn].join(',')}) VALUES (${values.map(() => '?').join(',')})`, values); }
    catch (e) { if (e.code === 'SQLITE_CONSTRAINT' && /UNIQUE/.test(e.message)) throw invalid('Association ID already exists.', 409); throw e; }
    await replaceRecords(db, result.lastID, req.body, today);
    return {};
  }, true));
  router.put('/judge-management/:id', endpoint(async (req, db, _aliases, today) => {
    const [existing] = await all(db, `SELECT ${dateOfBirthColumn} AS dateOfBirth FROM judges WHERE id = ?`, [req.params.id]);
    if (!existing) throw invalid('Judge not found.', 404);
    const judge = validate({ ...req.body.judge, dateOfBirth: req.body.judge?.dateOfBirth ?? existing.dateOfBirth }, today);
    const values = [...fields.map((f) => judge[f] || (f === 'rank' || f === 'expiration' ? null : '')), judge.dateOfBirth || null];
    let result;
    try { result = await run(db, `UPDATE judges SET ${[...fields.map((f) => `${columns[f]} = ?`), `${dateOfBirthColumn} = ?`].join(',')} WHERE id = ?`, [...values, req.params.id]); }
    catch (e) { if (e.code === 'SQLITE_CONSTRAINT' && /UNIQUE/.test(e.message)) throw invalid('Association ID already exists.', 409); throw e; }
    if (!result.changes) throw invalid('Judge not found.', 404);
    await replaceRecords(db, Number(req.params.id), req.body, today);
    return {};
  }, true));
  router.post('/judge-management/:id/award', endpoint(async (req, db, _aliases, today) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) throw invalid('Judge not found.', 404);
    const grantDate = date(req.body.grantedAt, 'Grant date');
    if (grantDate > today) throw invalid('Grant date cannot be in the future.');
    const [judge] = await all(db, `SELECT id, rank, certification, certification_expiration AS expiration,
      certification_granted_at AS grantedAt, date_of_birth AS dateOfBirth FROM judges WHERE id = ?`, [id]);
    if (!judge) throw invalid('Judge not found.', 404);
    if (judge.grantedAt && grantDate < judge.grantedAt) throw invalid('Grant date cannot precede the current certification award.');
    const tests = await all(db, `SELECT judge_id AS judgeId, target_level AS targetLevel, written_date AS writtenDate,
      written_score AS writtenScore, practical_date AS practicalDate, practical_passed AS practicalPassed FROM judge_test_attempts WHERE judge_id = ?`, [id]);
    const experience = await all(db, `SELECT judge_id AS judgeId, event_name AS eventName, event_id AS eventId, event_date AS eventDate, role, event_scope AS eventScope,
      log_verified AS logVerified FROM judge_experience WHERE judge_id = ?`, [id]);
    const eligibility = evaluateEligibility(judge, tests, experience, grantDate);
    if (!eligibility.eligible || !eligibility.writtenPassed || !eligibility.practicalPassed) throw invalid('On the grant date, the judge must meet eligibility requirements and have passed the required written and practical tests before certification can be granted.', 409);
    const certification = eligibility.targetLevel;
    await run(db, 'UPDATE judges SET certification = ?, certification_granted_at = ?, certification_expiration = ? WHERE id = ?',
      [certification, grantDate, addFiveYears(grantDate), id]);
    return {};
  }, true));
  router.post('/judge-management/delete', endpoint(async (req, db) => {
    const ids = req.body.ids;
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) throw invalid('Select distinct judges.');
    const result = await run(db, `DELETE FROM judges WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    if (result.changes !== ids.length) throw invalid('One or more judges no longer exist.', 409);
    return {};
  }, true));
  router.put('/judge-management-settings', endpoint(async (req, db) => {
    const aliases = validateAliases(req.body.aliases);
    await run(db, 'UPDATE judge_management_settings SET aliases = ? WHERE id = 1', [JSON.stringify(aliases)]);
    return {};
  }, true));
  router.post('/judge-management-import', endpoint(async (req, db, aliases, today) => {
    const rows = await parseCsv(req.body.csv, aliases);
    const seen = new Set(); let added = 0, updated = 0;
    for (const [index, raw] of rows.entries()) {
      try {
        const associationId = String(raw.associationId || '').trim();
        if (!associationId) throw invalid('Association ID is required.');
        const idKey = associationId.toUpperCase();
        if (seen.has(idKey)) throw invalid('Duplicate Association ID in CSV.');
        seen.add(idKey);
        const [existing] = await all(db, `SELECT ${[...fields.map((f) => `${columns[f]} AS ${f}`), `${dateOfBirthColumn} AS dateOfBirth`].join(',')} FROM judges WHERE association_id = ? COLLATE NOCASE`, [associationId]);
        const merged = { ...(existing || {}) };
        for (const field of csvFields) if (raw[field] && raw[field].trim()) merged[field] = raw[field];
        const judge = validate(merged, today);
        const values = [...fields.map((f) => judge[f] || (f === 'rank' || f === 'expiration' ? null : '')), judge.dateOfBirth || null];
        if (existing) {
          await run(db, `UPDATE judges SET ${[...fields.map((f) => `${columns[f]} = ?`), `${dateOfBirthColumn} = ?`].join(',')} WHERE association_id = ? COLLATE NOCASE`, [...values, associationId]);
          updated++;
        } else {
          await run(db, `INSERT INTO judges (${[...fields.map((f) => columns[f]), dateOfBirthColumn].join(',')}) VALUES (${values.map(() => '?').join(',')})`, values);
          added++;
        }
      } catch (error) {
        if (error.statusCode) throw invalid(`CSV row ${index + 2}: ${error.message}`, error.statusCode);
        throw error;
      }
    }
    return { added, updated };
  }, true));
  return router;
}

module.exports = { createJudgeManagementRouter, defaults, evaluateEligibility };
