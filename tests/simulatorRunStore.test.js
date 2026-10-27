const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const test = require('node:test');

const { createSimulatorRunStore } = require('../backend/simulatorRunStore');
const { createSimulatorRunRouter } = require('../backend/simulatorRunRoutes');
const { createSimulatorRunClientFactory } = require('../backend/simulatorRunAdapter');

function requestJson(server, method, routePath, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: routePath,
      method,
      headers: body === undefined ? {} : {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        let result;
        try {
          result = raw ? JSON.parse(raw) : null;
        } catch (error) {
          reject(new Error(`Invalid JSON response: ${raw}`));
          return;
        }
        resolve({ status: response.statusCode, body: result });
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function fixture(t, { buildResultPacket, assignments: savedAssignments } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'simulator-run-store-'));
  const eventsRoot = path.join(root, 'events');
  const runsRoot = path.join(root, 'simulator-runs');
  const activeEventPath = path.join(eventsRoot, 'active.json');
  const eventName = 'Spring Tournament';
  const activeEventName = 'Active Production Event';
  const eventDir = path.join(eventsRoot, eventName);
  const activeEventDir = path.join(eventsRoot, activeEventName);
  fs.mkdirSync(eventDir, { recursive: true });
  fs.mkdirSync(path.join(eventDir, 'results'), { recursive: true });
  fs.mkdirSync(path.join(activeEventDir, 'results'), { recursive: true });
  fs.writeFileSync(activeEventPath, JSON.stringify({ activeEvent: activeEventName }));
  fs.writeFileSync(path.join(eventDir, 'results', 'source-result.json'), '{"sentinel":"source"}');
  fs.writeFileSync(path.join(activeEventDir, 'results', 'active-result.json'), '{"sentinel":"active"}');
  fs.writeFileSync(path.join(activeEventDir, 'ring-assignments.json'), '{"sentinel":"active assignments"}');
  fs.writeFileSync(path.join(eventDir, 'tournament.db'), 'db placeholder');
  const sourceAssignments = {
    config: { letterCount: 1, numberCount: 2 },
    eventStartedAt: '2026-10-26T12:00:00.000Z',
    rings: {
      'ring-a-1': {
        ringLabel: 'A1',
        groupDivisionNumber: '10',
        queuedGroupDivisionNumbers: ['11'],
        completedGroupDivisionNumbers: ['9'],
        tabletLabel: 'Real Tablet',
        phase: 'sparring',
        assistanceType: 'medical'
      },
      'ring-a-2': {
        ringLabel: 'A2',
        queuedGroupDivisionNumbers: ['12'],
        completedGroupDivisionNumbers: []
      }
    }
  };
  const sourceAssignmentsPath = path.join(eventDir, 'ring-assignments.json');
  fs.writeFileSync(sourceAssignmentsPath, JSON.stringify(savedAssignments || sourceAssignments, null, 2));
  const groups = [
    { groupDivisionNumber: 9, name: 'Previously completed', competitors: [] },
    { groupDivisionNumber: 10, name: 'Current group', competitors: [{ id: 'a' }] },
    { groupDivisionNumber: 11, name: 'Queued group', competitors: [{ id: 'b' }] },
    { groupDivisionNumber: 12, name: 'Second ring group', competitors: [{ id: 'c' }] }
  ];
  const store = createSimulatorRunStore({ runsRoot });
  const createRunClient = createSimulatorRunClientFactory({ simulatorRunStore: store });
  const app = express();
  app.use(express.json());
  app.use('/api', createSimulatorRunRouter({
    eventsRoot,
    simulatorRunStore: store,
    createRunClient,
    buildResultPacket,
    loadGroupsFromDatabase: async (dbPath) => {
      assert.equal(dbPath, path.join(eventDir, 'tournament.db'));
      return groups;
    }
  }));
  const serverPromise = new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });

  t.after(async () => {
    const server = await serverPromise;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  return {
    root,
    eventsRoot,
    runsRoot,
    eventName,
    activeEventName,
    eventDir,
    activeEventDir,
    activeEventPath,
    sourceAssignmentsPath,
    sourceAssignments,
    groups,
    store,
    serverPromise
  };
}

test('creates an isolated run snapshot with fresh ring state and reproducible inputs', async (t) => {
  const data = fixture(t);
  const sourceAssignmentsBefore = fs.readFileSync(data.sourceAssignmentsPath, 'utf8');
  const activeEventBefore = fs.readFileSync(data.activeEventPath, 'utf8');
  const server = await data.serverPromise;
  const response = await requestJson(server, 'POST', '/api/simulator/runs', { eventName: data.eventName });

  assert.equal(response.status, 201);
  assert.match(response.body.runId, /^[0-9a-f-]{36}$/i);
  assert.equal(response.body.sourceEventName, data.eventName);
  assert.equal(response.body.status, 'created');
  assert.equal(response.body.groupCount, 4);
  assert.equal(response.body.ringCount, 2);
  assert.equal(response.body.assignedGroupCount, 3);
  assert.equal(fs.readFileSync(data.sourceAssignmentsPath, 'utf8'), sourceAssignmentsBefore);
  assert.equal(fs.readFileSync(data.activeEventPath, 'utf8'), activeEventBefore);

  const runDirectory = path.join(data.runsRoot, response.body.runId);
  const runGroups = JSON.parse(fs.readFileSync(path.join(runDirectory, 'groups.json'), 'utf8'));
  const runAssignments = JSON.parse(fs.readFileSync(path.join(runDirectory, 'ring-assignments.json'), 'utf8'));
  assert.deepEqual(runGroups, data.groups);
  assert.deepEqual(runAssignments.rings['ring-a-1'].queuedGroupDivisionNumbers, ['10', '11']);
  assert.deepEqual(runAssignments.rings['ring-a-1'].completedGroupDivisionNumbers, []);
  assert.equal(runAssignments.rings['ring-a-1'].tabletLabel, '');
  assert.equal(runAssignments.rings['ring-a-1'].phase, 'idle');
  assert.deepEqual(runAssignments.rings['ring-a-2'].queuedGroupDivisionNumbers, ['12']);
  assert.equal(runAssignments.eventStartedAt, '');
  assert.ok(fs.statSync(path.join(runDirectory, 'results')).isDirectory());

  const inspected = await requestJson(server, 'GET', `/api/simulator/runs/${response.body.runId}`);
  assert.equal(inspected.status, 200);
  assert.equal(inspected.body.runId, response.body.runId);
  assert.equal(inspected.body.status, response.body.status);
  assert.equal(inspected.body.diagnostics.progress.totalGroupCount, 3);
  assert.equal(inspected.body.diagnostics.progress.completedGroupCount, 0);
  assert.equal(inspected.body.diagnostics.rings[0].currentGroupNumber, null);
  assert.deepEqual(inspected.body.diagnostics.rings[0].queuedGroupNumbers, ['10', '11']);
  assert.equal(inspected.body.diagnostics.reproducibility.scenarioSeed, response.body.runId);
  assert.match(inspected.body.diagnostics.reproducibility.inputSnapshotSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(inspected.body.diagnostics.runLog, []);
});

test('requires an explicit, safe existing event and valid saved inputs', async (t) => {
  const data = fixture(t);
  const server = await data.serverPromise;

  for (const eventName of ['', '../Spring Tournament', 'C:\\outside']) {
    const response = await requestJson(server, 'POST', '/api/simulator/runs', { eventName });
    assert.equal(response.status, 400);
  }
  const omittedEvent = await requestJson(server, 'POST', '/api/simulator/runs', {});
  assert.equal(omittedEvent.status, 400);
  const missingEvent = await requestJson(server, 'POST', '/api/simulator/runs', { eventName: 'missing-event' });
  assert.equal(missingEvent.status, 404);
  const unknownRun = await requestJson(server, 'GET', '/api/simulator/runs/not-a-run');
  assert.equal(unknownRun.status, 404);
  const unknownReset = await requestJson(server, 'POST', '/api/simulator/runs/not-a-run/reset', {});
  assert.equal(unknownReset.status, 404);
  const unknownDelete = await requestJson(server, 'DELETE', '/api/simulator/runs/not-a-run');
  assert.equal(unknownDelete.status, 404);
  assert.equal(fs.existsSync(data.runsRoot), false);
});

test('rejects invalid saved assignments through the create-run API', async (t) => {
  const data = fixture(t, {
    assignments: {
      config: { letterCount: 1, numberCount: 2 },
      rings: {
        'ring-a-1': { queuedGroupDivisionNumbers: ['10'] },
        'ring-a-2': { queuedGroupDivisionNumbers: ['10'] }
      }
    }
  });
  const server = await data.serverPromise;
  const response = await requestJson(server, 'POST', '/api/simulator/runs', { eventName: data.eventName });
  assert.equal(response.status, 409);
  assert.match(response.body.error, /assigned to more than one ring/);
  assert.equal(fs.existsSync(data.runsRoot), false);
});

test('rejects inconsistent saved assignments without creating a workspace', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'simulator-run-validation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createSimulatorRunStore({ runsRoot: path.join(root, 'runs') });
  const groups = [{ groupDivisionNumber: 1, competitors: [] }];
  const duplicateAssignments = {
    config: { letterCount: 1, numberCount: 2 },
    rings: {
      'ring-a-1': { queuedGroupDivisionNumbers: ['1'] },
      'ring-a-2': { queuedGroupDivisionNumbers: ['1'] }
    }
  };
  assert.throws(() => store.createRun({
    eventName: 'event',
    groups,
    assignments: duplicateAssignments
  }), /assigned to more than one ring/);
  assert.equal(fs.existsSync(path.join(root, 'runs')), false);

  assert.throws(() => store.createRun({
    eventName: 'event',
    groups,
    assignments: {
      config: { letterCount: 1, numberCount: 1 },
      rings: { 'ring-a-1': { queuedGroupDivisionNumbers: ['99'] } }
    }
  }), /references missing saved group/);
  assert.equal(fs.existsSync(path.join(root, 'runs')), false);
});

test('runs simulated rings and persists results only inside the run workspace', async (t) => {
  const data = fixture(t);
  const server = await data.serverPromise;
  const created = await requestJson(server, 'POST', '/api/simulator/runs', { eventName: data.eventName });
  const sourceAssignmentsBefore = fs.readFileSync(data.sourceAssignmentsPath, 'utf8');
  const activeEventBefore = fs.readFileSync(data.activeEventPath, 'utf8');
  const sourceResultsBefore = fs.readFileSync(path.join(data.eventDir, 'results', 'source-result.json'), 'utf8');
  const activeAssignmentsBefore = fs.readFileSync(path.join(data.activeEventDir, 'ring-assignments.json'), 'utf8');
  const activeResultsBefore = fs.readFileSync(path.join(data.activeEventDir, 'results', 'active-result.json'), 'utf8');

  const response = await requestJson(
    server,
    'POST',
    `/api/simulator/runs/${created.body.runId}/run`,
    { scenarioSeed: 'run-test', startAt: '2026-10-26T12:00:00.000Z' }
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'complete');
  assert.equal(response.body.errors.length, 0);
  const replay = await requestJson(
    server,
    'POST',
    `/api/simulator/runs/${created.body.runId}/run`,
    {}
  );
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, response.body);

  const runDirectory = path.join(data.runsRoot, created.body.runId);
  const runAssignments = JSON.parse(fs.readFileSync(path.join(runDirectory, 'ring-assignments.json'), 'utf8'));
  const results = fs.readdirSync(path.join(runDirectory, 'results')).filter((name) => name.endsWith('.json'));
  assert.equal(results.length, 3);
  assert.deepEqual(runAssignments.rings['ring-a-1'].completedGroupDivisionNumbers, ['10', '11']);
  assert.deepEqual(runAssignments.rings['ring-a-2'].completedGroupDivisionNumbers, ['12']);
  assert.equal(runAssignments.rings['ring-a-1'].groupDivisionNumber, '');
  assert.equal(fs.readFileSync(data.sourceAssignmentsPath, 'utf8'), sourceAssignmentsBefore);
  assert.equal(fs.readFileSync(data.activeEventPath, 'utf8'), activeEventBefore);
  assert.equal(fs.readFileSync(path.join(data.eventDir, 'results', 'source-result.json'), 'utf8'), sourceResultsBefore);
  assert.equal(fs.readFileSync(path.join(data.activeEventDir, 'ring-assignments.json'), 'utf8'), activeAssignmentsBefore);
  assert.equal(fs.readFileSync(path.join(data.activeEventDir, 'results', 'active-result.json'), 'utf8'), activeResultsBefore);

  const inspected = await requestJson(server, 'GET', `/api/simulator/runs/${created.body.runId}`);
  assert.equal(inspected.body.status, 'complete');
  assert.equal(inspected.body.state.status, 'complete');
  assert.equal(inspected.body.diagnostics.progress.completedGroupCount, 3);
  assert.equal(inspected.body.diagnostics.progress.percent, 100);
  assert.equal(inspected.body.diagnostics.rings[0].completedGroups.length, 2);
  assert.ok(inspected.body.diagnostics.rings[0].completedGroups[0].group);
  assert.ok(inspected.body.diagnostics.rings[0].completedGroups[0].result);
  assert.equal(inspected.body.diagnostics.results.length, 3);
  assert.ok(inspected.body.diagnostics.virtualTime.operationCount > 0);
  assert.ok(inspected.body.diagnostics.runLog.length > 0);
  assert.deepEqual(inspected.body.diagnostics.errors, []);
  assert.equal(inspected.body.diagnostics.reproducibility.scenarioSeed, 'run-test');
  assert.equal(inspected.body.diagnostics.reproducibility.startAt, '2026-10-26T12:00:00.000Z');
  const log = await requestJson(server, 'GET', `/api/simulator/runs/${created.body.runId}/log`);
  assert.equal(log.status, 200);
  assert.equal(log.body.events.length, inspected.body.diagnostics.runLog.length);
  const resultsResponse = await requestJson(server, 'GET', `/api/simulator/runs/${created.body.runId}/results`);
  assert.equal(resultsResponse.status, 200);
  assert.equal(resultsResponse.body.results.length, 3);
  const storedResult = JSON.parse(fs.readFileSync(path.join(runDirectory, 'results', results[0]), 'utf8'));
  assert.equal(storedResult.packetBlock.simulation.runId, created.body.runId);
});

