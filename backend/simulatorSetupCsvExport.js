const fs = require('node:fs');
const path = require('node:path');
const { ageOnDate, validDate } = require('./tournamentAge');
const { normalizeRank } = require('../db/rankNormalization');
const { DEFAULT_VOLUNTEER_TYPES } = require('../db/volunteerTypes');
const { certificationRankIssue, isJudgeRank, normalizeCertification, normalizeExperienceRole } = require('../db/judgeCertification');
const { normalizeCompetitorRow } = require('../db/import-csv');
const { validateVolunteer } = require('./volunteerRoutes');

const competitorHeaders = ['firstName', 'lastName', 'parentFirstName', 'parentLastName', 'email', 'phone',
  'dob', 'associationNumber', 'gender', 'rank', 'studio', 'specialNeeds', 'height', 'competitorId'];
const volunteerHeaders = ['First Name', 'Last Name', 'DOB', 'Assoc ID', 'School', 'Rank', 'Certification',
  'Primary Volunteer Type', 'Secondary Volunteer Type', 'Parent First Name', 'Parent Last Name',
  'Parent/Guardian Name', 'Contact Number', 'Gender', 'Email'];
const judgeHeaders = ['associationId', 'firstName', 'lastName', 'school', 'rank', 'certification',
  'expiration', 'status', 'notes', 'dateOfBirth'];

