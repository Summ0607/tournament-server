// Canonical judging certification levels stored for Ring Judges and Volunteers,
// ordered from least to most qualified. Shared by judge/ring assignment and
// judge management so every surface uses the same codes, labels and rules.
const { isCanonicalRank, formatRankForDisplay } = require('./rankNormalization');

// Judge-eligible rank codes from least to most senior. Judge qualifications
// span G5 through D8; CDB (Cho Dan Bo) sits between G1 and D1.
const JUDGE_RANKS = ['G5', 'G4', 'G3', 'G2', 'G1', 'CDB', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'];
const DAN_NAMES = ['Cho Dan', 'E Dan', 'Sam Dan', 'Sah Dan', 'Oh Dan', 'Yuk Dan', 'Chil Dan', 'Pal Dan'];

function judgeRankOptions() {
  return JUDGE_RANKS.map((code) => ({
    code, label: code.startsWith('D') ? DAN_NAMES[Number(code.slice(1)) - 1] : formatRankForDisplay(code)
  }));
}

// minimumRank reflects the WTSDA Judging Certification Program:
// scorekeeper/timekeeper is open to 5th gup and higher (or Cho Dan Bo),
// corner and regional center judges must be Dan members, and
// international judges must be E Dan (2nd Dan) or higher.
const LEVELS = [
  { code: 'UNKNOWN', label: 'Unknown', minimumRank: '' },
  { code: 'UNCERTIFIED', label: 'Uncertified', minimumRank: '' },
  { code: 'SK_TK', label: 'SK/TK', minimumRank: 'G5' },
  { code: 'CORNER', label: 'Corner', minimumRank: 'D1' },
  { code: 'REGIONAL', label: 'Regional (Center)', minimumRank: 'D1' },
  { code: 'INTERNATIONAL', label: 'International', minimumRank: 'D2' }
];

// Keys are input lowercased with non-alphanumerics removed.
const ALIASES = {
  '': 'UNKNOWN', unknown: 'UNKNOWN',
  uncertified: 'UNCERTIFIED', notcertified: 'UNCERTIFIED', none: 'UNCERTIFIED',
  sktk: 'SK_TK', sk: 'SK_TK', tk: 'SK_TK',
  scorekeeper: 'SK_TK', timekeeper: 'SK_TK', scorekeepertimekeeper: 'SK_TK', timekeeperscorekeeper: 'SK_TK',
  corner: 'CORNER', cornerjudge: 'CORNER', certifiedcorner: 'CORNER',
  regional: 'REGIONAL', center: 'REGIONAL', regionalcenter: 'REGIONAL', regionalcenterjudge: 'REGIONAL', centerjudge: 'REGIONAL',
  international: 'INTERNATIONAL', internationaljudge: 'INTERNATIONAL'
};

const byCode = new Map(LEVELS.map((level) => [level.code, level]));

function isJudgeRank(code) {
  return JUDGE_RANKS.includes(String(code || ''));
}

/**
 * Normalizes free-form certification text into a canonical level code.
 * Returns { code, recognized, raw }. Missing input is a recognized Unknown;
 * unrecognized text falls back to UNKNOWN with recognized false.
 */
function normalizeCertification(value) {
  const raw = value === null || value === undefined ? '' : String(value).trim();
  const compact = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  const code = ALIASES[compact] || (byCode.has(raw.toUpperCase().replace(/[^A-Z0-9]/g, '_')) ? raw.toUpperCase().replace(/[^A-Z0-9]/g, '_') : '');
  return code ? { code, recognized: true, raw } : { code: 'UNKNOWN', recognized: false, raw };
}

/** Ordered level list for API payloads and UI dropdowns. */
function certificationLevels() {
  return LEVELS.map((level) => ({ ...level }));
}

function formatCertificationForDisplay(code) {
  const level = byCode.get(String(code || '').trim());
  return level ? level.label : 'Unknown';
}

/** True when `code` is at least as qualified as `required`. Unknown codes rank lowest. */
function meetsMinimumCertification(code, required) {
  const index = LEVELS.findIndex((level) => level.code === code);
  const requiredIndex = LEVELS.findIndex((level) => level.code === required);
  return requiredIndex >= 0 && index >= requiredIndex;
}

/**
 * Validates a canonical rank against a canonical certification level.
 * Returns '' when consistent, otherwise a human-readable problem description.
 */
function certificationRankIssue(certificationCode, rankCode) {
  const level = byCode.get(String(certificationCode || ''));
  if (!level || !level.minimumRank) return '';
  if (!isCanonicalRank(rankCode) || !isJudgeRank(rankCode) ||
      JUDGE_RANKS.indexOf(rankCode) < JUDGE_RANKS.indexOf(level.minimumRank)) {
    return `${level.label} certification requires rank ${level.minimumRank} or higher.`;
  }
  return '';
}

function certificationAgeIssue(certificationCode, rankCode, age) {
  if (certificationCode !== 'SK_TK' || !isJudgeRank(rankCode)) return '';
  const minimumAge = rankCode === 'CDB' ? 14 : 16;
  return Number.isInteger(age) && age >= minimumAge ? '' :
    `SK/TK certification requires age ${minimumAge} or older for rank ${rankCode}.`;
}

module.exports = {
  JUDGE_RANKS,
  judgeRankOptions,
  normalizeCertification,
  certificationLevels,
  formatCertificationForDisplay,
  meetsMinimumCertification,
  certificationRankIssue,
  certificationAgeIssue,
  isJudgeRank
};
