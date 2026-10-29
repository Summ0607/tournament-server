const assert = require('node:assert/strict');
const test = require('node:test');

const { estimateDivisionTiming } = require('../backend/simulatorTiming');

test('estimates practical division duration from roster size and applicable phases', () => {
  const timing = estimateDivisionTiming({
    groupDivisionNumber: 12,
    competitors: Array.from({ length: 25 }, (_, index) => ({
      id: String(index),
      weaponsEligible: true
    }))
  }, { scenarioSeed: 'tournament', ringId: 'ring-a-1' });

  assert.deepEqual(timing.phases, ['setup', 'weapons', 'hyungs', 'sparring', 'awards']);
  assert.ok(timing.estimatedDurationMinutes > 60);
  assert.ok(timing.phaseDurationsMs.sparring > timing.phaseDurationsMs.setup);
});

test('omits weapons phase when no competitors are eligible and shares the same baseline across seeds', () => {
  const group = {
    groupDivisionNumber: 7,
    competitors: Array.from({ length: 20 }, () => ({ weaponsDivision: 'unassigned' }))
  };
  const first = estimateDivisionTiming(group, { scenarioSeed: 'same-seed', ringId: 'ring-a-1' });
  const replay = estimateDivisionTiming(group, { scenarioSeed: 'same-seed', ringId: 'ring-a-1' });
  const different = estimateDivisionTiming(group, { scenarioSeed: 'other-seed', ringId: 'ring-a-1' });

  assert.deepEqual(first, replay);
  assert.ok(!first.phases.includes('weapons'));
  assert.deepEqual(first.phaseDurationsMs, different.phaseDurationsMs);
});

test('eight all-discipline entrants take exactly 64 minutes including three reviews', () => {
  const timing = estimateDivisionTiming({
    competitors: Array.from({ length: 8 }, () => ({ weaponsEligible: true }))
  });
  assert.deepEqual(timing.entrantCounts, { weapons: 8, hyungs: 8, sparring: 8 });
  assert.equal(timing.sparringBoutCount, 7);
  assert.deepEqual(timing.phaseDurationsMs, {
    setup: 420_000, weapons: 900_000, hyungs: 900_000, sparring: 1_020_000, awards: 600_000
  });
  assert.equal(timing.estimatedDurationMs, 64 * 60_000);
  assert.equal(Object.values(timing.reviewDurationsMs).reduce((sum, value) => sum + value, 0), 9 * 60_000);
});

test('counts actual discipline entrants and excludes scratches, no-shows and byes', () => {
  const timing = estimateDivisionTiming({ competitors: [
    { weaponsEligible: true },
    { weaponsEligible: false, hyungsEntryStatus: 'SCRATCHED' },
    { weaponsEligible: true, sparringEntryStatus: 'SCRATCHED' },
    { weaponsEligible: true, checkInStatus: 'NO_SHOW' },
    { weaponsDivision: 'unassigned', sparringDivision: 'unassigned' }
  ] });
  assert.deepEqual(timing.entrantCounts, { weapons: 2, hyungs: 3, sparring: 2 });
  assert.equal(timing.sparringBoutCount, 1);
  assert.equal(timing.phaseDurationsMs.sparring, 5 * 60_000);
  assert.equal(estimateDivisionTiming({ competitors: [{}] }).sparringBoutCount, 0);
  const seven = estimateDivisionTiming({ competitors: Array.from({ length: 7 }, () => ({})) });
  assert.equal(seven.sparringBoutCount, 6);
  assert.equal(seven.sparringByeCount, 1);
});

test('eight evenly loaded rings with two all-discipline divisions each take 128 modeled minutes', () => {
  const group = { competitors: Array.from({ length: 8 }, () => ({ weaponsEligible: true })) };
  const minutes = estimateDivisionTiming(group).estimatedDurationMs * 2 / 60_000;
  assert.equal(minutes, 128);
  assert.equal(minutes / 2, 64);
  assert.equal(minutes / 5, 25.6);
});

test('supports persisted numeric eligibility and discipline division-number fields', () => {
  const timing = estimateDivisionTiming({ competitors: [
    { weaponsEligible: 1, hyungsEligible: 0 },
    { weaponsEligible: '1', sparringEligible: '0' },
    { weaponsDivisionNumber: 20, sparringDivisionNumber: 'unassigned' }
  ] });
  assert.deepEqual(timing.entrantCounts, { weapons: 3, hyungs: 2, sparring: 1 });
});
