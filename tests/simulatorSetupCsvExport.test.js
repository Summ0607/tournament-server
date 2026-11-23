const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const csv = require('csv-parser');
const { generateSimulationSetup } = require('../backend/simulatorSetupGenerator');
const { buildCsvFiles, buildPreparationFiles } = require('../backend/simulatorSetupCsvExport');

const eventDate = '2027-02-13';
const seed = 'csv-export-test';

function parseCsv(contents) {
  return new Promise((resolve, reject) => {
    const records = [];
    Readable.from([contents]).pipe(csv())
      .on('data', (record) => records.push(record))
      .on('error', reject)
      .on('end', () => resolve(records));
  });
}

test('exports three import-format CSVs and grouped prior-experience API requests', async () => {
  const setup = generateSimulationSetup({ eventDate, seed });
  const files = buildCsvFiles(setup);
  assert.deepEqual(Object.keys(files), [
    'competitors.csv', 'volunteers.csv', 'judges.csv'
  ]);
  const [competitors, volunteers, judges] = await Promise.all([
    parseCsv(files['competitors.csv']),
    parseCsv(files['volunteers.csv']),
    parseCsv(files['judges.csv'])
  ]);
  assert.equal(competitors.length, 600);
  assert.equal(volunteers.length, 155);
  assert.equal(judges.length, 180);
  assert.equal(competitors[0].associationNumber, setup.competitors[0].associationId);
  assert.equal(volunteers[0]['Primary Volunteer Type'], 'Judging');
  assert.equal(judges[0].dateOfBirth, setup.judges[0].dateOfBirth);
  const representedJudgeIds = new Set([
    ...setup.competitors.map((person) => person.associationId),
    ...setup.volunteers.filter((person) => person.primaryType === 'judging')
      .map((person) => person.associationNumber)
  ]);
  assert.equal(setup.judges.filter((judge) => !representedJudgeIds.has(judge.associationId)).length, 12);
  const preparation = buildPreparationFiles(setup);
  const requests = JSON.parse(preparation.files['experience-api.json']);
  assert.equal(requests.length, 54);
  assert.ok(requests.every((request) => request.records.length === 1 &&
    request.records[0].logVerified === false && request.records[0].source === 'SIMULATION'));
  assert.equal(Object.hasOwn(preparation.files, 'prior-experience.csv'), false);

  const invalidCounts = structuredClone(setup);
  invalidCounts.profile.competitorCount -= 1;
  assert.throws(() => buildCsvFiles(invalidCounts), /profile counts/i);
  const invalidCoverage = structuredClone(setup);
  invalidCoverage.profile.judgeTargetCount -= 1;
  assert.throws(() => buildCsvFiles(invalidCoverage), /profile counts/i);
  const overlapSetup = generateSimulationSetup({ eventDate, seed: 'overlap-2' });
  assert.ok(overlapSetup.profile.setupTeardownOverlapCount > 0);
  assert.doesNotThrow(() => buildCsvFiles(overlapSetup));
  const invalidOverlap = structuredClone(overlapSetup);
  invalidOverlap.profile.setupTeardownOverlapCount += 1;
  assert.throws(() => buildCsvFiles(invalidOverlap), /support volunteer roles/i);
  const formula = structuredClone(setup);
  formula.competitors[0].firstName = '=HYPERLINK("https://example.invalid")';
  assert.throws(() => buildCsvFiles(formula), /spreadsheet formulas/i);
});

test('CLI writes a complete preparation directory once and refuses to overwrite', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'simulator-setup-csv-'));
  const input = path.join(directory, 'setup.json');
  const output = path.join(directory, 'csv-export');
  const cli = path.resolve(__dirname, '../backend/simulatorSetupCsvExport.js');
  fs.writeFileSync(input, JSON.stringify(generateSimulationSetup({ eventDate, seed })), 'utf8');
  const args = [cli, '--input', input, '--output-dir', output];
  try {
    execFileSync(process.execPath, args, { stdio: 'pipe' });
    assert.deepEqual(fs.readdirSync(output).sort(), [
      'competitors.csv', 'experience-api.json', 'judges.csv', 'setup.json', 'volunteers.csv'
    ]);
    const requests = JSON.parse(fs.readFileSync(path.join(output, 'experience-api.json'), 'utf8'));
    assert.equal(requests.length, 54);
    assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
