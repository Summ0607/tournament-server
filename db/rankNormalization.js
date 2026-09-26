// Canonical competitor rank codes stored in SQLite:
//   TTLD, G10..G1 (Gups), CDB (Cho Dan Bo), D1..D10 (Dans)
const MAX_GUP = 10;
const MAX_DAN = 10;

const NUMBER_WORDS = {
  one: 1, first: 1,
  two: 2, second: 2,
  three: 3, third: 3,
  four: 4, fourth: 4,
  five: 5, fifth: 5,
  six: 6, sixth: 6,
  seven: 7, seventh: 7,
  eight: 8, eighth: 8,
  nine: 9, ninth: 9,
  ten: 10, tenth: 10
};

// Korean Dan names (e.g. "Cho Dan" = 1st Dan, "E Dan" = 2nd Dan).
const KOREAN_DAN_NUMBERS = {
  cho: 1,
  e: 2, ee: 2, yi: 2,
  sam: 3,
  sa: 4, sah: 4,
  o: 5, oh: 5
};

const GUP_WORDS = new Set(['gup', 'kup', 'geup', 'keup']);
const DAN_WORDS = new Set(['dan', 'degree']);

function isCanonicalRank(code) {
  const value = String(code || '');
  if (value === 'TTLD' || value === 'CDB') return true;
  const match = /^([GD])(\d{1,2})$/.exec(value);
  if (!match) return false;
  const number = Number(match[2]);
  const max = match[1] === 'G' ? MAX_GUP : MAX_DAN;
  return String(number) === match[2] && number >= 1 && number <= max;
}

function buildCode(prefix, number) {
  const max = prefix === 'G' ? MAX_GUP : MAX_DAN;
  if (!Number.isInteger(number) || number < 1 || number > max) return '';
  return `${prefix}${number}`;
}

function parseNumberToken(token) {
  const numeric = /^(\d{1,2})(st|nd|rd|th)?$/.exec(token);
  if (numeric) return Number(numeric[1]);
  return Object.prototype.hasOwnProperty.call(NUMBER_WORDS, token) ? NUMBER_WORDS[token] : null;
}

function unrecognized(raw, reason) {
  return { code: '', recognized: false, raw, reason };
}

/**
 * Normalizes a raw registration-export rank string into a canonical code.
 * Returns { code, recognized, raw, reason }. Unrecognized input yields code ''.
 */
function normalizeRank(value) {
  const raw = value === null || value === undefined ? '' : String(value).trim();
  if (!raw) return unrecognized(raw, 'missing rank');

  const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (compact === 'TTLD') return { code: 'TTLD', recognized: true, raw, reason: '' };
  if (compact === 'CDB' || compact === 'CHODANBO') return { code: 'CDB', recognized: true, raw, reason: '' };

  const shorthand = /^([GD])(\d{1,2})$/.exec(compact);
  if (shorthand) {
    const code = buildCode(shorthand[1], Number(shorthand[2]));
    return code
      ? { code, recognized: true, raw, reason: '' }
      : unrecognized(raw, 'rank number out of range');
  }

  const words = raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

  for (let i = 0; i + 2 < words.length; i += 1) {
    if (words[i] === 'cho' && words[i + 1] === 'dan' && words[i + 2] === 'bo') {
      return { code: 'CDB', recognized: true, raw, reason: '' };
    }
  }

  const isGup = words.some((word) => GUP_WORDS.has(word));
  const isDan = words.some((word) => DAN_WORDS.has(word));
  if (isGup === isDan) {
    return unrecognized(raw, isGup ? 'ambiguous gup/dan rank' : 'unrecognized rank format');
  }

  const numbers = words.map(parseNumberToken).filter((number) => number !== null);
  if (numbers.length > 1) return unrecognized(raw, 'ambiguous rank number');

  let number = numbers.length === 1 ? numbers[0] : null;
  if (number === null && isDan) {
    const danIndex = words.indexOf('dan');
    const korean = danIndex > 0 ? words[danIndex - 1] : '';
    if (Object.prototype.hasOwnProperty.call(KOREAN_DAN_NUMBERS, korean)) {
      number = KOREAN_DAN_NUMBERS[korean];
    }
  }
  if (number === null) return unrecognized(raw, 'missing rank number');

  const code = buildCode(isGup ? 'G' : 'D', number);
  return code
    ? { code, recognized: true, raw, reason: '' }
    : unrecognized(raw, 'rank number out of range');
}

function ordinal(number) {
  const lastTwo = number % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${number}th`;
  switch (number % 10) {
    case 1: return `${number}st`;
    case 2: return `${number}nd`;
    case 3: return `${number}rd`;
    default: return `${number}th`;
  }
}

/**
 * Human-readable rank label for winner lists, certificates, and formal reports.
 * Example: formatRankForDisplay('G2') -> '2nd Gup', formatRankForDisplay('D1') -> '1st Dan'.
 */
function formatRankForDisplay(code) {
  const input = String(code || '').trim();
  const canonical = isCanonicalRank(input) ? input : normalizeRank(input).code;
  if (!canonical) return input || 'Unranked';
  if (canonical === 'TTLD') return 'TTLD';
  if (canonical === 'CDB') return 'Cho Dan Bo';
  const number = Number(canonical.slice(1));
  return `${ordinal(number)} ${canonical[0] === 'G' ? 'Gup' : 'Dan'}`;
}

module.exports = {
  normalizeRank,
  formatRankForDisplay,
  isCanonicalRank
};