test('steps an individual run-scoped ring and rejects unknown rings', async (t) => {
  const data = fixture(t);
  const server = await data.serverPromise;
  const created = await requestJson(server, 'POST', '/api/simulator/runs', { eventName: data.eventName });

  const missingRing = await requestJson(
    server,
    'POST',
    `/api/simulator/runs/${created.body.runId}/step`,
    {}
  );
  assert.equal(missingRing.status, 400);
  const invalidRing = await requestJson(
    server,
    'POST',
    `/api/simulator/runs/${created.body.runId}/step`,
    { ringId: 'ring-z-99' }
  );
  assert.equal(invalidRing.status, 400);

  const firstStep = await requestJson(
    server,
    'POST',
    `/api/simulator/runs/${created.body.runId}/step`,
    { ringId: 'ring-a-1' }
  );
  assert.equal(firstStep.status, 200);
  assert.equal(firstStep.body.state.status, 'ready');
  assert.equal(firstStep.body.ring.pendingGroupNumbers.length, 1);
});

test('supports speed, start, pause, resume, stop, reset, and run-scoped deletion', async (t) => {
  const data = fixture(t);
  const server = await data.serverPromise;
  const first = await requestJson(server, 'POST', '/api/simulator/runs', { eventName: data.eventName });
  const second = await requestJson(server, 'POST', '/api/simulator/runs', { eventName: data.eventName });

  const invalidSpeed = await requestJson(
    server, 'POST', `/api/simulator/runs/${first.body.runId}/speed`, { speed: 101 }
  );
  assert.equal(invalidSpeed.status, 400);
  const speed = await requestJson(
    server, 'POST', `/api/simulator/runs/${first.body.runId}/speed`, { speed: 0.1 }
  );
  assert.equal(speed.status, 200);
  assert.equal(speed.body.speed, 0.1);

  const started = await requestJson(server, 'POST', `/api/simulator/runs/${first.body.runId}/start`, {});
  assert.equal(started.status, 202);
  const paused = await requestJson(server, 'POST', `/api/simulator/runs/${first.body.runId}/pause`, {});
  assert.equal(paused.status, 200);
  assert.equal(paused.body.status, 'paused');
  const resumed = await requestJson(server, 'POST', `/api/simulator/runs/${first.body.runId}/resume`, {});
  assert.equal(resumed.status, 202);
  const stopped = await requestJson(server, 'POST', `/api/simulator/runs/${first.body.runId}/stop`, {});
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.status, 'stopped');
  assert.ok(stopped.body.state.operationCount > 0);

  const firstRunDirectory = path.join(data.runsRoot, first.body.runId);
  assert.ok(fs.existsSync(path.join(firstRunDirectory, 'groups.json')));
  const stoppedState = JSON.parse(fs.readFileSync(path.join(firstRunDirectory, 'manifest.json'), 'utf8'));
  assert.equal(stoppedState.status, 'stopped');
  assert.equal(stoppedState.state.operationCount, stopped.body.state.operationCount);
  const reset = await requestJson(server, 'POST', `/api/simulator/runs/${first.body.runId}/reset`, {});
  assert.equal(reset.status, 200);
  assert.equal(reset.body.status, 'created');
  assert.equal(reset.body.speed, 10);
  assert.equal(fs.readdirSync(path.join(firstRunDirectory, 'results')).length, 0);
  const resetAssignments = JSON.parse(fs.readFileSync(path.join(firstRunDirectory, 'ring-assignments.json'), 'utf8'));
  assert.deepEqual(resetAssignments.rings['ring-a-1'].queuedGroupDivisionNumbers, ['10', '11']);

  const deleted = await requestJson(server, 'DELETE', `/api/simulator/runs/${first.body.runId}`);
  assert.equal(deleted.status, 200);
  assert.equal(fs.existsSync(firstRunDirectory), false);
  assert.ok(fs.existsSync(path.join(data.runsRoot, second.body.runId)));
});

