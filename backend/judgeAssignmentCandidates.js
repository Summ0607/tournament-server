const sqlite3 = require('sqlite3');
const { evaluateEligibility } = require('./judgeManagementRoutes');
const { readVolunteerDirectory } = require('./volunteerStore');
const { normalizeRank } = require('../db/rankNormalization');
const { certificationAgeIssue, certificationRankIssue, meetsMinimumCertification } = require('../db/judgeCertification');
const { validDate, storedAge } = require('./tournamentAge');

const all = (db, sql) => new Promise((resolve, reject) => db.all(sql, (error, rows) => error ? reject(error) : resolve(rows)));
async function readOnly(file, callback) {
  const db = await new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (error) => error ? reject(error) : resolve(connection));
  });
  try { return await callback(db); }
  finally { await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve())); }
}
async function judgeSnapshot(file, date) {
  validDate(date);
  return readOnly(file, async (db) => {
    await all(db, 'BEGIN');
    const [settings] = await all(db, 'SELECT revision FROM judge_management_settings WHERE id=1');
    if (!settings) throw new Error('Judge Management settings are missing.');
    const judges = await all(db, `SELECT id,association_id AS associationId,first_name AS firstName,last_name AS lastName,
      rank,certification,certification_expiration AS expiration,certification_granted_at AS grantedAt,date_of_birth AS dateOfBirth,status
      FROM judges`);
    const tests = await all(db, `SELECT judge_id AS judgeId,target_level AS targetLevel,written_date AS writtenDate,
      written_score AS writtenScore,practical_date AS practicalDate,practical_passed AS practicalPassed FROM judge_test_attempts`);
    const experience = await all(db, `SELECT judge_id AS judgeId,event_id AS eventId,event_name AS eventName,event_date AS eventDate,
      role,event_scope AS eventScope,log_verified AS logVerified FROM judge_experience`);
    await all(db, 'COMMIT');
    return { revision: settings.revision, judges: judges.map((judge) => {
      const { dateOfBirth, ...publicJudge } = judge;
      return { ...publicJudge, progression: evaluateEligibility(judge, tests, experience, date) };
    }) };
  });
}
async function assignmentCandidates({ eventFile, judgeFile, config }) {
  const snapshot = await judgeSnapshot(judgeFile, config.date);
  const directory = await readVolunteerDirectory(eventFile);
  const competitors = await readOnly(eventFile, (db) => all(db, `SELECT id,associationNumber,firstName,lastName,rank,age,ageAsOf FROM competitors`));
  const judgingTypes = new Set(directory.types.filter((type) => type.name.toLowerCase() === 'judging').map((type) => type.id));
  const members = new Map(snapshot.judges.map((judge) => [judge.associationId.toUpperCase(), judge]));
  const pool = new Map();
  for (const [source, rows] of [['volunteer', directory.volunteers.filter((row) => judgingTypes.has(row.primaryType) || judgingTypes.has(row.secondaryType))],
    ['competitor', competitors]]) {
    for (const row of rows) {
      const associationId = String(row.associationNumber || '').trim().toUpperCase();
      if (!associationId) continue;
      const member = members.get(associationId);
      if (source === 'competitor' && (!member || !meetsMinimumCertification(member.certification, 'SK_TK'))) continue;
      let candidate = pool.get(associationId);
      if (!candidate) {
        candidate = { id: associationId, associationId: member?.associationId || row.associationNumber,
          name: `${row.lastName}, ${row.firstName}`, rank: member?.rank || '', certification: member?.certification || 'UNKNOWN',
          expiration: member?.expiration || '', progression: member?.progression || null, sources: [], issues: [] };
        pool.set(associationId, candidate);
      }
      candidate.sources.push(source);
      if (!member) { candidate.issues.push('No Association ID match in Judge Management.'); continue; }
      const nameKey = (name) => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
      if (nameKey(row.firstName) !== nameKey(member.firstName) || nameKey(row.lastName) !== nameKey(member.lastName)) candidate.issues.push('Association ID matches but names differ; coordinator review required.');
      if (normalizeRank(row.rank).code !== member.rank) candidate.issues.push('Event rank differs from Judge Management; correct source data.');
      try {
        const age = storedAge(row, config.date);
        if (candidate.age !== undefined && age !== candidate.age) candidate.issues.push('Conflicting event ages.');
        candidate.age = age;
      } catch (error) { candidate.issues.push(error.message); }
      if (!member.expiration) candidate.issues.push('Certification expiration is missing.');
      else if (member.expiration < config.date) candidate.issues.push('Certification expires before the event date.');
      if (member.grantedAt && member.grantedAt > config.date) candidate.issues.push('Certification was granted after the event date.');
      if (/^(inactive|suspended|revoked)$/i.test(member.status)) candidate.issues.push(`Judge status is ${member.status}.`);
    }
  }
  const judges = [...pool.values()].map((judge) => {
    const cdbCorner = judge.certification === 'CORNER' && judge.rank === 'CDB';
    const issue = cdbCorner ? '' : certificationRankIssue(judge.certification, judge.rank);
    if (issue) judge.issues.push(issue);
    const roles = {}, roleIssues = {};
    for (const [position, required] of [['center', 'REGIONAL'], ['corner', 'CORNER'], ['sktk', 'SK_TK'], ['arbitrator', 'REGIONAL']]) {
      const minimumAge = position === 'sktk' ? null : position === 'corner' ? (config.scope === 'in-house' ? 15 : 16) : 18;
      roles[position] = !judge.issues.length && !(cdbCorner && position !== 'sktk') && meetsMinimumCertification(judge.certification, required) &&
        (minimumAge === null ? !certificationAgeIssue('SK_TK', judge.rank, judge.age, config.scope) : judge.age >= minimumAge);
      roleIssues[position] = judge.issues.length ? [...new Set(judge.issues)].join(' ') :
        cdbCorner && position !== 'sktk' ? 'Corner service requires Dan rank; SK/TK service is still permitted.' :
        !meetsMinimumCertification(judge.certification, required) ? `Requires ${required} certification.` :
          minimumAge === null ? certificationAgeIssue('SK_TK', judge.rank, judge.age, config.scope) :
            judge.age < minimumAge ? `Requires age ${minimumAge} or older.` : '';
    }
    return { ...judge, roles, roleIssues, qualificationIssue: [...new Set(judge.issues)].join(' '),
      potential: !judge.sources.includes('volunteer') };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { judges, judgeRevision: snapshot.revision, volunteerRevision: directory.revision,
    sourceFingerprint: JSON.stringify({ competitors, volunteers: directory.volunteers, types: directory.types }) };
}
module.exports = { assignmentCandidates, judgeSnapshot };
