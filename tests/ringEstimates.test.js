const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildEstimates, divisionDurationMs } = require('../backend/ringEstimates');
const express = require('express');
const { createRingRouter } = require('../backend/ringRoutes');

const now = Date.parse('2026-10-25T16:00:00Z');
const minute = 60000;
const group = (id, count = 6) => ({
  groupDivisionNumber: id,
  competitors: Array.from({ length: count }, () => ({ firstName: 'Private', dob: '2010-01-01' }))
});
const online = (extra = {}) => ({
  ringId: 'ring-a-1', ringLabel: 'A1', tabletLabel: 'Tablet', lastHeartbeatAt: new Date(now).toISOString(),
  queuedGroupDivisionNumbers: [], ...extra
});
const active = (extra = {}) => online({
  groupDivisionNumber: '20', assignmentStartedAt: new Date(now - 10 * minute).toISOString(),
  phasePlan: { phases: [
    { state: 'complete', progress: 100 }, { state: 'active', progress: 0 },
    { state: 'upcoming', progress: 0 }, { state: 'upcoming', progress: 0 }
  ] }, ...extra
});
const build = (rings, groups = [group('20'), group('22', 4), group('24', 2)]) =>
  buildEstimates({ eventName: 'Active only', rings, groups, now });
const offset = (value) => (Date.parse(value) - now) / minute;

test('shared duration baseline is seven minutes per saved competitor, with no fabricated empty roster', () => {
  assert.equal(divisionDurationMs(group('20')), 42 * minute);
  assert.equal(divisionDurationMs(group('20', 0)), null);
  assert.equal(divisionDurationMs(null), null);
});

test('queue starts accumulate remaining current work, transition allowances and preceding division durations', () => {
  const result = build([active({ queuedGroupDivisionNumbers: ['22', '24'] })]);
  const ring = result.rings[0];
  assert.equal(ring.current.remainingMs, 31.5 * minute);
  assert.equal(offset(ring.queue[0].window.expectedAt), 33.5);
  assert.equal(offset(ring.queue[1].window.expectedAt), 63.5);
  assert.equal(offset(ring.availability.window.expectedAt), 77.5);
  assert.equal(offset(ring.queue[0].window.earliestAt), 25.125);
  assert.equal(offset(ring.queue[0].window.latestAt), 41.875);
  assert.equal(ring.queue[1].position, 2);
  assert.equal(result.version, 1);
  assert.equal(result.eventName, 'Active only');
  assert.equal(Date.parse(result.validUntil) - now, 30000);
});

test('slower observed pace extends remaining time without treating faster early progress as a guarantee', () => {
  const slower = build([active({ assignmentStartedAt: new Date(now - 21 * minute).toISOString() })]).rings[0];
  assert.equal(slower.current.remainingMs, 63 * minute);
  assert.equal(slower.current.basis, 'baseline-and-observed-pace');
  assert.equal(build([active()]).rings[0].current.basis, 'baseline-and-reported-progress');
  const finished = active({ phasePlan: { phases: [{ state: 'complete' }] } });
  assert.equal(build([finished]).rings[0].current.remainingMs, 2 * minute);
});

test('weapons phase changes applicable progression shares; no queued work is mistaken for active work', () => {
  const ring = active();
  ring.phasePlan.phases.splice(1, 0, { state: 'complete' });
  const current = build([ring]).rings[0].current;
  assert.equal(current.progressPercent, 40);
  assert.equal(current.remainingMs, 25.2 * minute);
  const idle = build([online({ queuedGroupDivisionNumbers: ['22'] })]).rings[0];
  assert.equal(idle.current, null);
  assert.equal(offset(idle.queue[0].window.expectedAt), 2);
});

