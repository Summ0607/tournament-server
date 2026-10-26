const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildGroups, buildDivisions, buildGroupsWithReview } = require('../backend/groupBuilder');
const { rebalanceGroupsToSoftMax } = require('../backend/groupDivisionAssignments');
const { isSpecialNeeds, specialNeedsCategory, specialNeedsGroupError } = require('../assets/division-rules');

let nextId = 1;
function person(gender, rank, age) {
  const id = nextId++;
  return { id, firstName: `C${id}`, lastName: 'Test', gender, rank, age };
}

function many(count, gender, rank, age) {
  return Array.from({ length: count }, () => person(gender, rank, age));
}

function tierOf(rank) {
  if (rank === 'TTLD') return 'TTLD';
  if (/^G(10|[5-9])$/.test(rank)) return 'G10-G5';
  if (/^G[1-4]$/.test(rank) || rank === 'CDB') return 'G4-CDB';
  return 'DAN';
}

function bracketOf(age) {
  if (age <= 9) return '6-9';
  if (age <= 13) return '10-13';
  if (age <= 17) return '14-17';
  if (age <= 35) return '18-35';
  return '36+';
}

function assertFirmRules(groups) {
  for (const group of groups) {
    const genders = new Set(group.competitors.map((c) => c.gender));
    const tiers = new Set(group.competitors.map((c) => tierOf(c.rank)));
    const brackets = new Set(group.competitors.map((c) => bracketOf(c.age)));
    assert.equal(genders.size, 1, `${group.name} mixes genders`);
    assert.equal(tiers.size, 1, `${group.name} mixes rank tiers`);
    assert.equal(brackets.size, 1, `${group.name} mixes age brackets`);
  }
}

test('undersized groups are not merged across rank tiers or age brackets', () => {
  const competitors = [
    ...[51, 53, 54, 56, 59].map((age) => person('Male', 'G7', age)),
    person('Male', 'G4', 7), person('Male', 'G4', 7), person('Male', 'G4', 9),
    person('Male', 'CDB', 12),
    person('Male', 'CDB', 16)
  ];

  const groups = buildGroups(competitors, { minGroupSize: 4, maxGroupSize: 11 });

  assertFirmRules(groups);
  assert.equal(groups.reduce((sum, g) => sum + g.competitors.length, 0), competitors.length);
  const flagged = groups.filter((g) => g.warning);
  assert.deepEqual(flagged.map((g) => g.competitors.length).sort(), [1, 1, 3]);
});

test('lone competitor is not pulled into an adjacent age bracket of the same tier', () => {
  const competitors = [
    ...[10, 11, 11, 12, 12].map((age) => person('Female', 'G4', age)),
    person('Female', 'G3', 15)
  ];

  const groups = buildGroups(competitors, { minGroupSize: 4, maxGroupSize: 11 });

  assertFirmRules(groups);
  assert.equal(groups.length, 2);
  assert.ok(groups.find((g) => g.competitors.length === 1).warning);
});

test('undersized groups still merge into a compatible neighbour', () => {
  const groups = rebalanceGroupsToSoftMax([
    { groupId: 'a', competitors: many(6, 'Female', 'D1', 30) },
    { groupId: 'b', competitors: many(2, 'Female', 'D2', 33) }
  ], { minGroupSize: 4, maxGroupSize: 11 });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].competitors.length, 8);
  assert.equal(groups[0].warning, undefined);
});

test('undersized group merges forward when the previous group is incompatible', () => {
  const groups = rebalanceGroupsToSoftMax([
    { groupId: 'adults', competitors: many(6, 'Male', 'G7', 40) },
    { groupId: 'small', competitors: many(2, 'Male', 'G4', 8) },
    { groupId: 'kids', competitors: many(5, 'Male', 'G3', 9) }
  ], { minGroupSize: 4, maxGroupSize: 11 });

  assert.deepEqual(groups.map((g) => g.competitors.length), [6, 7]);
  assertFirmRules(groups);
});

test('compatible merge that exceeds max size is re-sliced evenly', () => {
  const groups = rebalanceGroupsToSoftMax([
    { groupId: 'a', competitors: many(11, 'Female', 'D1', 28) },
    { groupId: 'b', competitors: many(3, 'Female', 'D1', 35) }
  ], { minGroupSize: 4, maxGroupSize: 11 });

  assert.deepEqual(groups.map((g) => g.competitors.length), [7, 7]);
  assertFirmRules(groups);
});

