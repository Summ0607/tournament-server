const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRank } = require('../db/rankNormalization');
const { normalizeCertification, certificationLevels, formatCertificationForDisplay,
  meetsMinimumCertification, certificationRankIssue, certificationAgeIssue, isJudgeRank, JUDGE_RANKS, judgeRankOptions } = require('../db/judgeCertification');

test('judge rank options use readable Gup and Korean Dan names while retaining canonical codes', () => {
  const options = judgeRankOptions();
  assert.deepEqual(options.map((rank) => rank.code), JUDGE_RANKS);
  assert.deepEqual(options.map((rank) => rank.label), ['5th Gup', '4th Gup', '3rd Gup', '2nd Gup', '1st Gup',
    'Cho Dan Bo', 'Cho Dan', 'E Dan', 'Sam Dan', 'Sah Dan', 'Oh Dan', 'Yuk Dan', 'Chil Dan', 'Pal Dan']);
});

test('Korean Dan names normalize to canonical ranks', () => {
  for (const [label, code] of [['Cho Dan', 'D1'], ['E Dan', 'D2'], ['Sam Dan', 'D3'],
    ['Sah Dan', 'D4'], ['Oh Dan', 'D5'], ['Yuk Dan', 'D6']]) {
    assert.equal(normalizeRank(label).code, code);
  }
});

test('certification levels are ordered with canonical codes and display labels', () => {
  assert.deepEqual(certificationLevels().map((level) => level.code),
    ['UNKNOWN', 'UNCERTIFIED', 'SK_TK', 'CORNER', 'REGIONAL', 'INTERNATIONAL']);
  assert.equal(formatCertificationForDisplay('SK_TK'), 'SK/TK');
  assert.equal(formatCertificationForDisplay('REGIONAL'), 'Regional (Center)');
  assert.equal(formatCertificationForDisplay('bogus'), 'Unknown');
  assert.equal(formatCertificationForDisplay(''), 'Unknown');
});

test('free-text certification normalizes through aliases; unrecognized falls back to Unknown', () => {
  for (const [input, code] of [['', 'UNKNOWN'], [undefined, 'UNKNOWN'], ['unknown', 'UNKNOWN'],
    ['Uncertified', 'UNCERTIFIED'], ['none', 'UNCERTIFIED'], ['Not Certified', 'UNCERTIFIED'],
    ['SK/TK', 'SK_TK'], ['sk tk', 'SK_TK'], ['Scorekeeper', 'SK_TK'], ['Time Keeper', 'SK_TK'],
    ['Corner', 'CORNER'], ['Corner Judge', 'CORNER'],
    ['Regional', 'REGIONAL'], ['Regional (Center)', 'REGIONAL'], ['center', 'REGIONAL'],
    ['International', 'INTERNATIONAL'], ['INTERNATIONAL', 'INTERNATIONAL'], ['REGIONAL', 'REGIONAL']]) {
    const result = normalizeCertification(input);
    assert.equal(result.code, code, String(input));
    assert.equal(result.recognized, true, String(input));
  }
  const bad = normalizeCertification('Master Judge');
  assert.equal(bad.code, 'UNKNOWN');
  assert.equal(bad.recognized, false);
  assert.equal(bad.raw, 'Master Judge');
});

test('certification comparisons and rank minimums follow the shared order and G5-D8 envelope', () => {
  assert.equal(meetsMinimumCertification('REGIONAL', 'CORNER'), true);
  assert.equal(meetsMinimumCertification('CORNER', 'CORNER'), true);
  assert.equal(meetsMinimumCertification('SK_TK', 'CORNER'), false);
  assert.equal(meetsMinimumCertification('bogus', 'UNKNOWN'), false);
  assert.deepEqual([JUDGE_RANKS[0], JUDGE_RANKS.at(-1)], ['G5', 'D8']);
  assert.equal(isJudgeRank('CDB'), true);
  assert.equal(isJudgeRank('G6'), false);
  assert.equal(isJudgeRank('D9'), false);
  assert.equal(certificationRankIssue('UNKNOWN', 'G10'), '');
  assert.equal(certificationRankIssue('UNCERTIFIED', 'TTLD'), '');
  assert.equal(certificationRankIssue('SK_TK', 'G5'), '');
  assert.equal(certificationRankIssue('SK_TK', 'CDB'), '');
  assert.equal(certificationRankIssue('CORNER', 'D1'), '');
  assert.equal(certificationRankIssue('INTERNATIONAL', 'D8'), '');
  assert.match(certificationRankIssue('SK_TK', 'G6'), /requires rank G5 or higher/);
  assert.match(certificationRankIssue('CORNER', 'CDB'), /requires rank D1 or higher/);
  assert.match(certificationRankIssue('REGIONAL', 'G1'), /requires rank D1 or higher/);
  assert.match(certificationRankIssue('INTERNATIONAL', 'D1'), /requires rank D2 or higher/);
});

test('In-House certification ages use exact 11 and 15 boundaries without relaxing rank rules', () => {
  for (const rank of ['G5', 'CDB', 'D1']) {
    assert.equal(certificationAgeIssue('SK_TK', rank, 11, 'in-house'), '');
    assert.match(certificationAgeIssue('SK_TK', rank, 10, 'in-house'), /age 11/);
  }
  assert.equal(certificationAgeIssue('CORNER', 'D1', 15, 'in-house'), '');
  assert.match(certificationAgeIssue('CORNER', 'D1', 14, 'in-house'), /age 15/);
  assert.match(certificationRankIssue('SK_TK', 'G6'), /G5/);
  assert.match(certificationRankIssue('CORNER', 'CDB'), /D1/);
});

test('SK/TK certification enforces age 16 for Gup and Dan ranks and age 14 for CDB', () => {
  assert.equal(certificationAgeIssue('SK_TK', 'G5', 16), '');
  assert.equal(certificationAgeIssue('SK_TK', 'D1', 16), '');
  assert.match(certificationAgeIssue('SK_TK', 'G5', 15), /age 16 or older/);
  assert.equal(certificationAgeIssue('SK_TK', 'CDB', 14), '');
  assert.match(certificationAgeIssue('SK_TK', 'CDB', 13), /age 14 or older/);
  assert.match(certificationAgeIssue('SK_TK', 'CDB', undefined), /age 14 or older/);
  assert.equal(certificationAgeIssue('CORNER', 'D1', 12), '');
});
