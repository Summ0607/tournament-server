(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DivisionRules = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function isSpecialNeeds(competitor) {
    return ['1', 'true', 'y', 'yes'].includes(String(competitor && competitor.specialNeeds != null ? competitor.specialNeeds : '').trim().toLowerCase());
  }

  function displayDivisionName(value) {
    return String(value || '').replace(/\bspecial needs\b/gi, 'Special Dragons');
  }

  function divisionBadge(group) {
    const competitors = Array.isArray(group && group.competitors) ? group.competitors : [];
    if (isSpecialNeeds(group) || competitors.some(isSpecialNeeds) ||
        /\bSpecial (?:Needs|Dragons)\b/i.test(String(group && group.name || ''))) {
      return { text: 'SD', label: 'Special Dragons' };
    }
    const ranks = competitors.map((competitor) => String(competitor.rank || competitor.rankCode || '').trim().toUpperCase());
    if (String(group && group.rankBand || '').toLowerCase() === 'd1-d3' ||
        group && group.rankCategory === 'Black Belt' || ranks.some((rank) => /^D[1-3]$/.test(rank))) {
      return { text: 'BB', label: 'Black Belt' };
    }
    if (ranks.some((rank) => /^G(?:10|[1-9])$/.test(rank) || rank === 'CDB')) {
      return { text: 'Gup', label: 'Gup (G10-CDB)' };
    }
    if (ranks.includes('TTLD') || /\bTTLD\b/.test(String(group && group.name || ''))) {
      return { text: 'TT', label: 'Tiny Tiger' };
    }
    return null;
  }

  function scheduleCategory(group) {
    const badge = divisionBadge(group);
    return badge ? badge.text : null;
  }

  function runningOrderAge(group) {
    const bracket = String(group && (group.ageBracket || group.macroAgeBracket || group.ageBucket) || '').trim();
    const ages = (Array.isArray(group && group.competitors) ? group.competitors : [])
      .map(ageOf).filter((age) => Number.isFinite(age) && age >= 0);
    const values = bracket.match(/\d+/g);
    if (values && !/mixed|unassigned|unknown/i.test(bracket)) {
      const min = /^under\s/i.test(bracket) ? 0 : Number(values[0]);
      const max = /^under\s/i.test(bracket) ? Number(values[0]) - 1
        : values.length > 1 ? Number(values[1]) : /up|\+/.test(bracket) ? 99 : min;
      if (!ages.some((age) => age < min || age > max)) return { min, max, mixed: false };
    }
    if (!ages.length) return { min: null, max: null, mixed: false };
    const min = Math.min(...ages);
    const max = Math.max(...ages);
    const bands = scheduleCategory(group) === 'SD' ? [[0, 12], [13, 17], [18, 99]]
      : [[0, 5], [6, 9], [10, 13], [14, 17], [18, 35], [36, 99]];
    const band = bands.find(([lower, upper]) => min >= lower && max <= upper);
    if (band && !values && !/mixed/i.test(bracket)) return { min: band[0], max: band[1], mixed: false };
    return { min, max, mixed: true };
  }

  function compareRunningOrder(a, b) {
    const priority = { BB: 0, TT: 1, SD: 1, Gup: 2 };
    const categoryA = scheduleCategory(a);
    const categoryB = scheduleCategory(b);
    const categoryOrder = (priority[categoryA] ?? 3) - (priority[categoryB] ?? 3);
    if (categoryOrder) return categoryOrder;
    const identityOrder = () => String(a && (a.groupDivisionNumber ?? a.id ?? a.groupId) || '')
      .localeCompare(String(b && (b.groupDivisionNumber ?? b.id ?? b.groupId) || ''), undefined, { numeric: true });
    if (!categoryA && !categoryB) return identityOrder();
    const ageA = runningOrderAge(a);
    const ageB = runningOrderAge(b);
    if (ageA.min == null && ageB.min != null) return 1;
    if (ageB.min == null && ageA.min != null) return -1;
    const ageOrder = categoryA === 'BB'
      ? (ageB.max ?? 0) - (ageA.max ?? 0) || (ageB.min ?? 0) - (ageA.min ?? 0)
      : (ageA.min ?? 0) - (ageB.min ?? 0) || (ageA.max ?? 0) - (ageB.max ?? 0);
    return ageOrder || identityOrder();
  }

  function ageOf(competitor) {
    if (!competitor) return null;
    if (competitor.age !== undefined && competitor.age !== null && competitor.age !== '' && Number.isFinite(Number(competitor.age))) {
      return Number(competitor.age);
    }
    const value = competitor.dob || competitor.dobIso || competitor.dateOfBirth;
    if (!value) return null;
    const dob = new Date(value);
    if (Number.isNaN(dob.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - dob.getFullYear();
    const monthDiff = now.getMonth() - dob.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dob.getDate())) age -= 1;
    return age;
  }

  function specialNeedsCategory(competitor) {
    const genderValue = String(competitor.gender || '').trim().toLowerCase();
    const gender = genderValue.startsWith('m') ? 'Male' : genderValue.startsWith('f') ? 'Female' : 'Unknown';
    const rank = String(competitor.rank || '').trim().toUpperCase();
    const rankCategory = rank === 'TTLD' ? 'TTLD'
      : /^D[1-3]$/.test(rank) ? 'Black Belt'
      : /^G(10|[1-9])$/.test(rank) || rank === 'CDB' ? 'Gup' : 'Unknown';
    const age = ageOf(competitor);
    const ageBracket = !Number.isInteger(age) || age < 4 || age > 99 ? 'Unknown'
      : age < 13 ? 'Under 13' : age < 18 ? '13-17' : '18 and up';
    return { gender, rankCategory, ageBracket };
  }

  function specialNeedsGroupError(competitors, { automatic = false } = {}) {
    if (!competitors.some(isSpecialNeeds)) return '';
    if (!competitors.every(isSpecialNeeds)) return 'Special Needs competitors cannot be combined with other competitors.';
    const first = specialNeedsCategory(competitors[0]);
    if (Object.values(first).includes('Unknown')) return 'Special Needs divisions require a known gender, eligible rank and valid age.';
    for (const competitor of competitors) {
      const category = specialNeedsCategory(competitor);
      if (Object.values(category).includes('Unknown')) return 'Special Needs divisions require a known gender, eligible rank and valid age.';
      if (category.gender !== first.gender) return 'Special Needs divisions must have the same gender.';
      if (automatic && category.rankCategory !== first.rankCategory) return 'Automatic Special Needs grouping keeps Black Belt, Gup and TTLD separate.';
      if (automatic && category.ageBracket !== first.ageBracket) return 'Automatic Special Needs grouping keeps age bands separate: Under 13, 13-17, and 18 and up.';
    }
    return '';
  }

  function validateSpecialNeedsGroups(groups) {
    for (const [index, group] of groups.entries()) {
      const reason = specialNeedsGroupError(Array.isArray(group.competitors) ? group.competitors : []);
      if (reason) {
        const error = new Error(`Division ${group.groupDivisionNumber || index + 1}: ${reason}`);
        error.code = 'INVALID_DIVISION_GROUP';
        throw error;
      }
    }
  }

  return { isSpecialNeeds, displayDivisionName, divisionBadge, scheduleCategory, runningOrderAge,
    compareRunningOrder, ageOf, specialNeedsCategory, specialNeedsGroupError, validateSpecialNeedsGroups };
});
