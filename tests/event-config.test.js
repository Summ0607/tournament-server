const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createEventConfigStore, normalizeEventRingConfig, hasOperationalUse } = require('../backend/eventConfig');
const DivisionRules = require('../assets/division-rules');
const { normalizeTournamentDays, scheduleState, isDayBlocked } = require('../backend/tournamentSchedule');

test('running order ignores gender, prioritizes BB oldest then TT/SD then Gup youngest, and uses numeric ties', () => {
  const group = (id, rank, ageBracket, gender, extra = {}) => ({
    groupDivisionNumber: id, ageBracket, competitors: [{ rank, gender }], ...extra
  });
  const groups = [
    group(1, 'G1', '36+', 'Male'), group(2, 'D1', '14-17', 'Male'),
    group(12, 'D3', '36+', 'Female'), group(3, 'D1', '36+', 'Male'),
    group(4, 'G10', '6-9', 'Female'), group(5, 'TTLD', '4-5', 'Male'),
    group(6, 'D1', 'Under 13', 'Female', { specialNeeds: true }),
    group(7, 'G1', '10-13', 'Male')
  ];
  assert.deepEqual(groups.sort(DivisionRules.compareRunningOrder).map((item) => item.groupDivisionNumber),
    [3, 12, 2, 6, 5, 4, 7, 1]);
  assert.equal(DivisionRules.scheduleCategory(groups.find((item) => item.groupDivisionNumber === 6)), 'SD');
  assert.deepEqual(DivisionRules.runningOrderAge({ ageBracket: 'Mixed', competitors: [{ age: 14 }, { age: 18 }] }),
    { min: 14, max: 18, mixed: true });
  assert.deepEqual(DivisionRules.runningOrderAge({ ageBracket: '36+' }), { min: 36, max: 99, mixed: false });
  assert.deepEqual(DivisionRules.runningOrderAge({ competitors: [] }), { min: null, max: null, mixed: false });
});

test('two-day event config persists, defaults old events to one day and rejects invalid formats', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'event-days-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'Event'));
  const store = createEventConfigStore(root);
  assert.equal(store.readEventConfig('Event').tournamentDays, 1);
  const config = store.writeEventConfig('Event', { tournamentDays: 2 });
  assert.equal(store.readEventConfig('Event').tournamentDays, 2);
  for (const invalid of [0, 3, 1.5, 'two', true, [], {}]) {
    assert.throws(() => store.writeEventConfig('Event', { ...config, tournamentDays: invalid }), /tournamentDays/);
  }
  assert.equal(normalizeTournamentDays('2'), 2);
  const groups = [{ groupDivisionNumber: 1, rankCategory: 'Black Belt' },
    { groupDivisionNumber: 2, competitors: [{ rank: 'TTLD' }] }];
  const assignments = { rings: { a: { completedGroupDivisionNumbers: [] } } };
  assert.equal(scheduleState(groups, assignments, 2).day1Complete, false);
  assignments.rings.a.completedGroupDivisionNumbers.push('1');
  const schedule = scheduleState(groups, assignments, 2);
  assert.equal(schedule.day1Complete, true);
  assert.equal(isDayBlocked(groups[1], schedule), true);
  assignments.day2StartedAt = new Date().toISOString();
  assert.equal(isDayBlocked(groups[1], scheduleState(groups, assignments, 2)), false);
  assert.equal(scheduleState([], { rings: {} }, 2).day1Complete, true);
  assert.equal(scheduleState(groups, { rings: {}, sourceCompletedGroupDivisionNumbers: ['1'] }, 2).day1Complete, true);
});