function fail(message) {
  throw new Error(`Invalid simulation setup: ${message}`);
}

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be nonempty text.`);
  return value.trim();
}

function validateSetup(setup) {
  if (!setup || typeof setup !== 'object' || Array.isArray(setup) || !setup.profile) fail('profile is required.');
  const { profile, competitors, volunteers, judges, priorExperience } = setup;
  for (const [name, rows] of Object.entries({ competitors, volunteers, judges, priorExperience })) {
    if (!Array.isArray(rows)) fail(`${name} must be an array.`);
  }
  validDate(profile.eventDate);
  if (!Number.isSafeInteger(profile.competitorCount) || profile.competitorCount !== competitors.length ||
      profile.judgeRequirementCount !== profile.ringCount * 7 ||
      profile.judgeTargetCount !== Math.ceil(profile.judgeRequirementCount * 1.2) ||
      profile.judgingVolunteerCount + profile.otherVolunteerCount !== volunteers.length ||
      profile.volunteerCount !== volunteers.length ||
      profile.judgeCount !== judges.length || profile.priorExperienceCount !== priorExperience.length) {
    fail('profile counts do not match the roster arrays.');
  }

  const competitorIds = new Set();
  let competitorRankWarnings = 0;
  for (const [index, person] of competitors.entries()) {
    const row = normalizeCompetitorRow({
      ...person,
      associationNumber: person.associationId,
      id: person.competitorId
    }, index + 1, profile.eventDate);
    if (!row.rank) fail(`competitor ${index + 1} has an unrecognized rank.`);
    if (row.rankWarning) competitorRankWarnings += 1;
    if (!['Male', 'Female'].includes(row.gender)) fail(`competitor ${index + 1} has an invalid gender.`);
    if (competitorIds.has(row.associationNumber.toUpperCase())) fail('competitor Association IDs must be unique.');
    competitorIds.add(row.associationNumber.toUpperCase());
  }

  const types = DEFAULT_VOLUNTEER_TYPES.map(([id, name]) => ({ id, name }));
  const typeNames = new Map(types.map((type) => [type.id, type.name]));
  const volunteerIds = new Set();
  for (const [index, person] of volunteers.entries()) {
    const associationNumber = requireText(person.associationNumber, `volunteer ${index + 1} Association ID`);
    const key = associationNumber.toUpperCase();
    if (volunteerIds.has(key)) fail('volunteer Association IDs must be unique.');
    volunteerIds.add(key);
    if (person.primaryType === 'judging' && competitorIds.has(key)) {
      fail(`judging volunteer ${associationNumber} is already included as a competitor judge.`);
    }
    const primaryType = typeNames.get(person.primaryType);
    const secondaryType = person.secondaryType ? typeNames.get(person.secondaryType) : '';
    if (!primaryType || person.secondaryType && !secondaryType) fail(`volunteer ${index + 1} has an unknown volunteer type.`);
    const normalized = validateVolunteer({
      ...person,
      associationNumber,
      school: person.school || person.studio,
      primaryType: person.primaryType,
      secondaryType: person.secondaryType || ''
    }, types, profile.eventDate, false, '');
    if (normalized.age !== ageOnDate(person.dob, profile.eventDate)) fail(`volunteer ${index + 1} has an inconsistent age.`);
  }

  const judgesById = new Map();
  for (const [index, judge] of judges.entries()) {
    const associationId = requireText(judge.associationId, `judge ${index + 1} Association ID`);
    const key = associationId.toUpperCase();
    if (judgesById.has(key)) fail('judge Association IDs must be unique.');
    const rank = normalizeRank(judge.rank);
    if (!rank.recognized || !isJudgeRank(rank.code)) fail(`judge ${index + 1} has an invalid judge rank.`);
    const certification = normalizeCertification(judge.certification);
    if (!certification.recognized) fail(`judge ${index + 1} has an unrecognized certification.`);
    const rankIssue = certificationRankIssue(certification.code, rank.code);
    if (rankIssue) fail(`judge ${index + 1}: ${rankIssue}`);
    const dob = requireText(judge.dateOfBirth, `judge ${index + 1} date of birth`);
    if (ageOnDate(dob, profile.eventDate) < 0) fail(`judge ${index + 1} has an invalid date of birth.`);
    judgesById.set(key, { ...judge, associationId, rank: rank.code, certification: certification.code });
  }
  for (const volunteer of volunteers.filter((person) => person.primaryType === 'judging')) {
    const judge = judgesById.get(volunteer.associationNumber.toUpperCase());
    if (!judge || judge.certification !== normalizeCertification(volunteer.certification).code) {
      fail(`judging volunteer ${volunteer.associationNumber} has no matching judge record.`);
    }
  }
  const competitorJudgeCount = [...competitorIds].filter((associationId) => judgesById.has(associationId)).length;
  const judgingVolunteers = volunteers.filter((person) => person.primaryType === 'judging');
  if (competitorJudgeCount !== profile.competitorJudgeCount ||
      competitorJudgeCount + judgingVolunteers.length !== profile.judgeTargetCount ||
      judgingVolunteers.length !== profile.judgingVolunteerCount) {
    fail('judge coverage does not match the competitor and volunteer records.');
  }
  const countRole = (role) => volunteers.filter((person) =>
    person.primaryType === role || person.secondaryType === role).length;
  const setupTeardownVolunteers = volunteers.filter((person) =>
    ['setup', 'teardown'].includes(person.primaryType) ||
    ['setup', 'teardown'].includes(person.secondaryType));
  const supportCountsMatch = countRole('setup') === profile.setupVolunteerCount &&
    countRole('teardown') === profile.teardownVolunteerCount &&
    setupTeardownVolunteers.length === profile.setupTeardownUniqueCount &&
    setupTeardownVolunteers.filter((person) => person.secondaryType === 'teardown').length ===
      profile.setupTeardownOverlapCount &&
    countRole('security') === profile.securityVolunteerCount &&
    countRole('operations') === profile.operationsVolunteerCount &&
    countRole('awards') === profile.awardsVolunteerCount &&
    countRole('medical') === profile.medicalVolunteerCount &&
    profile.setupVolunteerCount >= 3 && profile.setupVolunteerCount <= 6 &&
    profile.teardownVolunteerCount >= 3 && profile.teardownVolunteerCount <= 6 &&
    profile.setupTeardownUniqueCount <= 9 &&
    profile.securityVolunteerCount === Math.min(10, Math.max(2, Math.ceil(profile.ringCount / 2))) &&
    profile.operationsVolunteerCount === Math.min(10, Math.max(4, Math.ceil(profile.ringCount / 2) + 2)) &&
    profile.awardsVolunteerCount === 2 && profile.medicalVolunteerCount === 2 &&
    profile.otherVolunteerCount === volunteers.length - judgingVolunteers.length;
  if (!supportCountsMatch) fail('support volunteer roles do not match the staffing rules.');
  for (const role of ['setup', 'teardown', 'security', 'operations', 'awards', 'medical']) {
    if (countRole(role) !== profile[`${role}VolunteerCount`]) {
      fail(`support role ${role} does not match its profile count.`);
    }
  }

  const experienceIds = new Set();
  for (const [index, record] of priorExperience.entries()) {
    const key = requireText(record.associationId, `experience ${index + 1} Association ID`).toUpperCase();
    const judge = judgesById.get(key);
    if (!judge) fail(`experience ${index + 1} has no matching judge record.`);
    if (experienceIds.has(key)) fail('each judge may have only one prior-experience record.');
    experienceIds.add(key);
    validDate(record.eventDate);
    if (!requireText(record.eventId, `experience ${index + 1} event ID`) ||
        !requireText(record.eventName, `experience ${index + 1} event name`) ||
        !requireText(record.location, `experience ${index + 1} location`) ||
        !requireText(record.sourceId, `experience ${index + 1} source ID`) ||
        normalizeExperienceRole(record.role) !== record.role ||
        record.source !== 'SIMULATION' || record.logVerified !== false) {
      fail(`experience ${index + 1} has invalid service fields.`);
    }
    if (record.eventDate >= profile.eventDate) fail(`experience ${index + 1} must predate the tournament.`);
  }
  return { profile, competitors, volunteers, judges, priorExperience, judgesById, typeNames, competitorRankWarnings };
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text) || /^\s*[=+\-@]/.test(text)) {
    fail('CSV values may not contain control characters or spreadsheet formulas.');
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function csvFile(headers, records) {
  return `${[headers, ...records.map((record) => headers.map((header) => record[header] ?? ''))]
    .map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function buildCsvFilesFromValidated(validated) {
  const competitors = validated.competitors.map((person) => ({
    ...person,
    associationNumber: person.associationId
  }));
  const volunteers = validated.volunteers.map((person) => ({
    firstName: person.firstName,
    lastName: person.lastName,
    dob: person.dob,
    associationNumber: person.associationNumber,
    school: person.school || person.studio,
    rank: person.rank,
    certification: person.certification,
    primaryType: validated.typeNames.get(person.primaryType),
    secondaryType: person.secondaryType ? validated.typeNames.get(person.secondaryType) : '',
    parentFirstName: person.parentFirstName,
    parentLastName: person.parentLastName,
    parentName: person.parentName,
    contactNumber: person.contactNumber,
    gender: person.gender,
    email: person.email
  }));
  const judges = validated.judges.map((judge) => ({
    associationId: judge.associationId,
    firstName: judge.firstName,
    lastName: judge.lastName,
    school: judge.school,
    rank: judge.rank,
    certification: judge.certification,
    expiration: '',
    status: judge.status,
    notes: judge.notes,
    dateOfBirth: judge.dateOfBirth
  }));
  return {
    'competitors.csv': csvFile(competitorHeaders, competitors),
    'volunteers.csv': csvFile(volunteerHeaders, volunteers.map((row) => ({
      'First Name': row.firstName,
      'Last Name': row.lastName,
      DOB: row.dob,
      'Assoc ID': row.associationNumber,
      School: row.school,
      Rank: row.rank,
      Certification: row.certification,
      'Primary Volunteer Type': row.primaryType,
      'Secondary Volunteer Type': row.secondaryType,
      'Parent First Name': row.parentFirstName,
      'Parent Last Name': row.parentLastName,
      'Parent/Guardian Name': row.parentName,
      'Contact Number': row.contactNumber,
      Gender: row.gender,
      Email: row.email
    }))),
    'judges.csv': csvFile(judgeHeaders, judges)
  };
}

function buildCsvFiles(setup) {
  return buildCsvFilesFromValidated(validateSetup(setup));
}

function buildPreparationFiles(setup) {
  const validated = validateSetup(setup);
  const requestsByAssociationId = new Map();
  for (const record of validated.priorExperience) {
    const associationId = record.associationId;
    if (!requestsByAssociationId.has(associationId)) {
      requestsByAssociationId.set(associationId, { associationId, records: [] });
    }
    requestsByAssociationId.get(associationId).records.push({
      eventId: record.eventId,
      eventName: record.eventName,
      eventDate: record.eventDate,
      location: record.location,
      role: record.role,
      eventScope: record.eventScope,
      phase: record.phase,
      source: record.source,
      sourceId: record.sourceId,
      logVerified: false
    });
  }
  const files = {
    'setup.json': `${JSON.stringify(setup, null, 2)}\n`,
    ...buildCsvFilesFromValidated(validated),
    'experience-api.json': `${JSON.stringify([...requestsByAssociationId.values()], null, 2)}\n`
  };
  return {
    files,
    summary: {
      competitorCount: validated.competitors.length,
      volunteerCount: validated.volunteers.length,
      judgeCount: validated.judges.length,
      priorExperienceCount: validated.priorExperience.length,
      experienceRequestCount: requestsByAssociationId.size,
      competitorRankWarnings: validated.competitorRankWarnings
    }
  };
}

function writeCsvFiles(files, outputDirectory) {
  const output = path.resolve(outputDirectory);
  if (fs.existsSync(output)) throw new Error(`Output directory already exists: ${output}`);
  const parent = path.dirname(output);
  if (!fs.statSync(parent).isDirectory()) throw new Error(`Output parent is not a directory: ${parent}`);
  const staging = fs.mkdtempSync(path.join(parent, '.simulator-setup-export-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(staging, name), contents, { encoding: 'utf8', flag: 'wx' });
    }
    fs.renameSync(staging, output);
  } catch (error) {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return output;
}

function parseArguments(args) {
  if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output-dir' ||
      !args[1] || !args[3]) {
    throw new Error('Use --input SETUP.json --output-dir NEW_DIRECTORY.');
  }
  return { input: path.resolve(args[1]), outputDirectory: path.resolve(args[3]) };
}

function main(args) {
  const { input, outputDirectory } = parseArguments(args);
  const setup = JSON.parse(fs.readFileSync(input, 'utf8'));
  const { files, summary } = buildPreparationFiles(setup);
  const output = writeCsvFiles(files, outputDirectory);
  console.log(`Created preparation files in ${output}: ${summary.competitorCount} competitors, ${summary.volunteerCount} volunteers, ${summary.judgeCount} judges, ${summary.priorExperienceCount} prior-experience records, and ${summary.experienceRequestCount} API requests.`);
  if (summary.competitorRankWarnings) console.warn(`${summary.competitorRankWarnings} competitor row(s) will be flagged by the existing import flow as ineligible by rank and require review.`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { buildCsvFiles, buildPreparationFiles, main, validateSetup, writeCsvFiles };