for (const useNewEngine of [true, false]) {
  test(`Special Needs partitions by gender, BB/Gup and exact age boundaries (new engine: ${useNewEngine})`, () => {
    const competitors = [];
    for (const gender of ['Male', 'Female']) {
      for (const rank of ['G10', 'G1', 'CDB', 'D1', 'D3', 'TTLD']) {
        for (const age of [12, 13, 17, 18, 30]) {
          competitors.push({ ...person(gender, rank, age), specialNeeds: 'Y' });
        }
      }
    }
    competitors.push(...many(5, 'Male', 'G10', 13));
    const groups = buildDivisions(competitors, { useNewEngine, minGroupSize: 4, maxGroupSize: 11 });
    const special = groups.filter((group) => group.competitors.some(isSpecialNeeds));
    assert.equal(special.length, 18);
    for (const group of special) {
      assert.equal(specialNeedsGroupError(group.competitors, { automatic: true }), '');
      assert.match(group.name, /Special Needs/);
      assert.ok(group.competitors.every(isSpecialNeeds));
    }
    const gup = special.filter((group) => specialNeedsCategory(group.competitors[0]).rankCategory === 'Gup');
    assert.ok(gup.some((group) => group.competitors.some((c) => c.rank === 'G10') && group.competitors.some((c) => c.rank === 'CDB')));
    const adults = special.filter((group) => specialNeedsCategory(group.competitors[0]).ageBracket === '18 and up');
    assert.ok(adults.every((group) => group.competitors.every((c) => c.age >= 18)));
    const flattened = groups.flatMap((group) => group.competitors.map((c) => c.id));
    assert.equal(flattened.length, competitors.length);
    assert.equal(new Set(flattened).size, competitors.length);
    assert.equal(new Set(groups.map((g) => g.groupId)).size, groups.length);
  });
}

test('Special Needs groups respect selected maximum and remain isolated during rebalancing', () => {
  const sn = (age) => ({ ...person('Male', 'G10', age), specialNeeds: 1 });
  const groups = buildGroups([
    ...Array.from({ length: 19 }, () => sn(13)),
    ...many(4, 'Male', 'G10', 13)
  ], { minGroupSize: 4, maxGroupSize: 6 });
  const special = groups.filter((g) => g.competitors.some(isSpecialNeeds));
  assert.equal(special.length, 4);
  assert.ok(special.every((g) => g.competitors.length <= 6 && g.competitors.length >= 4));
  const rebalanced = rebalanceGroupsToSoftMax([
    { competitors: many(5, 'Male', 'G10', 13) },
    { competitors: [sn(13)] },
    { competitors: [sn(17)] }
  ]);
  assert.deepEqual(rebalanced.map((g) => g.competitors.length), [5, 2]);
  assert.equal(specialNeedsGroupError(rebalanced[1].competitors), '');
});

test('Special Needs invalid demographics are held for review, not mixed into ordinary groups', (t) => {
  t.mock.method(console, 'warn', () => {});
  const competitors = [
    { ...person('Unknown', 'G1', 13), specialNeeds: true },
    { ...person('Male', 'G1', 0), specialNeeds: true },
    { ...person('Male', 'D4', 18), specialNeeds: true }
  ];
  const result = buildGroupsWithReview(competitors);
  assert.equal(result.groups.length, 0);
  assert.equal(result.reviewCompetitors.length, 3);
});

test('manual Special Needs groups retain gender and standard-division isolation', () => {
  const special = { ...person('Male', 'G1', 13), specialNeeds: 1 };
  for (const competitor of [
    person('Male', 'G1', 13),
    { ...person('Female', 'G1', 13), specialNeeds: 1 }
  ]) {
    assert.throws(() => buildGroupsWithReview([], { groups: [{ competitors: [special, competitor] }] }),
      { code: 'INVALID_DIVISION_GROUP' });
  }
});

test('manual Special Needs groups allow rank and age changes without automatic cross-category merging', () => {
  const competitors = [
    { ...person('Male', 'G1', 12), specialNeeds: 1 },
    { ...person('Male', 'D1', 18), specialNeeds: 1 },
    { ...person('Male', 'TTLD', 6), specialNeeds: 1 }
  ];
  assert.equal(specialNeedsGroupError(competitors), '');
  assert.notEqual(specialNeedsGroupError(competitors, { automatic: true }), '');
  const result = buildGroupsWithReview([], { groups: [{ competitors }] });
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].competitors.length, 3);
  const separate = rebalanceGroupsToSoftMax(competitors.map((c) => ({ competitors: [c] })));
  assert.equal(separate.length, 3);
});