test('event dimensions persist as numbers and survive modification and reload', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tournament-event-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const eventName = 'Test Event';
  fs.mkdirSync(path.join(root, eventName));
  const file = path.join(root, eventName, 'event-config.json');
  const store = createEventConfigStore(root);
  const created = store.writeEventConfig(eventName, {
    location: 'Test Venue',
    date: '2027-01-16',
    ringConfigX: 2,
    ringConfigY: 3
  });
  assert.equal(created.ringConfigX, 2);
  assert.equal(created.ringConfigY, 3);
  assert.equal(Object.hasOwn(created, 'ringConfig'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), created);
  assert.deepEqual(store.readEventConfig(eventName), created);

  const modified = store.writeEventConfig(eventName, {
    ...created,
    ringConfigX: '4',
    ringConfigY: '5'
  });
  assert.equal(modified.createdAt, created.createdAt);
  assert.equal(modified.location, created.location);
  assert.equal(modified.date, created.date);
  assert.equal(modified.ringConfigX, 4);
  assert.equal(modified.ringConfigY, 5);
  assert.deepEqual(createEventConfigStore(root).readEventConfig(eventName), modified);
  const beforeInvalidSave = fs.readFileSync(file, 'utf8');
  assert.throws(() => store.writeEventConfig(eventName, { ...modified, ringConfigX: 1.5 }), /whole number/);
  assert.equal(fs.readFileSync(file, 'utf8'), beforeInvalidSave);

  for (const ringConfig of ['2 x 3', '2 \u00d7 3']) {
    fs.writeFileSync(file, JSON.stringify({ ...created, ringConfigX: undefined, ringConfigY: undefined, ringConfig }));
    const legacy = store.readEventConfig(eventName);
    assert.equal(legacy.ringConfigX, 2);
    assert.equal(legacy.ringConfigY, 3);
    assert.equal(Object.hasOwn(legacy, 'ringConfig'), false);
    store.writeEventConfig(eventName, legacy);
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file, 'utf8')), 'ringConfig'), false);
  }

  fs.writeFileSync(file, JSON.stringify({ ringConfigX: 0, ringConfigY: 0, ringConfig: '2 x 3' }));
  assert.equal(store.readEventConfig(eventName).ringConfigX, 0);
  assert.equal(store.readEventConfig(eventName).ringConfigY, 0);
  fs.writeFileSync(file, '{ invalid JSON');
  assert.throws(() => store.readEventConfig(eventName), SyntaxError);
});

test('dimensions default to zero and reject invalid input instead of truncating', () => {
  assert.deepEqual(normalizeEventRingConfig({}), { ringConfigX: 0, ringConfigY: 0 });
  assert.deepEqual(normalizeEventRingConfig({ ringConfigX: '', ringConfigY: 0 }), { ringConfigX: 0, ringConfigY: 0 });
  for (const field of ['ringConfigX', 'ringConfigY']) {
    for (const value of [-1, 1.5, '1.5', '2 rings', true, [], {}, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => normalizeEventRingConfig({ [field]: value }), (error) => {
        assert.equal(error.statusCode, 400);
        assert.match(error.message, new RegExp(field));
        return true;
      });
    }
  }
  assert.throws(() => normalizeEventRingConfig({ ringConfigX: 27 }), /ringConfigX/);
  assert.throws(() => normalizeEventRingConfig({ ringConfigY: 51 }), /ringConfigY/);
});

function eventFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'event-lifecycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const eventDir = path.join(root, 'Event');
  fs.mkdirSync(eventDir);
  const store = createEventConfigStore(root);
  const config = store.writeEventConfig('Event', { ringConfigX: 4, ringConfigY: 4, tournamentDays: 2, location: 'Venue' });
  const assignmentsFile = path.join(eventDir, 'ring-assignments.json');
  const writeState = (state) => fs.writeFileSync(assignmentsFile, JSON.stringify(state));
  return { root, eventDir, store, config, assignmentsFile, writeState };
}

