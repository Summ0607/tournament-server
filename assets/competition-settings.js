(function (root) {
  const schemas = {
    'competition-types': { title: 'Competition Types', singular: 'Type', fields: [
      ['name', 'Name', 'text'], ['code', 'Code', 'text'], ['description', 'Description', 'text'], ['isTeam', 'Is Team', 'boolean']
    ] },
    'grand-champion-categories': { title: 'Grand Champion Categories', singular: 'Category', fields: [
      ['name', 'Name', 'text'], ['gender', 'Gender', 'gender'], ['minAge', 'Minimum Age', 'age'],
      ['maxAge', 'Maximum Age', 'age'], ['minRank', 'Lowest Rank', 'rank'], ['maxRank', 'Highest Rank', 'rank']
    ] },
    'medal-points': { title: 'Medal Points', singular: 'Medal', fields: [['name', 'Medal Title', 'text'], ['points', 'Points', 'points']] }
  };
  const rankCodes = [...Array.from({ length: 10 }, (_, i) => `G${10 - i}`), 'CDB', 'D1', 'D2', 'D3'];
  function defaults(kind) {
    let rows;
    if (kind === 'competition-types') rows = [
      ['Traditional Hyung', 'H', 'Traditional hyungs/forms competition', false],
      ['Traditional Weapons', 'W', 'Traditional weapons forms competition', false],
      ['Point Sparring', 'S', 'Point sparring competition', false],
      ['Breaking', 'B', 'Board breaking competition', false],
      ['Team Sparring', 'TS', 'Team point sparring competition', true],
      ['Creative Hyung', 'CH', 'Creative forms competition', false],
      ['Creative Demonstration', 'D', 'Creative demonstration competition', false],
      ['Team Hyung', 'TH', 'Team hyung/forms competition', true]
    ].map(([name, code, description, isTeam]) => ({ name, code, description, isTeam }));
    else if (kind === 'medal-points') rows = [['1st Place', 10], ['2nd Place', 8], ['3rd Place', 5], ['3rd Place (2)', 5]]
      .map(([name, points]) => ({ name, points }));
    else if (kind === 'grand-champion-categories') {
      rows = [];
      for (const [age, minAge, maxAge] of [['Adult', 18, 34], ['Senior', 35, 110], ['Youth', 1, 17]]) {
        for (const gender of ['F', 'M']) for (const black of [true, false]) {
          rows.push({ name: `${age} ${gender === 'F' ? 'Female' : 'Male'} ${black ? 'Black Belt' : 'Gup'} Champion`,
            gender, minAge, maxAge, minRank: black ? 'D1' : 'G10', maxRank: black ? 'D3' : 'CDB' });
        }
      }
    } else throw new Error('Unknown competition settings section.');
    return rows.map((row, i) => ({ id: `${kind}-${i + 1}`, ...row }));
  }
  function validate(kind, input) {
    const schema = schemas[kind];
    if (!schema || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Valid settings details are required.');
    const result = {};
    for (const [key, label, type] of schema.fields) {
      const value = input[key];
      if (type === 'text') {
        const max = key === 'description' ? 1000 : 200;
        if (typeof value !== 'string' || value.trim().length > max || key !== 'description' && !value.trim()) throw new Error(`${label} is required and must be at most ${max} characters.`);
        result[key] = value.trim();
      } else {
        const valid = type === 'boolean' ? typeof value === 'boolean' : type === 'gender' ? ['F', 'M'].includes(value)
          : type === 'rank' ? rankCodes.includes(value)
          : Number.isSafeInteger(value) && value >= 0 && value <= (type === 'age' ? 120 : 10000);
        if (!valid) throw new Error(`Invalid ${label}.`);
        result[key] = value;
      }
    }
    if (kind === 'competition-types') {
      result.code = result.code.toUpperCase();
      if (!/^[A-Z][A-Z0-9]{0,9}$/.test(result.code)) throw new Error('Code must contain 1-10 letters/numbers and begin with a letter.');
    }
    if (kind === 'grand-champion-categories' && (result.minAge > result.maxAge || rankCodes.indexOf(result.minRank) > rankCodes.indexOf(result.maxRank))) {
      throw new Error('Minimum age/rank must not exceed maximum age/rank.');
    }
    return result;
  }
  const api = { schemas, rankCodes, defaults, validate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CompetitionSettingsRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
