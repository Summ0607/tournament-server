const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const sqlite3 = require('sqlite3');
const rules = require('../assets/competition-settings');
const { aggregate, ageOnDate } = require('../backend/tournamentResults');
const { createTournamentResultRouter } = require('../backend/tournamentResultRoutes');
const { create } = require('../tournament-management/results');
const settings = Object.fromEntries(Object.keys(rules.schemas).map((kind) => [kind, rules.defaults(kind)]));
function sample() {
  const roster = Array.from({ length: 8 }, (_, i) => ({ id: String(i), gender: 'Female', age: 27, ageAsOf: '2027-01-09', associationNumber: `ID${i}` }));
  const packets = roster.map((row, i) => ({ eventName: 'Sample', groupId: String(i), completedAt: '2027-01-09T12:00:00Z',
    participants: [{ participantId: row.id, name: `Person ${i}`, studio: 'School', rankCode: 'D1', age: 0 }],
    disciplines: { sparring: { status: 'COMPLETED' } },
    overallAwards: { sparring: [{ participantId: row.id, place: i === 0 ? '1st' : 'Co-3rd' }] } }));
  return { roster, packets, settings, date: '2027-01-09', simulation: true };
}
test('standings correct zero ages, score configured medals and share ranks including ties at cutoff', () => {
  assert.equal(ageOnDate('01/10/2000', '2027-01-09'), 26);
  assert.equal(ageOnDate('01/09/2000', '2027-01-09'), 27);
  assert.equal(ageOnDate('2000-01-09', '2027-01-09'), 27);
  assert.throws(() => ageOnDate('02/30/2000', '2027-01-09'));
  const data = aggregate(sample()), category = data.categories.find((row) => row.name === 'Adult Female Black Belt Champion');
  assert.equal(data.correctedAges, 8);
  assert.equal(category.eligibleCount, 8);
  assert.equal(category.rows.length, 8);
  assert.deepEqual(category.rows.map((row) => row.position), [1, 2, 2, 2, 2, 2, 2, 2]);
  assert.equal(category.rows[0].points, 10);
  const input = sample();
  input.settings = { ...settings, 'competition-types': settings['competition-types'].map((row) => ({ ...row, isTeam: true })) };
  assert.equal(aggregate(input).categories.flatMap((row) => row.rows).length, 0);
  input.settings = { ...settings, 'medal-points': [] };
  assert.throws(() => aggregate(input), /Medal Points/);
});
test('individual totals combine disciplines, apply the second third-place definition and exclude non-held events', () => {
  const input = sample();
  input.packets = [input.packets[0]];
  input.packets[0].participants = sample().packets.slice(0, 4).map((packet) => packet.participants[0]);
  input.packets[0].disciplines.weapons = { status: 'COMPLETED' };
  input.packets[0].disciplines.hyungs = { status: 'NOT_HELD' };
  input.packets[0].overallAwards.weapons = [
    { participantId: '0', place: '1st' }, { participantId: '1', place: '2nd' },
    { participantId: '2', place: 'Co-3rd' }, { participantId: '3', place: 'Co-3rd' }
  ];
  input.settings = { ...settings, 'medal-points': settings['medal-points'].map((row) => ({ ...row, points: row.name === '3rd Place (2)' ? 3 : row.points })) };
  const data = aggregate(input);
  const rows = data.categories.flatMap((category) => category.rows);
  assert.deepEqual(rows.map((row) => row.points), [20, 8, 5, 3]);
  assert.deepEqual(data.medals, { first: 2, second: 1, third: 2 });
});
test('equal points use belt seniority then numeric member number, with shared positions only for unresolved ties', () => {
  const input = sample();
  const ranks = ['D1', 'D2', 'D3', 'D3', 'D3', 'D3', 'D3', 'D3'];
  const numbers = ['D1', 'D1', 'D100', 'D20', 'D0020', 'D9', '', 'invalid'];
  input.packets.forEach((packet, i) => {
    packet.participants[0].rankCode = ranks[i];
    packet.overallAwards.sparring[0].place = '1st';
    input.roster[i].associationNumber = numbers[i];
  });
  let rows = aggregate(input).categories.flatMap((category) => category.rows);
  assert.deepEqual(rows.map((row) => row.id), ['5', '3', '4', '2', '6', '7']);
  assert.deepEqual(rows.map((row) => row.position), [1, 2, 2, 4, 5, 5]);
  input.packets = input.packets.slice(0, 3);
  rows = aggregate(input).categories.flatMap((category) => category.rows);
  assert.deepEqual(rows.map((row) => row.rank), ['D3', 'D2', 'D1']);
  input.packets.forEach((packet, i) => { packet.participants[0].rankCode = ['G2', 'G1', 'CDB'][i]; });
  rows = aggregate(input).categories.flatMap((category) => category.rows);
  assert.deepEqual(rows.map((row) => row.rank), ['CDB', 'G1', 'G2']);
  input.packets[0].overallAwards.sparring[0].place = '2nd';
  rows = aggregate(input).categories.flatMap((category) => category.rows);
  assert.equal(rows.at(-1).points, 8);
});
test('result API isolates sources, deduplicates divisions, validates scope and never writes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tournament-results-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const eventsRoot = path.join(root, 'events'), runsRoot = path.join(root, 'runs');
  const eventDir = path.join(eventsRoot, 'Sample'), runDir = path.join(runsRoot, 'run1');
  fs.mkdirSync(eventDir, { recursive: true }); fs.mkdirSync(path.join(runDir, 'results'), { recursive: true });
  await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path.join(eventDir, 'tournament.db'));
    db.run('CREATE TABLE competitors (id TEXT, gender TEXT, age INTEGER, ageAsOf TEXT, associationNumber TEXT)', (error) => {
      db.close((closeError) => error || closeError ? reject(error || closeError) : resolve());
    });
  });
  fs.writeFileSync(path.join(eventDir, 'event-config.json'), JSON.stringify({ date: '2027-01-09' }));
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ sourceEventName: 'Sample', tournamentDate: '2027-01-09', status: 'complete', createdAt: '2027-01-09' }));
  const input = sample();
  fs.writeFileSync(path.join(runDir, 'groups.json'), JSON.stringify([{ competitors: input.roster }]));
  input.packets.forEach((packet, i) => fs.writeFileSync(path.join(runDir, 'results', `${i}.json`), JSON.stringify({ status: 'ACCEPTED', packetBlock: packet })));
  fs.writeFileSync(path.join(runDir, 'results', 'duplicate.json'), JSON.stringify({ packetBlock: input.packets[0] }));
  const before = fs.readdirSync(eventDir);
  const app = express(); app.use('/api', createTournamentResultRouter({ eventsRoot, runsRoot }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/tournament-results`;
  const live = await (await fetch(`${url}?eventName=Sample`)).json();
  assert.equal(live.divisionCount, 0);
  assert.equal(live.source.simulation, false);
  assert.equal((await fetch(url)).status, 400);
  assert.equal((await fetch(`${url}?eventName=..`)).status, 400);
  assert.equal((await fetch(`${url}?eventName=Sample&source=other`)).status, 404);
  fs.writeFileSync(path.join(eventDir, 'event-config.json'), JSON.stringify({ date: '2028-01-09' }));
  const response = await fetch(`${url}?eventName=Sample&source=run1`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.divisionCount, 8);
  assert.equal(data.source.simulation, true);
  assert.equal(data.sources.length, 2);
  assert.deepEqual(fs.readdirSync(eventDir), before);
  fs.writeFileSync(path.join(runDir, 'results', 'bad.json'), '{bad');
  t.mock.method(console, 'error', () => {});
  assert.equal((await fetch(`${url}?eventName=Sample&source=run1`)).status, 500);
});
test('results workspace clears stale standings, escapes cells, preserves source and surfaces failures', async () => {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', handlers: {}, addEventListener(k, fn) { this.handlers[k] = fn; }, setAttribute() {} });
    return nodes.get(id);
  };
  let event = 'Sample', failure = false;
  const data = aggregate(sample()); data.categories[0].name = '<Unsafe>';
  const workspace = create({ document: { getElementById: get }, selectedEvent: () => event, request: async () => {
    if (failure) throw new Error('Read failed');
    return { ...data, source: { id: 'run1', simulation: true }, sources: [{ id: 'run1', label: 'Simulation' }] };
  } });
  await workspace.load();
  assert.match(get('resultCards').innerHTML, /&lt;Unsafe&gt;/);
  assert.match(get('resultNotice').textContent, /8 packet ages/);
  assert.equal(get('resultSource').value, 'run1');
  failure = true; await get('resultRefresh').handlers.click();
  assert.equal(get('resultCards').innerHTML, '');
  assert.match(get('resultNotice').textContent, /Read failed/);
  event = ''; await workspace.load();
  assert.match(get('resultNotice').textContent, /Select a tournament/);
});