test('creation, saving and reloading derive operational dimensions without an apply step', (t) => {
  const { root, store, config, writeState } = eventFixture(t);
  assert.deepEqual(store.readAssignmentState('Event').config, { letterCount: 4, numberCount: 4 });
  writeState({ config: { letterCount: 1, numberCount: 2 }, rings: {} });
  assert.deepEqual(store.readAssignmentState('Event').config, { letterCount: 4, numberCount: 4 });
  store.writeEventConfig('Event', { ...config, ringConfigX: 2, ringConfigY: 3, tournamentDays: 1 });
  assert.deepEqual(createEventConfigStore(root).readAssignmentState('Event').config, { letterCount: 2, numberCount: 3 });
  assert.equal(store.configurationStatus('Event').configurationLocked, false);
  assert.equal(store.configurationStatus('Event').layoutMismatch, false);
  store.writeEventConfig('Event', { ...config, ringConfigX: 0, ringConfigY: 0 });
  assert.deepEqual(store.readAssignmentState('Event').config, { letterCount: 0, numberCount: 0 });
});

test('unchanged layout preserves unused ring entries and invalid saves change neither file', (t) => {
  const { store, config, assignmentsFile, eventDir, writeState } = eventFixture(t);
  const state = { config: { letterCount: 4, numberCount: 4 }, rings: { 'ring-a-1': { ringLabel: 'A1', phase: 'idle' } } };
  writeState(state);
  store.writeEventConfig('Event', { ...config, location: 'New venue' });
  assert.deepEqual(JSON.parse(fs.readFileSync(assignmentsFile)), state);
  const previous = fs.readFileSync(path.join(eventDir, 'event-config.json'), 'utf8');
  assert.throws(() => store.writeEventConfig('Event', { ...config, ringConfigX: 27 }), /ringConfigX/);
  assert.equal(fs.readFileSync(path.join(eventDir, 'event-config.json'), 'utf8'), previous);
  assert.deepEqual(JSON.parse(fs.readFileSync(assignmentsFile)), state);
});

test('every operational-use signal locks all settings and survives clearing individual rings and reload', (t) => {
  const { root, store, config, writeState } = eventFixture(t);
  const ringSignals = [
    { tabletLabel: 'Tablet' }, { groupDivisionNumber: '1' }, { currentGroupId: '1' },
    { currentGroupDivisionNumber: '1' }, { queuedGroupDivisionNumbers: ['1'] }, { queuedGroupIds: ['1'] },
    { completedGroupDivisionNumbers: ['1'] }, { completedGroupIds: ['1'] }, { phase: 'paused' },
    { checkInCount: 1 }, { checkInTotal: 1 }, { phaseProgress: 10 }, { phaseTotalCount: 1 },
    { phaseHistory: [{}] }, { assignmentStartedAt: '2026-01-01' }
  ];
  for (const signal of [
    { eventStartedAt: '2026-01-01' }, { day2StartedAt: '2026-01-02' },
    ...ringSignals.map((ring) => ({ rings: { 'ring-a-1': ring } }))
  ]) {
    writeState({ config: { letterCount: 4, numberCount: 4 }, rings: {}, ...signal });
    assert.equal(store.configurationStatus('Event').configurationLocked, true, JSON.stringify(signal));
    const locked = store.readAssignmentState('Event');
    assert.ok(locked.configLockedAt);
    for (const change of [{ location: 'Changed' }, { date: '2027-01-01' }, { name: 'Changed' },
      { tournamentDays: 1 }, { ringConfigX: 2 }, {}]) {
      assert.throws(() => store.writeEventConfig('Event', { ...config, ...change }), (error) =>
        error.statusCode === 409 && /Reset the run/.test(error.message));
    }
    writeState({ ...locked, eventStartedAt: '', day2StartedAt: '', rings: {} });
    assert.equal(createEventConfigStore(root).configurationStatus('Event').configurationLocked, true);
  }
  assert.equal(hasOperationalUse({ rings: { a: { phase: 'idle', lastHeartbeatAt: 'old', tabletLabel: '' } } }), false);
});

