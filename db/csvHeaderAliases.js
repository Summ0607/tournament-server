const memberId = [
  'Association ID', 'Association Number', 'Association No', 'Assoc ID', 'Assoc Number', 'Assoc No',
  'WTSDA ID', 'WTSDA Number', 'WTSDA Membership Number', 'WTSDA Member ID',
  'TSD ID', 'TSD Number', 'Membership ID', 'Membership Number', 'Member ID', 'Member Number',
  'Association Member Number', 'Association/Member Number', 'What is your association number?',
  'What is your WTSDA number?', 'What is your member ID?'
];
const firstName = [
  'First Name', 'Given Name', 'Competitor First Name', 'Athlete First Name', 'Participant First Name',
  'Registrant First Name', 'What is your first name?'
];
const lastName = [
  'Last Name', 'Surname', 'Family Name', 'Competitor Last Name', 'Athlete Last Name', 'Participant Last Name',
  'Registrant Last Name', 'What is your last name?'
];
const dateOfBirth = [
  'DOB', 'Date of Birth', 'Birth Date', 'Birthdate', 'Date of Birth (MM/DD/YYYY)',
  'What is your date of birth?'
];
const school = [
  'School', 'School Name', 'Studio', 'Studio Name', 'Dojo', 'Dojo Name', 'Dojang', 'Dojang Name',
  'Club', 'Club Name', 'Training School', 'Training Location', 'Martial Arts School', 'School Affiliation'
];
const rank = [
  'Rank', 'Current Rank', 'Current Belt Rank', 'Belt Rank', 'Rank at Registration', 'Rank at Event',
  'Rank at Tournament', 'Rank at Time of Tournament', 'What is your current rank?'
];
const email = ['Email', 'Email Address', 'E-mail', 'E-mail Address'];
const phone = ['Phone', 'Phone Number', 'Contact Number', 'Contact Phone', 'Mobile', 'Mobile Number', 'Cell', 'Cell Phone', 'Telephone'];

const CSV_HEADER_ALIASES = Object.freeze({
  associationId: memberId,
  associationNumber: memberId,
  firstName,
  lastName,
  parentFirstName: ['Parent First Name', 'Parent/Guardian First Name', 'Guardian First Name'],
  parentLastName: ['Parent Last Name', 'Parent/Guardian Last Name', 'Guardian Last Name'],
  parentName: ['Parent/Guardian Name', 'Parent or Guardian Name', 'Parent Name', 'Guardian Name'],
  email,
  phone,
  contactNumber: phone,
  dob: dateOfBirth,
  dateOfBirth,
  gender: ['Gender', 'Sex'],
  rank,
  school,
  studio: school,
  certification: ['Certification', 'Certification Level', 'Judge Certification', 'Judging Certification', 'Judging Certification Level',
    'Judging Level', 'Judge Certification Level'],
  certificationLevel: ['Certification', 'Certification Level', 'Judge Certification', 'Judging Certification', 'Judging Certification Level',
    'Judging Level', 'Judge Certification Level'],
  expiration: [
    'Expiration', 'Expiration Date', 'Certification Expiration', 'Certification Expiration Date',
    'Certification Expires', 'Judging Level Expiration Date', 'JudgingLevelExpDate',
    'Judging Certification Expiration', 'Judge Certification Expiration'
  ],
  status: ['Status', 'Judge Status'],
  notes: ['Notes', 'Judge Notes', 'Judging Notes', 'Comments'],
  primaryType: [
    'Primary Volunteer Type', 'Primary Volunteer Choice', 'Primary Choice', 'First Choice',
    'First Volunteer Choice', 'Volunteer Choice 1', 'Volunteer Preference 1', 'Volunteer Role',
    'Volunteer Type', 'Role', 'What is your first volunteer choice?'
  ],
  secondaryType: [
    'Secondary Volunteer Type', 'Secondary Volunteer Choice', 'Secondary Choice', 'Second Choice',
    'Second Volunteer Choice', 'Volunteer Choice 2', 'Volunteer Preference 2', 'Alternate Volunteer Type',
    'Backup Choice', 'What is your second volunteer choice?'
  ],
  specialNeeds: ['Special Needs', 'Special Needs (Y|N)', 'Special Needs Y/N', 'Special Accommodations', 'Accommodation Needs'],
  height: ['Height', 'Height (inches)', 'Height Inches'],
  competitorId: ['ID', 'Competitor ID', 'Competitor Number', 'Registration ID', 'CompetitorId', 'Competitor_ID']
});

function normalizeCsvHeader(header) {
  return String(header ?? '').replace(/^\uFEFF/, '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function createCsvHeaderMapper(fields, customAliases = {}) {
  const mapping = new Map();
  for (const field of fields) {
    const aliases = [field, ...(CSV_HEADER_ALIASES[field] || []), ...(customAliases[field] || [])];
    for (const alias of aliases) {
      const normalized = normalizeCsvHeader(alias);
      if (!normalized) continue;
      const existing = mapping.get(normalized);
      if (existing && existing !== field) throw new Error(`CSV alias "${alias}" maps to multiple fields.`);
      mapping.set(normalized, field);
    }
  }
  return (header) => mapping.get(normalizeCsvHeader(header)) || null;
}

function inspectMappedCsvHeaders(headers, requiredFields = []) {
  const seen = new Set(), duplicates = new Set();
  for (const field of headers.filter((value) => typeof value === 'string' && value)) {
    if (seen.has(field)) duplicates.add(field);
    seen.add(field);
  }
  return { duplicates: [...duplicates], missing: requiredFields.filter((field) => !seen.has(field)) };
}

module.exports = { CSV_HEADER_ALIASES, createCsvHeaderMapper, inspectMappedCsvHeaders, normalizeCsvHeader };