test('reports packet failures as failed runs rather than successful completion', async (t) => {
  const data = fixture(t, { buildResultPacket: () => ({}) });
  const server = await data.serverPromise;
  const created = await requestJson(server, 'POST', '/api/simulator/runs', { eventName: data.eventName });
  const response = await requestJson(
    server, 'POST', `/api/simulator/runs/${created.body.runId}/run`, {}
  );
  assert.equal(response.status, 409);
  assert.match(response.body.error, /does not match active simulator assignment/);

  const inspected = await requestJson(server, 'GET', `/api/simulator/runs/${created.body.runId}`);
  assert.equal(inspected.body.status, 'failed');
  assert.match(inspected.body.failure, /does not match active simulator assignment/);
  assert.equal(inspected.body.state.status, 'failed');
});

test('keeps competing run assignments and results isolated and deletion scoped', async (t) => {
  const data = fixture(t);
  const server = await data.serverPromise;
  const sourceAssignmentsBefore = fs.readFileSync(data.sourceAssignmentsPath, 'utf8');
  const activeResultsBefore = fs.readFileSync(path.join(data.activeEventDir, 'results', 'active-result.json'), 'utf8');
  const [first, second] = await Promise.all([
    requestJson(server, 'POST', '/api/simulator/runs', { eventName: data.eventName }),
    requestJson(server, 'POST', '/api/simulator/runs', { eventName: data.eventName })
  ]);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.notEqual(first.body.runId, second.body.runId);

  const [firstResult, secondResult] = await Promise.all([
    requestJson(server, 'POST', `/api/simulator/runs/${first.body.runId}/run`, { scenarioSeed: 'first' }),
    requestJson(server, 'POST', `/api/simulator/runs/${second.body.runId}/run`, { scenarioSeed: 'second' })
  ]);
  assert.equal(firstResult.status, 200);
  assert.equal(secondResult.status, 200);

  const firstResults = fs.readdirSync(path.join(data.runsRoot, first.body.runId, 'results'));
  const secondResults = fs.readdirSync(path.join(data.runsRoot, second.body.runId, 'results'));
  assert.equal(firstResults.length, 3);
  assert.equal(secondResults.length, 3);
  const firstRecord = JSON.parse(fs.readFileSync(path.join(data.runsRoot, first.body.runId, 'results', firstResults[0]), 'utf8'));
  const secondRecord = JSON.parse(fs.readFileSync(path.join(data.runsRoot, second.body.runId, 'results', secondResults[0]), 'utf8'));
  assert.equal(firstRecord.packetBlock.simulation.runId, first.body.runId);
  assert.equal(secondRecord.packetBlock.simulation.runId, second.body.runId);
  assert.notEqual(firstRecord.packetBlock.simulation.seed, secondRecord.packetBlock.simulation.seed);

  const deleted = await requestJson(server, 'DELETE', `/api/simulator/runs/${first.body.runId}`);
  assert.equal(deleted.status, 200);
  assert.equal(fs.existsSync(path.join(data.runsRoot, first.body.runId)), false);
  assert.equal(fs.existsSync(path.join(data.runsRoot, second.body.runId)), true);
  assert.equal(fs.readdirSync(path.join(data.runsRoot, second.body.runId, 'results')).length, 3);
  assert.equal(fs.readFileSync(data.sourceAssignmentsPath, 'utf8'), sourceAssignmentsBefore);
  assert.equal(fs.readFileSync(path.join(data.activeEventDir, 'results', 'active-result.json'), 'utf8'), activeResultsBefore);
});