test('used layout mismatches and results-only events lock without overwriting existing ring state', (t) => {
  const { eventDir, store, writeState } = eventFixture(t);
  const state = { config: { letterCount: 1, numberCount: 2 },
    rings: { 'ring-a-1': { completedGroupDivisionNumbers: ['99'], tabletLabel: 'Offline tablet' } } };
  writeState(state);
  assert.deepEqual(store.configurationStatus('Event'), {
    configurationLocked: true,
    configurationLockReason: require('../backend/eventConfig').CONFIG_LOCK_MESSAGE,
    layoutMismatch: true
  });
  assert.deepEqual(store.readAssignmentState('Event').rings, state.rings);
  assert.deepEqual(store.readAssignmentState('Event').config, state.config);
  writeState({ config: state.config, rings: {} });
  fs.mkdirSync(path.join(eventDir, 'results'));
  fs.writeFileSync(path.join(eventDir, 'results', 'result.json'), '{}');
  assert.equal(store.configurationStatus('Event').configurationLocked, true);
});

test('reset run archives results and state, preserves preparation data and settings, then permits editing', (t) => {
  const { eventDir, store, config, writeState } = eventFixture(t);
  const database = path.join(eventDir, 'tournament.db');
  fs.writeFileSync(database, 'roster and prepared divisions');
  const resultsDir = path.join(eventDir, 'results');
  fs.mkdirSync(path.join(resultsDir, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(resultsDir, 'nested', 'packet.json'), '{"winner":"Test"}');
  const rings = { 'ring-a-1': { groupDivisionNumber: '1', queuedGroupDivisionNumbers: ['2'], completedGroupDivisionNumbers: ['3'], tabletLabel: 'Tablet' } };
  writeState({ config: { letterCount: 1, numberCount: 2 }, rings, eventStartedAt: '2026-01-01', day2StartedAt: '2026-01-02' });
  const { archive } = store.resetRun('Event');
  assert.equal(fs.readFileSync(path.join(eventDir, archive, 'results', 'nested', 'packet.json'), 'utf8'), '{"winner":"Test"}');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(eventDir, archive, 'ring-assignments.json'))).rings, rings);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(eventDir, archive, 'event-config.json'))), config);
  assert.equal(fs.readFileSync(database, 'utf8'), 'roster and prepared divisions');
  assert.deepEqual(store.readEventConfig('Event'), config);
  assert.deepEqual(fs.readdirSync(resultsDir), []);
  assert.deepEqual(store.readAssignmentState('Event'), {
    config: { letterCount: 4, numberCount: 4 }, configLockedAt: '', eventStartedAt: '', day2StartedAt: '', rings: {}
  });
  assert.equal(store.configurationStatus('Event').configurationLocked, false);
  store.writeEventConfig('Event', { ...config, ringConfigX: 3, tournamentDays: 1 });
  assert.deepEqual(store.readAssignmentState('Event').config, { letterCount: 3, numberCount: 4 });
  assert.notEqual(store.resetRun('Event').archive, archive);
});

test('failed synchronization rolls back event settings and failed reset restores results', (t) => {
  const { eventDir, store, config, assignmentsFile, writeState } = eventFixture(t);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === assignmentsFile) {
      const error = new Error('Simulated assignment write failure');
      error.code = 'EIO';
      throw error;
    }
    return rename(source, destination);
  });
  assert.throws(() => store.writeEventConfig('Event', { ...config, ringConfigX: 2 }), /Simulated/);
  assert.deepEqual(store.readEventConfig('Event'), config);
  assert.deepEqual(store.readAssignmentState('Event').config, { letterCount: 4, numberCount: 4 });

  const state = { config: { letterCount: 4, numberCount: 4 }, configLockedAt: '2026-01-01', rings: {} };
  writeState(state);
  fs.mkdirSync(path.join(eventDir, 'results'));
  fs.writeFileSync(path.join(eventDir, 'results', 'packet.json'), '{"winner":"Test"}');
  assert.throws(() => store.resetRun('Event'), /Simulated/);
  assert.equal(fs.readFileSync(path.join(eventDir, 'results', 'packet.json'), 'utf8'), '{"winner":"Test"}');
  assert.deepEqual(store.readAssignmentState('Event'), state);
});

