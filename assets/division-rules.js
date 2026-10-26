(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DivisionRules = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function isSpecialNeeds(competitor) {
    return ['1', 'true', 'y', 'yes'].includes(String(competitor && competitor.specialNeeds != null ? competitor.specialNeeds : '').trim().toLowerCase());
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

  return { isSpecialNeeds, ageOf, specialNeedsCategory, specialNeedsGroupError, validateSpecialNeedsGroups };
});