test('marks interrupted runs failed after server restart and requires reset to retry', async (t) => {
  const data = fixture(t);
  const firstServer = await data.serverPromise;
  const created = await requestJson(firstServer, 'POST', '/api/simulator/runs', { eventName: data.eventName });
  data.store.updateRun(created.body.runId, { status: 'running' });

  const restartedApp = express();
  restartedApp.use(express.json());
  restartedApp.use('/api', createSimulatorRunRouter({
    eventsRoot: data.eventsRoot,
    simulatorRunStore: data.store,
    createRunClient: createSimulatorRunClientFactory({ simulatorRunStore: data.store }),
    loadGroupsFromDatabase: async () => data.groups
  }));
  const restartedServer = await new Promise((resolve, reject) => {
    const server = restartedApp.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
  t.after(async () => new Promise((resolve, reject) => {
    restartedServer.close((error) => error ? reject(error) : resolve());
  }));

  const inspected = await requestJson(restartedServer, 'GET', `/api/simulator/runs/${created.body.runId}`);
  assert.equal(inspected.status, 200);
  assert.equal(inspected.body.status, 'failed');
  assert.match(inspected.body.failure, /Server restarted/);
  const resume = await requestJson(restartedServer, 'POST', `/api/simulator/runs/${created.body.runId}/resume`, {});
  assert.equal(resume.status, 409);
  const reset = await requestJson(restartedServer, 'POST', `/api/simulator/runs/${created.body.runId}/reset`, {});
  assert.equal(reset.status, 200);
  assert.equal(reset.body.status, 'created');
  const retried = await requestJson(restartedServer, 'POST', `/api/simulator/runs/${created.body.runId}/run`, {});
  assert.equal(retried.status, 200);
  assert.equal(retried.body.status, 'complete');
});