test('ring config API preserves identical running layouts and rejects independent or locked changes', async (t) => {
  const express = require('express');
  const { createRingRouter } = require('../backend/ringRoutes');
  const state = { config: { letterCount: 2, numberCount: 3 }, configLockedAt: '2026-01-01',
    eventStartedAt: '2026-01-01', rings: { a: { tabletLabel: 'Tablet', groupDivisionNumber: '10' } } };
  const before = JSON.stringify(state);
  let eventName = 'Event';
  let writes = 0;
  const app = express();
  app.use(express.json());
  app.use('/api', createRingRouter({
    readAssignmentsState: () => state,
    writeAssignmentsState: () => { writes += 1; },
    applyHeartbeatPolicy: () => false,
    readActiveEvent: () => eventName,
    setRingConfig: () => assert.fail('Must never regenerate event rings')
  }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/api/rings/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const same = await post({ letterCount: 2, numberCount: 3 });
  assert.equal(same.status, 200);
  assert.match((await same.json()).message, /preserved/);
  assert.equal(JSON.stringify(state), before);
  for (const invalid of [{}, { letterCount: true, numberCount: 3 }, { letterCount: 27, numberCount: 3 },
    { letterCount: 2.5, numberCount: 3 }, { letterCount: 2, numberCount: 51 }]) {
    const response = await post(invalid);
    assert.equal(response.status, 400);
    await response.json();
  }
  const changed = await post({ letterCount: 4, numberCount: 4 });
  assert.equal(changed.status, 409);
  assert.match((await changed.json()).error, /locked/);
  assert.equal(JSON.stringify(state), before);
  Object.assign(state, { configLockedAt: '', eventStartedAt: '', rings: {} });
  const unused = await post({ letterCount: 4, numberCount: 4 });
  assert.equal(unused.status, 409);
  assert.match((await unused.json()).error, /Event Setup/);
  eventName = '';
  Object.assign(state, { configLockedAt: '2026-01-01' });
  const root = await post({ letterCount: 4, numberCount: 4 });
  assert.equal(root.status, 409);
  assert.equal(writes, 0);
});

test('ring status normalization preserves lifecycle locks across assignment resets', () => {
  const { ensureStateStructure, resetAssignments } = require('../modules/ring-status/status.service');
  const state = ensureStateStructure({
    config: { letterCount: 1, numberCount: 1 }, eventStartedAt: '2026-01-01',
    day2StartedAt: '2026-01-02', rings: { 'ring-a-1': { tabletLabel: 'Tablet' } }
  });
  assert.ok(state.configLockedAt);
  resetAssignments(state);
  assert.equal(hasOperationalUse(state), true);
  assert.equal(ensureStateStructure(state).configLockedAt, state.configLockedAt);
  assert.equal(ensureStateStructure(state).day2StartedAt, '2026-01-02');
  assert.deepEqual(ensureStateStructure({ config: { letterCount: 0, numberCount: 0 } }).rings, {});
});

test('event APIs synchronize an active event, lock every field, and archive/reset without losing saved divisions', async (t) => {
  const vm = require('node:vm');
  const { createRequire } = require('node:module');
  const initializeDatabase = require('../db/init');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'event-api-'));
  fs.mkdirSync(path.join(root, 'db'));
  await initializeDatabase(path.join(root, 'db', 'tournament.db'));
  const filename = path.join(__dirname, '..', 'group-server.js');
  // Run the real routes against an isolated event root without starting fixed-port listeners.
  const source = fs.readFileSync(filename, 'utf8').replace(/^startServer\(\);$/m, '') +
    '\nreturn { app, db, simulatorRouter };';
  const loadServer = vm.compileFunction(source, ['require', '__dirname', 'console', 'process'], { filename });
  const { app, db, simulatorRouter } = loadServer(createRequire(filename), root,
    { log() {}, warn() {}, error() {} }, { env: {}, argv: [], on() {} });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await simulatorRouter.shutdown();
    await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: response.status, data: await response.json() };
  };
  const metadata = { eventName: 'Event', ringConfigX: 4, ringConfigY: 4, tournamentDays: 2, location: 'Venue' };
  assert.equal((await request('/events/create', metadata)).status, 200);
  const eventDir = path.join(root, 'events', 'Event');
  const assignmentsFile = path.join(eventDir, 'ring-assignments.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(assignmentsFile)).config, { letterCount: 4, numberCount: 4 });
  const sqlite3 = require('sqlite3');
  const eventDb = new sqlite3.Database(path.join(eventDir, 'tournament.db'));
  await new Promise((resolve, reject) => eventDb.run(
    "INSERT INTO competitors (firstName, lastName, rank, groupDivisionNumber, groupDivisionId, groupDivisionName) VALUES ('Test', 'Competitor', 'D1', 1, 'group-1', 'Division 1')",
    (error) => error ? reject(error) : resolve()
  ));
  await new Promise((resolve, reject) => eventDb.close((error) => error ? reject(error) : resolve()));
  assert.equal((await request('/events/activate', { eventName: 'Event' })).status, 200);
  const modified = { ...metadata, ringConfigX: 2, ringConfigY: 3 };
  assert.equal((await request('/events/modify', modified)).status, 200);
  let board = await request('/rings?eventName=Event');
  assert.equal(board.status, 200);
  assert.equal(board.data.rings.length, 6);
  assert.equal((await request('/events/config?eventName=Event')).data.configurationLocked, false);
  assert.equal((await request('/rings/ring-a-1/queue?eventName=Event', { groupDivisionNumber: 1 })).status, 200);
  const settings = await request('/events/config?eventName=Event');
  assert.equal(settings.data.configurationLocked, true);
  for (const change of [{ location: 'New venue' }, { tournamentDays: 1 }, { ringConfigX: 4 }, {}]) {
    const rejected = await request('/events/modify', { ...modified, ...change });
    assert.equal(rejected.status, 409);
    assert.match(rejected.data.error, /locked/);
  }
  const stateBeforeNoop = fs.readFileSync(assignmentsFile, 'utf8');
  assert.equal((await request('/rings/config?eventName=Event', { letterCount: 2, numberCount: 3 })).status, 200);
  assert.equal(fs.readFileSync(assignmentsFile, 'utf8'), stateBeforeNoop);
  assert.equal((await request('/rings/config?eventName=Event', { letterCount: 3, numberCount: 3 })).status, 409);
  assert.equal((await request('/reset', {})).status, 200);
  assert.equal((await request('/events/modify', modified)).status, 409);
  const resultsDir = path.join(eventDir, 'results');
  fs.writeFileSync(path.join(resultsDir, 'result.json'), '{"winner":"Test"}');
  const databaseBefore = fs.readFileSync(path.join(eventDir, 'tournament.db'));
  assert.equal((await request('/events/reset-run', { eventName: 'Event' })).status, 400);
  const reset = await request('/events/reset-run', { eventName: 'Event', confirm: true });
  assert.equal(reset.status, 200);
  assert.equal(fs.readFileSync(path.join(eventDir, reset.data.archive, 'results', 'result.json'), 'utf8'), '{"winner":"Test"}');
  assert.deepEqual(fs.readFileSync(path.join(eventDir, 'tournament.db')), databaseBefore);
  assert.equal((await request('/events/active')).data.activeEvent, 'Event');
  assert.equal((await request('/groups?eventName=Event')).data.groups.length, 1);
  assert.equal((await request('/events/config?eventName=Event')).data.configurationLocked, false);
  assert.equal((await request('/events/modify', { ...modified, ringConfigX: 3, tournamentDays: 1 })).status, 200);
  board = await request('/rings?eventName=Event');
  assert.equal(board.data.rings.length, 9);
  assert.equal(board.data.schedule.tournamentDays, 1);
});