test('disconnection, missing heartbeat, no tablet, assistance, unknown timing or phase progress explicitly block estimates', () => {
  for (const override of [
    { tabletLabel: '' }, { lastHeartbeatAt: '' }, { lastHeartbeatAt: new Date(now - 90 * 1000).toISOString() },
    { lastHeartbeatAt: new Date(now + 60000).toISOString() }, { assistanceType: 'medical' },
    { assignmentStartedAt: '' }, { assignmentStartedAt: new Date(now + 1000).toISOString() },
    { phasePlan: null }, { phasePlan: { phases: [{ state: 'active', progress: null }] } }
  ]) {
    const ring = build([active({ queuedGroupDivisionNumbers: ['22'], ...override })]).rings[0];
    assert.equal(ring.current.status, 'unavailable', JSON.stringify(override));
    assert.equal(ring.queue[0].status, 'unavailable');
    assert.equal(ring.availability.window, null);
    assert.ok(ring.availability.reason);
  }
});

test('snapshot expires before a connected tablet crosses its disconnect threshold', () => {
  const snapshot = build([online({ lastHeartbeatAt: new Date(now - 85000).toISOString() })]);
  assert.equal(snapshot.rings[0].availability.status, 'estimated');
  assert.equal(Date.parse(snapshot.validUntil) - now, 5000);
});

test('missing queued roster blocks downstream starts but preserves earlier valid projections', () => {
  const ring = build([online({ queuedGroupDivisionNumbers: ['22', 'missing', '24'] })]).rings[0];
  assert.equal(ring.queue[0].status, 'estimated');
  assert.equal(ring.queue[1].status, 'unavailable');
  assert.equal(ring.queue[2].window, null);
  assert.equal(ring.availability.status, 'unavailable');
  assert.equal(build([active()], []).rings[0].current.status, 'unavailable');
});

test('event completion schedules unassigned divisions onto the earliest free ring and reports the last finish', () => {
  const second = online({ ringId: 'ring-a-2', ringLabel: 'A2' });
  const one = build([active({ queuedGroupDivisionNumbers: ['22'] }), second]).eventCompletion;
  assert.equal(one.status, 'estimated');
  assert.equal(one.remainingDivisions, 1);
  assert.equal(offset(one.window.expectedAt), 61.5, 'A1 finishes after A2 runs unassigned division 24');
  assert.equal(offset(one.window.earliestAt), 46.125);
  assert.equal(offset(one.window.latestAt), 76.875);
  const two = build([active({ queuedGroupDivisionNumbers: ['22'] }), second],
    [group('20'), group('22', 4), group('24', 2), group('26', 10)]).eventCompletion;
  assert.equal(offset(two.window.expectedAt), 88, 'division 26 follows 24 on A2, which frees up before A1');
  assert.equal(offset(two.window.latestAt), 110);
});

test('event completion is explicit when blocked, finished or without an active event', () => {
  const blocked = build([active({ queuedGroupDivisionNumbers: ['22'], tabletLabel: '' })]).eventCompletion;
  assert.equal(blocked.status, 'unavailable');
  assert.match(blocked.reason, /^Ring A1: No tablet connected/);
  const missing = build([online()], [group('20'), group('21', 0)]).eventCompletion;
  assert.match(missing.reason, /Division 21 has no saved competitor roster/);
  const finished = build([online({ completedGroupDivisionNumbers: ['20'] })], [group('20')]).eventCompletion;
  assert.equal(finished.status, 'complete');
  assert.equal(build([online()], []).eventCompletion.status, 'unavailable');
  assert.equal(buildEstimates({ eventName: '', rings: [online()], groups: [group('20')], now }).eventCompletion.status, 'unavailable');
});

test('applying a ring layout clears the recorded event start', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'group-server.js'), 'utf8');
  const body = source.match(/function setRingConfig\([^)]*\) \{([\s\S]*?)\n\}/)[1];
  assert.match(body, /state\.eventStartedAt = '';/);
});

