const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const test = require('node:test');
const { createSimulatorRunRouter } = require('../backend/simulatorRunRoutes');
const { createSimulatorRunStore } = require('../backend/simulatorRunStore');
const { estimateDivisionTiming } = require('../backend/simulatorTiming');

function requestJson(server, routePath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port: server.address().port, path: routePath, method
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        try {
          resolve({
            status: response.statusCode, headers: response.headers,
            body: JSON.parse(raw)
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.end();
  });
}

function snapshotFiles(directory) {
  return Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? Object.entries(snapshotFiles(filename))
      : [[filename, fs.readFileSync(filename).toString('base64')]];
  }));
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(__dirname, 'simulator-assignment-fixture-'));
  const eventsRoot = path.join(root, 'events');
  fs.mkdirSync(eventsRoot);
  fs.writeFileSync(path.join(eventsRoot, 'active.json'), '{"activeEvent":"Production"}');
  fs.writeFileSync(path.join(eventsRoot, 'ring-assignments.json'), '{"sentinel":"live assignments"}');
  fs.writeFileSync(path.join(eventsRoot, 'results.json'), '{"sentinel":"live results"}');
  const store = createSimulatorRunStore({ runsRoot: path.join(root, 'runs') });
  const groups = [1, 2, 10, 3, 4].map((number) => ({
    groupDivisionNumber: number, name: `Saved division ${number}`,
    competitors: [{ id: `competitor-${number}` }]
  }));
  const run = store.createRun({
    eventName: 'Saved Tournament', groups,
    assignments: {
      config: { letterCount: 1, numberCount: 1 },
      rings: { 'ring-a-1': { ringLabel: 'A1', groupDivisionNumber: '1' } }
    }
  });
  const workspace = store.getRunWorkspace(run.runId);
  const assignments = workspace.assignments;
  assignments.rings['ring-a-1'].groupDivisionNumber = '1';
  assignments.rings['ring-a-1'].queuedGroupDivisionNumbers = ['2'];
  assignments.pendingGroupDivisionNumbers = [10, 4, 3].map((number) => ({
    groupDivisionNumber: String(number), preferredRingId: null
  }));
  fs.writeFileSync(path.join(workspace.runDirectory, 'ring-assignments.json'), JSON.stringify(assignments));
  const app = express();
  app.use('/api', createSimulatorRunRouter({
    eventsRoot, simulatorRunStore: store,
    loadGroupsFromDatabase: () => { throw new Error('Must not load production groups'); },
    createRunClient: () => { throw new Error('Read-only requests must not create simulator clients'); }
  }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const route = `/api/simulator/runs/${run.runId}/ring-assignment`;
  const start = (speed, updates = {}) => store.updateRun(run.runId, {
    status: 'running', speed, wallClockStartedAt: '2026-10-27T14:00:00.000Z',
    state: {
      startedAt: '2000-01-01T00:00:00.000Z',
      simulatedAt: '2000-01-01T01:00:00.000Z',
      errors: [],
      rings: [{
        ringId: 'ring-a-1', currentGroupNumber: '1', state: 'running',
        currentPhase: 'setup', currentPhaseProgress: 50,
        phaseDurationsMs: estimateDivisionTiming(groups[0]).phaseDurationsMs,
        pendingOperationMs: 120_000,
        operationWaitStartedAt: new Date(Date.now() - 1000).toISOString(),
        operationWaitSpeed: speed
      }]
    },
    ...updates
  });
  return { root, server, store, run, groups, route, start };
}

test('simulator assignment GET is isolated, read-only and uses the board identity with local event start', async (t) => {
  const context = await fixture(t);
  const board = await requestJson(context.server, `/api/simulator/runs/${context.run.runId}/head-table`);
  assert.equal(board.status, 200);
  const other = context.store.createRun({
    eventName: 'Unrelated Run',
    groups: [{ groupDivisionNumber: 99, competitors: [{ id: 'other' }] }],
    assignments: { config: { letterCount: 1, numberCount: 1 }, rings: {} }
  });
  context.start(2);
  const before = snapshotFiles(context.root);
  const response = await requestJson(context.server, context.route);
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(snapshotFiles(context.root), before);
  const body = response.body;
  assert.equal(body.eventName, board.body.eventName);
  assert.equal(body.estimates.eventName, body.eventName);
  assert.equal(body.simulatorRunId, context.run.runId);
  assert.equal(body.runId, context.run.runId);
  assert.equal(body.simulatorStatus, 'running');
  assert.deepEqual(body.ringConfig, { letterCount: 1, numberCount: 1 });
  assert.equal(body.eventStartedAt, '2026-10-27T14:00:00.000Z');
  assert.deepEqual(body.groups, context.groups);
  assert.equal(body.rings[0].groupDivisionNumber, '1');
  assert.deepEqual(body.rings[0].queuedGroupDivisionNumbers, ['2']);
  assert.deepEqual(body.availableGroupDivisionNumbers, ['3', '4', '10']);
  assert.equal(context.store.getRun(other.runId).status, 'created');
  assert.equal(body.estimates.status, 'ready');
  assert.equal(body.estimates.rings[0].availability.status, 'estimated');
});

for (const speed of [2, 5]) {
  test(`simulator assignment scales phase durations, waits, queues and cumulative pending at ${speed}x`, async (t) => {
    const context = await fixture(t);
    const manifest = context.start(speed);
    const response = await requestJson(context.server, context.route);
    assert.equal(response.status, 200);
    const estimates = response.body.estimates;
    const now = Date.parse(estimates.generatedAt);
    const state = manifest.state.rings[0];
    const timing = estimateDivisionTiming(context.groups[0]);
    const wait = Math.max(0, state.pendingOperationMs -
      Math.max(0, now - Date.parse(state.operationWaitStartedAt)) * speed);
    const currentRemaining = (timing.estimatedDurationMs - timing.phaseDurationsMs.setup / 2 +
      wait + 30_000) / speed;
    const ring = estimates.rings[0];
    const expectAt = (value, delay) => assert.equal(Date.parse(value), Math.trunc(now + delay));
    assert.equal(ring.current.durationMs, timing.estimatedDurationMs / speed);
    assert.equal(ring.current.remainingMs, Math.round(currentRemaining));
    expectAt(ring.current.completionWindow.expectedAt, currentRemaining);
    expectAt(ring.queue[0].window.expectedAt, currentRemaining + 60_000 / speed);
    let remaining = currentRemaining + (timing.estimatedDurationMs + 90_000) / speed;
    expectAt(ring.availability.window.expectedAt, remaining);
    assert.deepEqual(estimates.unassigned.map((entry) => entry.groupDivisionNumber), ['3', '4', '10']);
    for (const entry of estimates.unassigned) {
      assert.equal(entry.durationMs, timing.estimatedDurationMs / speed);
      assert.equal(entry.suggestedRingId, 'ring-a-1');
      assert.equal(entry.hypothetical, true);
      expectAt(entry.window.expectedAt, remaining + 60_000 / speed);
      remaining += (timing.estimatedDurationMs + 90_000) / speed;
      expectAt(entry.completionWindow.expectedAt, remaining);
    }
    expectAt(estimates.eventCompletion.window.expectedAt, remaining);
  });
}

test('inactive and failed simulator runs retain durations without clock predictions or heartbeat fallback', async (t) => {
  const context = await fixture(t);
  context.start(5);
  for (const status of ['created', 'paused', 'stopped', 'complete', 'failed']) {
    context.store.updateRun(context.run.runId, {
      status, failure: status === 'failed' ? 'Saved simulator failure' : null
    });
    const before = snapshotFiles(context.root);
    const response = await requestJson(context.server, context.route);
    assert.equal(response.status, 200);
    assert.deepEqual(snapshotFiles(context.root), before);
    const estimates = response.body.estimates;
    assert.equal(estimates.status, 'unavailable');
    assert.match(estimates.reason, status === 'failed' ? /Saved simulator failure/ : new RegExp(status));
    const ring = estimates.rings[0];
    assert.equal(ring.current.status, 'unavailable');
    assert.ok(ring.current.durationMs > 0);
    assert.equal(ring.current.completionWindow, null);
    assert.equal(ring.queue[0].window, null);
    assert.ok(ring.queue[0].durationMs > 0);
    assert.equal(ring.availability.window, null);
    assert.equal(estimates.eventCompletion.window, null);
    assert.ok(estimates.unassigned.every((entry) => entry.window === null && entry.durationMs > 0));
    assert.doesNotMatch(JSON.stringify(estimates), /heartbeat|No tablet connected/);
  }
});

test('empty simulator rings still include pending completion waits and earliest-ring pending projection', async (t) => {
  const context = await fixture(t);
  const manifest = context.start(5);
  const workspace = context.store.getRunWorkspace(context.run.runId);
  const ring = workspace.assignments.rings['ring-a-1'];
  ring.groupDivisionNumber = '';
  ring.queuedGroupDivisionNumbers = [];
  ring.completedGroupDivisionNumbers = ['1', '2'];
  workspace.assignments.rings['ring-a-2'] = { ringLabel: 'A2', queuedGroupDivisionNumbers: [] };
  fs.writeFileSync(path.join(workspace.runDirectory, 'ring-assignments.json'), JSON.stringify(workspace.assignments));
  context.store.updateRun(context.run.runId, {
    state: {
      errors: [], rings: [{
        ...manifest.state.rings[0], currentGroupNumber: '', state: 'complete',
        operationWaitStartedAt: null, pendingOperationMs: 120_000
      }]
    }
  });
  const response = await requestJson(context.server, context.route);
  const estimates = response.body.estimates;
  const now = Date.parse(estimates.generatedAt);
  assert.equal(Date.parse(estimates.rings[0].availability.window.expectedAt), now + 24_000);
  assert.equal(estimates.unassigned[0].suggestedRingId, 'ring-a-2');
  assert.equal(estimates.unassigned[1].suggestedRingId, 'ring-a-1');
  assert.equal(estimates.unassigned[2].suggestedRingId, 'ring-a-2');
});

test('invalid speeds and persisted simulator errors never produce clock predictions', async (t) => {
  const context = await fixture(t);
  for (const speed of [0, -2, null]) {
    context.start(speed);
    const response = await requestJson(context.server, context.route);
    assert.equal(response.body.estimates.status, 'unavailable');
    assert.match(response.body.estimates.reason, /speed is invalid/);
    assert.equal(response.body.estimates.rings[0].availability.window, null);
    assert.equal(response.body.estimates.eventCompletion.window, null);
  }
  const manifest = context.start(2);
  context.store.updateRun(context.run.runId, {
    state: { ...manifest.state, errors: [{ message: 'Simulator packet rejected' }] }
  });
  let response = await requestJson(context.server, context.route);
  assert.match(response.body.estimates.reason, /Simulator packet rejected/);
  assert.equal(response.body.estimates.eventCompletion.status, 'unavailable');
  context.store.updateRun(context.run.runId, {
    state: {
      ...manifest.state,
      rings: [{ ...manifest.state.rings[0], state: 'failed', error: 'Ring execution failed' }]
    }
  });
  response = await requestJson(context.server, context.route);
  assert.match(response.body.estimates.reason, /Ring execution failed/);
  assert.ok(response.body.estimates.unassigned.every((entry) => entry.status === 'unavailable'));
});

test('missing runs and malformed snapshots fail explicitly without reading live data', async (t) => {
  const context = await fixture(t);
  const before = snapshotFiles(context.root);
  const missing = await requestJson(context.server, '/api/simulator/runs/missing/ring-assignment');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'Simulator run not found' });
  assert.deepEqual(snapshotFiles(context.root), before);
  const workspace = context.store.getRunWorkspace(context.run.runId);
  fs.writeFileSync(path.join(workspace.runDirectory, 'groups.json'), 'invalid json');
  t.mock.method(console, 'error', () => {});
  const failed = await requestJson(context.server, context.route);
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { error: 'Failed to build simulator Ring Assignment' });
});
