const TIMING_MODEL_VERSION = 2;
const MINUTE_MS = 60_000;

function entersDiscipline(competitor, discipline) {
  if (!competitor || competitor.checkInStatus === 'NO_SHOW') return false;
  const status = competitor.entries && competitor.entries[discipline] ||
    competitor[`${discipline}EntryStatus`];
  if (status === 'SCRATCHED') return false;
  const eligible = competitor[`${discipline}Eligible`];
  if ([true, 1, '1'].includes(eligible)) return true;
  if ([false, 0, '0'].includes(eligible)) return false;
  const division = competitor[`${discipline}Division`] ?? competitor[`${discipline}DivisionNumber`];
  if (division != null) {
    const value = String(division).trim().toLowerCase();
    return value !== '' && value !== 'unassigned';
  }
  return status === 'REGISTERED' || status === 'COMPLETED' || discipline !== 'weapons';
}

function estimateDivisionTiming(group) {
  const competitors = Array.isArray(group && group.competitors) ? group.competitors : [];
  const entrantCounts = Object.fromEntries(['weapons', 'hyungs', 'sparring'].map((discipline) => [
    discipline, competitors.filter((competitor) => entersDiscipline(competitor, discipline)).length
  ]));
  // Single elimination has N - 1 contested bouts; byes consume no bout time.
  const sparringBoutCount = Math.max(0, entrantCounts.sparring - 1);
  const sparringByeCount = entrantCounts.sparring > 1
    ? 2 ** Math.ceil(Math.log2(entrantCounts.sparring)) - entrantCounts.sparring : 0;
  const competitionMinutes = {
    weapons: entrantCounts.weapons * 1.5,
    hyungs: entrantCounts.hyungs * 1.5,
    sparring: sparringBoutCount * 2
  };
  const phaseDurationsMs = { setup: 7 * MINUTE_MS };
  const reviewDurationsMs = {};
  for (const [phase, minutes] of Object.entries(competitionMinutes)) {
    if (!entrantCounts[phase]) continue;
    // Review belongs to the preceding discipline, preserving the existing phase protocol.
    reviewDurationsMs[phase] = 3 * MINUTE_MS;
    phaseDurationsMs[phase] = minutes * MINUTE_MS + reviewDurationsMs[phase];
  }
  phaseDurationsMs.awards = 10 * MINUTE_MS;
  const estimatedDurationMs = Object.values(phaseDurationsMs).reduce((sum, duration) => sum + duration, 0);
  return {
    competitorCount: competitors.length,
    entrantCounts,
    sparringBoutCount,
    sparringByeCount,
    phases: Object.keys(phaseDurationsMs),
    phaseDurationsMs,
    reviewDurationsMs,
    estimatedDurationMs,
    estimatedDurationMinutes: Math.round(estimatedDurationMs / MINUTE_MS)
  };
}

module.exports = { TIMING_MODEL_VERSION, estimateDivisionTiming, entersDiscipline };
