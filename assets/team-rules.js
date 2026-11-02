(function (root) {
  function rankStrength(code) {
    if (code === 'TTLD') return 0;
    if (code === 'CDB') return 11;
    if (/^G(?:10|[1-9])$/.test(code)) return 11 - Number(code.slice(1));
    if (/^D(?:10|[1-9])$/.test(code)) return 11 + Number(code.slice(1));
    return NaN;
  }
  function compareCaptains(a, b) {
    return rankStrength(b.rank) - rankStrength(a.rank) || b.age - a.age || a.id - b.id;
  }
  const api = { rankStrength, compareCaptains };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TeamRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