test('unassigned suggestions choose earliest feasible ring, remain independent and exclude running queued or completed divisions', () => {
  const result = build([
    online({ queuedGroupDivisionNumbers: ['22'], completedGroupDivisionNumbers: ['24'] }),
    online({ ringId: 'ring-a-2', ringLabel: 'A2' })
  ], [group('20'), group('22'), group('24'), group('26')]);
  assert.deepEqual(result.unassigned.map((entry) => entry.groupDivisionNumber), ['20', '26']);
  for (const entry of result.unassigned) {
    assert.equal(entry.suggestedRingId, 'ring-a-2');
    assert.equal(entry.hypothetical, true);
    assert.equal(offset(entry.window.expectedAt), 2);
  }
  assert.equal(result.rings.length, 2);
});

test('no eligible rings or active event produces explicit unavailable suggestions, never personal monitor data', () => {
  const disconnected = build([online({ tabletLabel: '', queuedGroupDivisionNumbers: ['22'] })]);
  assert.equal(disconnected.unassigned[0].status, 'unavailable');
  const noEvent = buildEstimates({ eventName: '', rings: [online()], groups: [group('20')], now });
  assert.equal(noEvent.status, 'unavailable');
  assert.equal(noEvent.unassigned[0].status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(disconnected), /Private|dob|firstName|Tablet"/);
});

test('empty configured rings support independent planning starts without claiming operational connectivity', () => {
  for (const offline of [
    { tabletLabel: '', lastHeartbeatAt: '' },
    { lastHeartbeatAt: new Date(now - 100000).toISOString() }
  ]) {
    const rings = [online(offline)];
    const before = JSON.stringify(rings);
    const result = build(rings);
    const ring = result.rings[0];
    assert.notEqual(ring.connection, 'connected');
    assert.equal(ring.availability.status, 'estimated');
    assert.equal(ring.availability.planningOnly, true);
    assert.equal(offset(ring.availability.window.expectedAt), 0);
    for (const suggestion of result.unassigned) {
      assert.equal(suggestion.status, 'estimated');
      assert.equal(suggestion.planningOnly, true);
      assert.equal(suggestion.hypothetical, true);
      assert.equal(offset(suggestion.window.expectedAt), 2);
    }
    assert.equal(JSON.stringify(rings), before);
  }
});

test('planning-only exception never hides assistance or guesses disconnected current or queued work', () => {
  for (const override of [
    { assistanceType: 'medical' }, { queuedGroupDivisionNumbers: ['22'] }, { groupDivisionNumber: '20' }
  ]) {
    const result = build([online({ tabletLabel: '', lastHeartbeatAt: '', ...override })]);
    assert.equal(result.rings[0].availability.status, 'unavailable');
    assert.ok(result.unassigned.every((item) => item.status === 'unavailable'));
    assert.ok(result.unassigned.every((item) => item.durationMs > 0));
  }
});

test('projection does not mutate ring state, is deterministic and widens windows down the queue', () => {
  const rings = [active({ queuedGroupDivisionNumbers: ['22', '24'] })];
  const before = JSON.stringify(rings);
  const first = build(rings);
  assert.deepEqual(build(rings), first);
  assert.equal(JSON.stringify(rings), before);
  const width = (entry) => Date.parse(entry.window.latestAt) - Date.parse(entry.window.earliestAt);
  assert.ok(width(first.rings[0].queue[1]) > width(first.rings[0].queue[0]));
});

test('long queues preserve date rollover instead of wrapping clock-only timestamps', () => {
  const groups = Array.from({ length: 20 }, (_, index) => group(String(20 + index)));
  const ring = build([online({ queuedGroupDivisionNumbers: groups.map((entry) => entry.groupDivisionNumber) })], groups).rings[0];
  assert.equal(offset(ring.availability.window.expectedAt), 20 * 44);
  assert.equal(ring.availability.window.expectedAt, '2026-10-26T06:40:00.000Z');
});

test('board and monitor snapshots load saved active-event rosters, reject event races and expose no competitor data', async (t) => {
  let eventName = 'Active only';
  let cache = [];
  const loaded = [];
  let mode = 'normal';
  const state = { rings: { 'ring-a-1': online({ queuedGroupDivisionNumbers: ['22'], lastHeartbeatAt: new Date().toISOString() }) } };
  const app = express();
  app.use('/api', createRingRouter({
    readActiveEvent: () => eventName,
    readAssignmentsState: () => state,
    applyHeartbeatPolicy: () => false,
    writeAssignmentsState: () => assert.fail('Estimate reads must not edit assignments'),
    buildRingResponse: (_req, ringId, ring) => ({ ...ring, ringId }),
    loadGroup: (id) => cache.find((entry) => entry.groupDivisionNumber === id),
    loadGroups: () => cache,
    loadSavedGroups: async (event) => {
      loaded.push(event);
      if (mode === 'error') throw new Error('Roster database unavailable');
      cache = [group('22')];
      if (mode === 'switch') eventName = 'Other event';
    },
    serverBaseUrlForRequest: () => 'http://localhost',
    DISCONNECT_AFTER_MS: 90000
  }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const url = `http://127.0.0.1:${server.address().port}/api/rings`;
  try {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const board = await response.json();
    assert.equal(board.estimates.rings[0].queue[0].status, 'estimated');
    const snapshotResponse = await fetch(`${url}/estimates?eventName=Active%20only`);
    assert.equal(snapshotResponse.status, 200);
    assert.equal(snapshotResponse.headers.get('cache-control'), 'no-store');
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.eventName, 'Active only');
    assert.equal(snapshot.rings[0].queue[0].durationMs, 42 * minute);
    assert.deepEqual(loaded, ['Active only', 'Active only']);
    assert.doesNotMatch(JSON.stringify(snapshot), /Private|firstName|dob|competitors|currentGroup"/);
    const publicResponse = await fetch(`${url}/monitor?eventName=Active%20only`);
    assert.equal(publicResponse.status, 200);
    assert.equal(publicResponse.headers.get('cache-control'), 'no-store');
    const monitor = await publicResponse.json();
    assert.equal(monitor.version, 1);
    assert.equal(monitor.eventName, 'Active only');
    assert.equal(monitor.upcoming[0].divisionNumber, '22');
    assert.ok(monitor.upcoming[0].startWindow);
    assert.doesNotMatch(JSON.stringify(monitor), /Private|firstName|dob|competitors|Tablet|assistanceType|unassigned/);
    assert.equal((await fetch(`${url}/monitor?eventName=Wrong`)).status, 409);
    assert.equal((await fetch(`${url}/estimates?eventName=Wrong`)).status, 409);
    mode = 'switch';
    assert.equal((await fetch(`${url}/estimates`)).status, 409);
    eventName = 'Active only';
    assert.equal((await fetch(`${url}/monitor`)).status, 409);
    eventName = 'Active only';
    assert.equal((await fetch(`${url}?eventName=Active%20only`)).status, 409);
    eventName = 'Active only';
    mode = 'error';
    const log = t.mock.method(console, 'error', () => {});
    assert.equal((await fetch(`${url}/estimates`)).status, 500);
    assert.equal(log.mock.callCount(), 1);
    assert.equal((await fetch(`${url}/monitor`)).status, 500);
    assert.equal(log.mock.callCount(), 2);
    mode = 'normal';
    eventName = '';
    const noEvent = await (await fetch(`${url}/estimates`)).json();
    assert.equal(noEvent.status, 'unavailable');
    assert.equal(noEvent.eventName, null);
    const noEventMonitor = await (await fetch(`${url}/monitor`)).json();
    assert.equal(noEventMonitor.status, 'unavailable');
    assert.deepEqual(noEventMonitor.rings, []);
    assert.deepEqual(noEventMonitor.upcoming, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
