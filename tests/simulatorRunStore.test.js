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
const { buildSimulatorRunTiming, remainingSimulatorDivisionMs } = require('../backend/simulatorRunTiming');
const { estimateDivisionTiming } = require('../backend/simulatorTiming');
const { createSimulatorResultPacket } = require('../backend/simulatorResultPacket');
const { selectEligibleSparringCompetitors, simulateSparringDivision } = require('../backend/dayOfSparring');

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

function fixture(t, { buildResultPacket, assignments: savedAssignments, groups: savedGroups, tournamentDays = 1 } = {}) {
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
  fs.writeFileSync(path.join(eventDir, 'event-config.json'), JSON.stringify({ tournamentDays }));
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
  const groups = savedGroups || [
    { groupDivisionNumber: 9, name: 'Previously completed', competitors: [] },
    { groupDivisionNumber: 10, name: 'Current group', competitors: [{ id: 'a' }] },
    { groupDivisionNumber: 11, name: 'Queued group', competitors: [{ id: 'b' }] },
    { groupDivisionNumber: 12, name: 'Second ring group', competitors: [{ id: 'c' }] }
  ];
  const store = createSimulatorRunStore({ runsRoot });
  const createRunClient = createSimulatorRunClientFactory({ simulatorRunStore: store });
  const app = express();
  app.use(express.json());
  const router = createSimulatorRunRouter({
    eventsRoot,
    simulatorRunStore: store,
    createRunClient,
    buildResultPacket,
    loadGroupsFromDatabase: async (dbPath) => {
      assert.equal(dbPath, path.join(eventDir, 'tournament.db'));
      return groups;
    }
  });
  app.use('/api', router);
  const serverPromise = new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });

  t.after(async () => {
    const server = await serverPromise;
    await router.shutdown();
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
    router,
    createRunClient,
    serverPromise
  };
}

test('maintenance shutdown stops and persists running and paused simulations without changing source data', async (t) => {
  const data = fixture(t);
  const server = await data.serverPromise;
  const sourceBefore = fs.readFileSync(data.sourceAssignmentsPath, 'utf8');
  const runIds = [];
  for (const paused of [false, true]) {
    const created = await requestJson(server, 'POST', '/api/simulator/runs', { eventName: data.eventName });
    const id = created.body.runId;
    runIds.push(id);
    await requestJson(server, 'POST', `/api/simulator/runs/${id}/speed`, { speed: 1 });
    assert.equal((await requestJson(server, 'POST', `/api/simulator/runs/${id}/start`, {})).status, 202);
    if (paused) assert.equal((await requestJson(server, 'POST', `/api/simulator/runs/${id}/pause`, {})).status, 200);
  }
  await data.router.shutdown();
  for (const id of runIds) {
    const workspace = data.store.getRunWorkspace(id);
    assert.equal(workspace.manifest.status, 'stopped');
    assert.ok(workspace.manifest.state);
  }
  assert.equal(fs.readFileSync(data.sourceAssignmentsPath, 'utf8'), sourceBefore);
});

test('two-day simulator stops after BB results, blocks Day 2 forecasts, explicitly resumes and retains both days logs', async (t) => {
  const groups = [
    { groupDivisionNumber: 1, name: 'Young Gup', ageBracket: '6-9', competitors: [{ id: 'gup', rank: 'G1' }] },
    { groupDivisionNumber: 2, name: 'Adult BB', ageBracket: '18-35', competitors: [{ id: 'bb', rank: 'D1' }] },
    { groupDivisionNumber: 3, name: 'Tiny Tiger', ageBracket: '4-5', competitors: [{ id: 'tt', rank: 'TTLD' }] }
  ];
  const data = fixture(t, { tournamentDays: 2, groups, assignments: {
    config: { letterCount: 1, numberCount: 1 }, rings: {}
  } });
  const server = await data.serverPromise;
  const created = await requestJson(server, 'POST', '/api/simulator/runs', { eventName: data.eventName });
  const id = created.body.runId;
  assert.equal(created.status, 201);
  assert.deepEqual(data.store.getRunWorkspace(id).assignments.rings['ring-a-1'].queuedGroupDivisionNumbers, ['2']);
  const day2Path = `/api/simulator/runs/${id}/schedule/day2`;
  assert.equal((await requestJson(server, 'POST', day2Path, {})).status, 409);
  const forecast = await requestJson(server, 'GET', `/api/simulator/runs/${id}/ring-assignment`);
  assert.equal(forecast.body.schedule.currentDay, 1);
  assert.ok(forecast.body.estimates.unassigned.every((item) => item.status === 'unavailable' && /Day 2/.test(item.reason)));
  assert.equal(forecast.body.estimates.eventCompletion.status, 'unavailable');
  await requestJson(server, 'POST', `/api/simulator/runs/${id}/speed`, { speed: 3600 });
  await requestJson(server, 'POST', `/api/simulator/runs/${id}/run`, {});
  const firstDay = await requestJson(server, 'GET', `/api/simulator/runs/${id}`);
  assert.equal(firstDay.body.status, 'day-break', firstDay.body.failure);
  assert.equal(firstDay.body.diagnostics.schedule.day1Complete, true);
  assert.equal(firstDay.body.diagnostics.progress.completedGroupCount, 1);
  assert.equal(firstDay.body.diagnostics.results.length, 1);
  const day1Events = firstDay.body.diagnostics.runLog.length;
  assert.equal(firstDay.body.wallClockCompletedAt, undefined);
  assert.equal((await requestJson(server, 'POST', day2Path, {})).status, 202);
  assert.equal((await requestJson(server, 'POST', day2Path, {})).status, 409);
  const finished = await requestJson(server, 'POST', `/api/simulator/runs/${id}/run`, {});
  assert.equal(finished.status, 200);
  const secondDay = await requestJson(server, 'GET', `/api/simulator/runs/${id}`);
  assert.equal(secondDay.body.status, 'complete');
  assert.equal(secondDay.body.diagnostics.schedule.currentDay, 2);
  assert.equal(secondDay.body.diagnostics.progress.completedGroupCount, 3);
  assert.equal(secondDay.body.diagnostics.results.length, 3);
  assert.ok(secondDay.body.diagnostics.runLog.length > day1Events);
  assert.deepEqual(secondDay.body.diagnostics.runLog.filter((event) => event.type === 'division_completed')
    .map((event) => event.groupDivisionNumber), ['2', '3', '1']);
  await requestJson(server, 'POST', `/api/simulator/runs/${id}/reset`, {});
  const reset = data.store.getRunWorkspace(id);
  assert.equal(reset.assignments.day2StartedAt, '');
  assert.equal(reset.manifest.previousDayState, undefined);
});

test('remaining simulation time includes unconsumed operation waits and freezes while paused', () => {
  const now = Date.parse('2026-10-27T14:00:00.000Z');
  const state = {
    currentPhase: 'awards', currentPhaseProgress: 50,
    phaseDurationsMs: { setup: 420_000, awards: 600_000 },
    pendingOperationMs: 150_000,
    operationWaitStartedAt: new Date(now - 1000).toISOString(),
    operationWaitSpeed: 20
  };
  assert.equal(remainingSimulatorDivisionMs({}, state, now), 430_000);
  assert.equal(remainingSimulatorDivisionMs({}, state, now + 10_000), 300_000);
  state.operationWaitStartedAt = null;
  assert.equal(remainingSimulatorDivisionMs({}, state, now + 10_000), 450_000);
  state.currentPhase = '';
  assert.equal(remainingSimulatorDivisionMs({}, state, now), 150_000);
  state.currentPhase = 'loading-division';
  assert.equal(remainingSimulatorDivisionMs({}, state, now), 1_170_000);
  state.currentPhase = 'uploading-report';
  assert.equal(remainingSimulatorDivisionMs({}, state, now), 150_000);
});

test('projects local-clock completion from active, queued, and available simulator work', () => {
  const now = Date.parse('2026-10-27T14:00:00.000Z');
  const groups = [1, 2, 3].map((number) => ({ groupDivisionNumber: number, competitors: [{ id: number }] }));
  const workspace = {
    manifest: {
      runId: 'timing-test', scenarioSeed: 'seed', status: 'running', speed: 20,
      wallClockStartedAt: '2026-10-27T13:59:00.000Z',
      state: {
        rings: [{
          ringId: 'ring-a-1', currentPhase: 'hyungs', currentPhaseProgress: 50,
          phaseDurationsMs: { setup: 1000, hyungs: 2000, sparring: 3000, awards: 4000 }
        }], errors: []
      }
    },
    groups,
    assignments: {
      rings: {
        'ring-a-1': { groupDivisionNumber: '1', queuedGroupDivisionNumbers: ['2'] },
        'ring-a-2': { groupDivisionNumber: '', queuedGroupDivisionNumbers: [] }
      },
      pendingGroupDivisionNumbers: [{ groupDivisionNumber: '3' }]
    }
  };
  const queuedDuration = estimateDivisionTiming(groups[1], { scenarioSeed: 'seed', ringId: 'ring-a-1' }).estimatedDurationMs;
  const availableDuration = estimateDivisionTiming(groups[2], { scenarioSeed: 'seed', ringId: 'ring-a-2' }).estimatedDurationMs;
  const remaining = Math.max(8000 + 30_000 + queuedDuration + 90_000, availableDuration + 90_000);
  const timing = buildSimulatorRunTiming(workspace, now);
  assert.equal(timing.startedAt, workspace.manifest.wallClockStartedAt);
  assert.equal(timing.completedAt, null);
  assert.equal(Date.parse(timing.estimatedCompletionAt), Math.trunc(now + remaining / 20));
  workspace.manifest.speed = 40;
  assert.equal(Date.parse(buildSimulatorRunTiming(workspace, now).estimatedCompletionAt), Math.trunc(now + remaining / 40));
  for (const status of ['created', 'paused', 'stopped', 'failed', 'complete']) {
    workspace.manifest.status = status;
    assert.equal(buildSimulatorRunTiming(workspace, now).estimatedCompletionAt, null);
  }
  workspace.manifest.wallClockCompletedAt = '2026-10-27T14:01:00.000Z';
  assert.equal(buildSimulatorRunTiming(workspace, now).completedAt, workspace.manifest.wallClockCompletedAt);
  workspace.manifest.status = 'running';
  workspace.groups = [];
  assert.equal(buildSimulatorRunTiming(workspace, now).estimatedCompletionAt, null);
});

test('run completion includes the final pending operation even after the last assignment clears', () => {
  const now = Date.parse('2026-10-27T14:00:00.000Z');
  const result = buildSimulatorRunTiming({
    manifest: {
      status: 'running', speed: 5,
      state: { rings: [{ ringId: 'ring-a-1', pendingOperationMs: 30_000,
        operationWaitStartedAt: new Date(now - 1000).toISOString(), operationWaitSpeed: 5 }] }
    },
    assignments: { rings: { 'ring-a-1': { queuedGroupDivisionNumbers: [] } } },
    groups: []
  }, now);
  assert.equal(Date.parse(result.estimatedCompletionAt) - now, 5000);
});

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
  assert.equal(response.body.autoAssignedGroupCount, 0);
  const listedRuns = await requestJson(server, 'GET', '/api/simulator/runs');
  assert.equal(listedRuns.status, 200);
  assert.deepEqual(listedRuns.body.runs.map((run) => run.runId), [response.body.runId]);
  assert.equal(fs.readFileSync(data.sourceAssignmentsPath, 'utf8'), sourceAssignmentsBefore);
  assert.equal(fs.readFileSync(data.activeEventPath, 'utf8'), activeEventBefore);

  const runDirectory = path.join(data.runsRoot, response.body.runId);
  const runGroups = JSON.parse(fs.readFileSync(path.join(runDirectory, 'groups.json'), 'utf8'));
  const runAssignments = JSON.parse(fs.readFileSync(path.join(runDirectory, 'ring-assignments.json'), 'utf8'));
  assert.deepEqual(runGroups, data.groups);
  assert.equal(runAssignments.rings['ring-a-1'].groupDivisionNumber, '');
  assert.deepEqual(runAssignments.rings['ring-a-1'].queuedGroupDivisionNumbers, ['10']);
  assert.deepEqual(runAssignments.rings['ring-a-1'].completedGroupDivisionNumbers, []);
  assert.equal(runAssignments.rings['ring-a-1'].tabletLabel, '');
  assert.equal(runAssignments.rings['ring-a-1'].phase, 'idle');
  assert.equal(runAssignments.rings['ring-a-2'].groupDivisionNumber, '');
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
  assert.deepEqual(inspected.body.diagnostics.rings[0].queuedGroupNumbers, ['10']);
  assert.equal(Object.hasOwn(inspected.body.diagnostics.rings[0], 'pendingGroupNumbers'), false);
  assert.equal(inspected.body.diagnostics.availableGroupCount, 1);
  assert.deepEqual(inspected.body.diagnostics.availableGroupNumbers, ['11']);
  assert.equal(inspected.body.diagnostics.reproducibility.scenarioSeed, response.body.runId);
  assert.match(inspected.body.diagnostics.reproducibility.inputSnapshotSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(inspected.body.diagnostics.runLog, []);

  const audience = await requestJson(server, 'GET', `/api/simulator/runs/${response.body.runId}/audience`);
  assert.equal(audience.status, 200);
  assert.equal(audience.body.source, 'simulator');
  assert.equal(audience.body.runId, response.body.runId);
  assert.match(audience.body.eventName, /^SIMULATION · Spring Tournament/);
  assert.equal(audience.body.status, 'ready');
  assert.equal(audience.body.rings[0].status, 'waiting');
  assert.equal(audience.body.rings[0].queuedDivisionNumber, '10');
  assert.equal(audience.body.upcoming.length, 2);
  assert.doesNotMatch(JSON.stringify(audience.body), /Active Production Event|active-result\.json|Real Tablet/);

  for (let index = 0; index < 3; index += 1) {
    const stepped = await requestJson(server, 'POST', `/api/simulator/runs/${response.body.runId}/step`, { ringId: 'ring-a-1' });
    assert.equal(stepped.status, 200);
  }
  const progressingAudience = await requestJson(server, 'GET', `/api/simulator/runs/${response.body.runId}/audience`);
  const progressingRing = progressingAudience.body.rings.find((ring) => ring.ringId === 'ring-a-1');
  assert.equal(progressingRing.status, 'paused');
  assert.equal(progressingRing.divisionNumber, '10');
  assert.deepEqual(progressingRing.phases.filter((phase) => phase.state === 'active').map((phase) => [phase.key, phase.progress]), [['setup', 25]]);
  assert.equal(fs.readFileSync(data.activeEventPath, 'utf8'), activeEventBefore);
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
  const timing = inspected.body.diagnostics.timing;
  assert.ok(Number.isFinite(Date.parse(timing.startedAt)));
  assert.ok(Date.parse(timing.completedAt) >= Date.parse(timing.startedAt));
  assert.equal(timing.estimatedCompletionAt, null);
  const inspectedAgain = await requestJson(server, 'GET', `/api/simulator/runs/${created.body.runId}`);
  assert.deepEqual(inspectedAgain.body.diagnostics.timing, timing);
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

test('completes 16 simulated rings despite transient assignment, manifest, and result file locks', async (t) => {
  const rings = Object.fromEntries(Array.from({ length: 16 }, (_, index) => {
    const letter = String.fromCharCode(65 + Math.floor(index / 4));
    const number = index % 4 + 1;
    return [`ring-${letter.toLowerCase()}-${number}`, {
      ringLabel: `${letter}${number}`,
      groupDivisionNumber: String(index + 1),
      queuedGroupDivisionNumbers: [],
      completedGroupDivisionNumbers: []
    }];
  }));
  const data = fixture(t, {
    assignments: { config: { letterCount: 4, numberCount: 4 }, rings },
    groups: Array.from({ length: 48 }, (_, index) => ({
      groupDivisionNumber: index + 1,
      name: `Division ${index + 1}`,
      competitors: [{ id: `competitor-${index + 1}` }]
    }))
  });
  const server = await data.serverPromise;
  const created = await requestJson(server, 'POST', '/api/simulator/runs', { eventName: data.eventName });
  const runId = created.body.runId;
  const sourceBefore = fs.readFileSync(data.sourceAssignmentsPath, 'utf8');
  const activeBefore = fs.readFileSync(data.activeEventPath, 'utf8');
  const activeAssignmentsPath = path.join(data.activeEventDir, 'ring-assignments.json');
  const activeAssignmentsBefore = fs.readFileSync(activeAssignmentsPath, 'utf8');
  const rename = fs.renameSync;
  const attempts = new Map();
  const lockedTargets = new Set();
  t.mock.method(Atomics, 'wait', () => 'timed-out');
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination.startsWith(path.join(data.runsRoot, runId))) {
      const count = (attempts.get(source) || 0) + 1;
      attempts.set(source, count);
      if (count <= 2) {
        lockedTargets.add(destination);
        throw Object.assign(new Error('Injected temporary file lock'), { code: 'EPERM' });
      }
    }
    return rename(source, destination);
  });

  const speed = await requestJson(server, 'POST', `/api/simulator/runs/${runId}/speed`, { speed: 3600 });
  assert.equal(speed.status, 200);
  const response = await requestJson(server, 'POST', `/api/simulator/runs/${runId}/run`, {});
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.status, 'complete');
  assert.deepEqual(response.body.errors, []);
  assert.equal(response.body.rings.length, 16);
  const completed = response.body.rings.flatMap((ring) => ring.completedGroupNumbers);
  assert.equal(completed.length, 48);
  assert.equal(new Set(completed).size, 48);
  const workspace = data.store.getRunWorkspace(runId);
  assert.equal(workspace.manifest.status, 'complete');
  assert.equal(workspace.assignments.pendingGroupDivisionNumbers.length, 0);
  assert.equal(workspace.assignments.rings['ring-a-1'].groupDivisionNumber, '');
  const resultsDirectory = path.join(workspace.runDirectory, 'results');
  assert.equal(fs.readdirSync(resultsDirectory).length, 48);
  assert.equal(fs.readdirSync(workspace.runDirectory).some((name) => name.endsWith('.tmp')), false);
  assert.ok(lockedTargets.has(path.join(workspace.runDirectory, 'manifest.json')));
  assert.ok(lockedTargets.has(path.join(workspace.runDirectory, 'ring-assignments.json')));
  assert.equal([...lockedTargets].filter((target) => path.dirname(target) === resultsDirectory).length, 48);
  assert.equal(fs.readFileSync(data.sourceAssignmentsPath, 'utf8'), sourceBefore);
  assert.equal(fs.readFileSync(data.activeEventPath, 'utf8'), activeBefore);
  assert.equal(fs.readFileSync(activeAssignmentsPath, 'utf8'), activeAssignmentsBefore);

  const reset = await requestJson(server, 'POST', `/api/simulator/runs/${runId}/reset`, {});
  assert.equal(reset.status, 200);
  assert.equal(reset.body.status, 'created');
  assert.equal(fs.readdirSync(resultsDirectory).length, 0);
  assert.equal(fs.readdirSync(workspace.runDirectory).some((name) => name.endsWith('.tmp')), false);
});

test('failed assignment saves do not commit bootstrap, heartbeat, or completion changes in memory', async (t) => {
  const data = fixture(t);
  const server = await data.serverPromise;
  const created = await requestJson(server, 'POST', '/api/simulator/runs', { eventName: data.eventName });
  const runId = created.body.runId;
  const client = data.createRunClient({ runId, eventName: data.eventName, ringId: 'ring-a-1', ringLabel: 'A1' });
  const otherClient = data.createRunClient({ runId, eventName: data.eventName, ringId: 'ring-a-2', ringLabel: 'A2' });
  const assignmentPath = path.join(data.runsRoot, runId, 'ring-assignments.json');
  const readAssignments = () => data.store.getRunWorkspace(runId).assignments;
  const rename = fs.renameSync;
  let locked = true;
  t.mock.method(Atomics, 'wait', () => 'timed-out');
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (locked && destination === assignmentPath) {
      throw Object.assign(new Error('Injected persistent assignment lock'), { code: 'EPERM' });
    }
    return rename(source, destination);
  });

  const initialAssignments = readAssignments();
  await assert.rejects(client.bootstrap({ tabletLabel: 'sim-test' }), { code: 'EPERM' });
  assert.deepEqual(readAssignments(), initialAssignments);
  locked = false;
  const bootstrapped = await client.bootstrap({ tabletLabel: 'sim-test' });
  assert.equal(bootstrapped.currentGroupDivisionNumber, '10');
  assert.equal(bootstrapped.newlyQueuedGroupDivisionNumber, '11');
  await otherClient.queue('12');

  const beforeHeartbeat = readAssignments();
  locked = true;
  await assert.rejects(client.heartbeat({
    tabletLabel: 'sim-test', phase: 'setup', checkInCount: 99, checkInTotal: 100,
    phaseCompletedCount: 99, phaseTotalCount: 100
  }), { code: 'EPERM' });
  assert.deepEqual(readAssignments(), beforeHeartbeat);
  locked = false;
  await client.heartbeat({ tabletLabel: 'sim-test', phase: 'hyungs' });
  assert.equal(readAssignments().rings['ring-a-1'].checkInCount, beforeHeartbeat.rings['ring-a-1'].checkInCount);
  assert.equal(readAssignments().rings['ring-a-1'].phaseCompletedCount, beforeHeartbeat.rings['ring-a-1'].phaseCompletedCount);

  const packet = createSimulatorResultPacket({
    eventName: data.eventName, ringId: 'ring-a-1', ringLabel: 'A1', tabletLabel: 'sim-test',
    group: data.groups.find((group) => group.groupDivisionNumber === 10),
    completedAt: '2026-10-27T13:00:00.000Z',
    selectEligibleSparringCompetitors,
    simulateSparring: (competitors) => simulateSparringDivision(competitors, { random: () => 0.5 })
  });
  const beforeCompletion = readAssignments();
  locked = true;
  await assert.rejects(client.complete(packet), { code: 'EPERM' });
  assert.deepEqual(readAssignments(), beforeCompletion);
  const resultsDirectory = path.join(data.runsRoot, runId, 'results');
  assert.equal(fs.readdirSync(resultsDirectory).length, 1);
  locked = false;
  const completed = await client.complete(packet);
  assert.ok(completed.serverRecordId);
  assert.equal(completed.currentGroupDivisionNumber, '11');
  assert.deepEqual(readAssignments().rings['ring-a-1'].completedGroupDivisionNumbers, ['10']);
  assert.equal(fs.readdirSync(resultsDirectory).length, 1);
  assert.equal((await otherClient.bootstrap({ tabletLabel: 'other-sim' })).currentGroupDivisionNumber, '12');
  assert.equal(fs.readdirSync(path.dirname(assignmentPath)).some((name) => name.endsWith('.tmp')), false);
});

test('persistent assignment locks remain visible failures with unchanged assignments and a working reset', async (t) => {
  const data = fixture(t);
  const server = await data.serverPromise;
  const created = await requestJson(server, 'POST', '/api/simulator/runs', { eventName: data.eventName });
  const runId = created.body.runId;
  const initialAssignments = data.store.getRunWorkspace(runId).assignments;
  const assignmentPath = path.join(data.runsRoot, runId, 'ring-assignments.json');
  const rename = fs.renameSync;
  t.mock.method(Atomics, 'wait', () => 'timed-out');
  const mockedRename = t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === assignmentPath) {
      throw Object.assign(new Error('Injected persistent assignment lock'), { code: 'EPERM' });
    }
    return rename(source, destination);
  });

  assert.equal((await requestJson(server, 'POST', `/api/simulator/runs/${runId}/step`, { ringId: 'ring-a-1' })).status, 200);
  const failed = await requestJson(server, 'POST', `/api/simulator/runs/${runId}/step`, { ringId: 'ring-a-1' });
  assert.equal(failed.status, 409);
  assert.match(failed.body.error, /persistent assignment lock/);
  const inspected = await requestJson(server, 'GET', `/api/simulator/runs/${runId}`);
  assert.equal(inspected.body.status, 'failed');
  assert.equal(inspected.body.diagnostics.rings[0].state, 'failed');
  assert.deepEqual(data.store.getRunWorkspace(runId).assignments, initialAssignments);
  assert.equal(fs.readdirSync(path.dirname(assignmentPath)).some((name) => name.endsWith('.tmp')), false);
  mockedRename.mock.restore();
  const reset = await requestJson(server, 'POST', `/api/simulator/runs/${runId}/reset`, {});
  assert.equal(reset.status, 200);
  assert.equal(reset.body.status, 'created');
  assert.deepEqual(data.store.getRunWorkspace(runId).assignments, initialAssignments);
});

test('persistent manifest locks stop background execution without an unhandled rejection', async (t) => {
  const data = fixture(t);
  const server = await data.serverPromise;
  const created = await requestJson(server, 'POST', '/api/simulator/runs', { eventName: data.eventName });
  const runId = created.body.runId;
  const manifestPath = path.join(data.runsRoot, runId, 'manifest.json');
  const rename = fs.renameSync;
  let manifestRenames = 0;
  t.mock.method(Atomics, 'wait', () => 'timed-out');
  const log = t.mock.method(console, 'error', () => {});
  const mockedRename = t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === manifestPath && ++manifestRenames > 1) {
      throw Object.assign(new Error('Injected persistent manifest lock'), { code: 'EPERM' });
    }
    return rename(source, destination);
  });

  const response = await requestJson(server, 'POST', `/api/simulator/runs/${runId}/run`, {});
  assert.equal(response.status, 409);
  assert.match(response.body.error, /Failed to persist simulator run.*persistent manifest lock/);
  assert.ok(log.mock.calls.some((call) => String(call.arguments[0]).includes('Failed to persist final simulator state')));
  assert.equal(fs.readdirSync(path.dirname(manifestPath)).some((name) => name.endsWith('.tmp')), false);
  mockedRename.mock.restore();
  const inspected = await requestJson(server, 'GET', `/api/simulator/runs/${runId}`);
  assert.equal(inspected.status, 200);
  assert.equal(inspected.body.status, 'failed');
  assert.match(inspected.body.failure, /persistent manifest lock/);
  const reset = await requestJson(server, 'POST', `/api/simulator/runs/${runId}/reset`, {});
  assert.equal(reset.status, 200);
  assert.equal(reset.body.status, 'created');
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
  assert.equal(firstStep.body.ring.pendingGroupNumbers.length, 0);
});

test('serves a run-scoped read-only Head Table snapshot without exposing active-event data', async (t) => {
  const data = fixture(t);
  const server = await data.serverPromise;
  const sourceAssignmentsBefore = fs.readFileSync(data.sourceAssignmentsPath, 'utf8');
  const activeAssignmentsPath = path.join(data.activeEventDir, 'ring-assignments.json');
  const activeAssignmentsBefore = fs.readFileSync(activeAssignmentsPath, 'utf8');
  const created = await requestJson(server, 'POST', '/api/simulator/runs', { eventName: data.eventName });
  assert.equal(created.status, 201);

  const board = await requestJson(
    server, 'GET', `/api/simulator/runs/${created.body.runId}/head-table`
  );
  assert.equal(board.status, 200);
  assert.equal(board.body.simulatorRunId, created.body.runId);
  assert.equal(board.body.simulatorStatus, 'created');
  assert.match(board.body.eventName, /^SIMULATION · Spring Tournament · /);
  assert.equal(board.body.rings.length, 2);
  assert.equal(board.body.rings[0].ringLabel, 'A1');
  assert.equal(board.body.rings[0].groupDivisionNumber, '');
  assert.deepEqual(board.body.rings[0].queuedGroupDivisionNumbers, ['10']);
  assert.deepEqual(board.body.availableGroupDivisionNumbers, ['11']);
  assert.equal(board.body.groups.length, data.groups.length);
  assert.doesNotMatch(JSON.stringify(board.body), /Active Production Event|active-result\.json|Real Tablet/);
  assert.equal(fs.readFileSync(data.sourceAssignmentsPath, 'utf8'), sourceAssignmentsBefore);
  assert.equal(fs.readFileSync(activeAssignmentsPath, 'utf8'), activeAssignmentsBefore);

  for (let index = 0; index < 3; index += 1) {
    const stepped = await requestJson(
      server, 'POST', `/api/simulator/runs/${created.body.runId}/step`, { ringId: 'ring-a-1' }
    );
    assert.equal(stepped.status, 200);
  }
  const progressingBoard = await requestJson(
    server, 'GET', `/api/simulator/runs/${created.body.runId}/head-table`
  );
  const activeRing = progressingBoard.body.rings.find((ring) => ring.ringId === 'ring-a-1');
  assert.equal(activeRing.groupDivisionNumber, '10');
  assert.ok(activeRing.phasePlan.phases.some((phase) => phase.state === 'active'));
  assert.equal(activeRing.phaseProgress, 25);
  assert.ok(activeRing.lastHeartbeatAt);
  assert.equal(fs.readFileSync(data.sourceAssignmentsPath, 'utf8'), sourceAssignmentsBefore);
  assert.equal(fs.readFileSync(activeAssignmentsPath, 'utf8'), activeAssignmentsBefore);

  const missingRun = await requestJson(server, 'GET', '/api/simulator/runs/missing/head-table');
  assert.equal(missingRun.status, 404);
});

test('supports speed, start, pause, resume, stop, reset, and run-scoped deletion', async (t) => {
  const data = fixture(t);
  const server = await data.serverPromise;
  const first = await requestJson(server, 'POST', '/api/simulator/runs', { eventName: data.eventName });
  const second = await requestJson(server, 'POST', '/api/simulator/runs', { eventName: data.eventName });

  const invalidSpeed = await requestJson(
    server, 'POST', `/api/simulator/runs/${first.body.runId}/speed`, { speed: 3601 }
  );
  assert.equal(invalidSpeed.status, 400);
  const speed = await requestJson(
    server, 'POST', `/api/simulator/runs/${first.body.runId}/speed`, { speed: 1 }
  );
  assert.equal(speed.status, 200);
  assert.equal(speed.body.speed, 1);

  const inspectedBeforeStart = await requestJson(server, 'GET', `/api/simulator/runs/${first.body.runId}`);
  assert.equal(inspectedBeforeStart.status, 200);
  const started = await requestJson(
    server, 'POST', `/api/simulator/runs/${first.body.runId}/start`, { scenarioSeed: 'user-selected-seed' }
  );
  assert.equal(started.status, 202);
  assert.equal(started.body.scenarioSeed, 'user-selected-seed');
  assert.ok(Number.isFinite(Date.parse(started.body.wallClockStartedAt)));
  const paused = await requestJson(server, 'POST', `/api/simulator/runs/${first.body.runId}/pause`, {});
  assert.equal(paused.status, 200);
  assert.equal(paused.body.status, 'paused');
  assert.equal(paused.body.wallClockStartedAt, started.body.wallClockStartedAt);
  const pausedTiming = await requestJson(server, 'GET', `/api/simulator/runs/${first.body.runId}`);
  assert.equal(pausedTiming.body.diagnostics.timing.estimatedCompletionAt, null);
  const resumed = await requestJson(server, 'POST', `/api/simulator/runs/${first.body.runId}/resume`, {});
  assert.equal(resumed.status, 202);
  assert.equal(resumed.body.wallClockStartedAt, started.body.wallClockStartedAt);
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
  assert.equal(reset.body.speed, 1);
  assert.equal(reset.body.wallClockStartedAt, undefined);
  assert.equal(reset.body.wallClockCompletedAt, undefined);
  assert.equal(fs.readdirSync(path.join(firstRunDirectory, 'results')).length, 0);
  const resetAssignments = JSON.parse(fs.readFileSync(path.join(firstRunDirectory, 'ring-assignments.json'), 'utf8'));
  assert.deepEqual(resetAssignments.rings['ring-a-1'].queuedGroupDivisionNumbers, ['10']);
  assert.deepEqual(resetAssignments.pendingGroupDivisionNumbers.map((entry) => entry.groupDivisionNumber), ['11']);

  const deleted = await requestJson(server, 'DELETE', `/api/simulator/runs/${first.body.runId}`);
  assert.equal(deleted.status, 200);
  assert.equal(fs.existsSync(firstRunDirectory), false);
  assert.ok(fs.existsSync(path.join(data.runsRoot, second.body.runId)));
});

test('reset preserves each selected simulator time scale in the saved run', async (t) => {
  const data = fixture(t);
  const server = await data.serverPromise;
  const created = await requestJson(server, 'POST', '/api/simulator/runs', { eventName: data.eventName });
  const runId = created.body.runId;
  for (const speed of [2, 5, 10, 20, 40, 600]) {
    const updated = await requestJson(server, 'POST', `/api/simulator/runs/${runId}/speed`, { speed });
    assert.equal(updated.status, 200);
    const reset = await requestJson(server, 'POST', `/api/simulator/runs/${runId}/reset`, {});
    assert.equal(reset.status, 200);
    assert.equal(reset.body.speed, speed);
    const loaded = await requestJson(server, 'GET', `/api/simulator/runs/${runId}`);
    assert.equal(loaded.status, 200);
    assert.equal(loaded.body.speed, speed);
  }
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

test('simulates a 400-competitor tournament across 16 rings through Audience View to completion', async (t) => {
  const groups = Array.from({ length: 64 }, (_, groupIndex) => ({
    groupDivisionNumber: 100 + groupIndex,
    name: `Division ${100 + groupIndex}`,
    competitors: Array.from({ length: groupIndex < 16 ? 7 : 6 }, (_, competitorIndex) => ({
      id: `competitor-${groupIndex}-${competitorIndex}`
    }))
  }));
  assert.equal(groups.reduce((count, group) => count + group.competitors.length, 0), 400);
  const assignments = {
    config: { letterCount: 4, numberCount: 4 },
    rings: {
      'ring-a-1': {
        ringLabel: 'A1',
        groupDivisionNumber: '100',
        queuedGroupDivisionNumbers: ['116', '132', '148']
      }
    }
  };
  const data = fixture(t, { assignments, groups });
  const sourceAssignmentsBefore = fs.readFileSync(data.sourceAssignmentsPath, 'utf8');
  const activeAssignmentsBefore = fs.readFileSync(path.join(data.activeEventDir, 'ring-assignments.json'), 'utf8');
  const activeResultsBefore = fs.readFileSync(path.join(data.activeEventDir, 'results', 'active-result.json'), 'utf8');
  const server = await data.serverPromise;
  const created = await requestJson(server, 'POST', '/api/simulator/runs', { eventName: data.eventName });

  assert.equal(created.status, 201);
  assert.equal(created.body.groupCount, 64);
  assert.equal(created.body.ringCount, 16);
  assert.equal(created.body.assignedGroupCount, 64);
  assert.equal(created.body.autoAssignedGroupCount, 60);
  const runId = created.body.runId;
  const runDirectory = path.join(data.runsRoot, runId);
  const initialAssignments = JSON.parse(fs.readFileSync(path.join(runDirectory, 'ring-assignments.json'), 'utf8'));
  assert.equal(Object.keys(initialAssignments.rings).length, 16);
  assert.ok(Object.values(initialAssignments.rings).every((ring) => ring.queuedGroupDivisionNumbers.length <= 1));
  assert.equal(initialAssignments.rings['ring-a-1'].groupDivisionNumber, '');
  assert.deepEqual(initialAssignments.rings['ring-a-1'].queuedGroupDivisionNumbers, ['100']);
  assert.equal(initialAssignments.rings['ring-a-2'].groupDivisionNumber, '');
  assert.deepEqual(initialAssignments.rings['ring-a-2'].queuedGroupDivisionNumbers, ['101']);
  assert.equal(initialAssignments.automaticGroupDivisionNumbers.length, 60);
  assert.equal(initialAssignments.pendingGroupDivisionNumbers.length, 48);
  assert.ok(initialAssignments.pendingGroupDivisionNumbers.every((entry) => entry.preferredRingId === null));
  assert.deepEqual(initialAssignments.pendingGroupDivisionNumbers.slice(0, 2).map((entry) => entry.groupDivisionNumber), [
    '116',
    '117'
  ]);
  const initialDiagnostics = await requestJson(server, 'GET', `/api/simulator/runs/${runId}`);
  assert.equal(initialDiagnostics.body.diagnostics.availableGroupCount, 48);
  assert.deepEqual(initialDiagnostics.body.diagnostics.availableGroupNumbers.slice(0, 2), ['116', '117']);
  assert.ok(initialDiagnostics.body.diagnostics.rings.every((ring) =>
    !Object.hasOwn(ring, 'pendingGroupNumbers')));
  const initialAudience = await requestJson(server, 'GET', `/api/simulator/runs/${runId}/audience`);
  assert.equal(initialAudience.status, 200);
  assert.equal(initialAudience.body.rings.length, 16);
  assert.equal(initialAudience.body.upcoming.length, 16);
  assert.ok(initialAudience.body.rings.every((ring) => ring.status === 'waiting'));
  assert.ok(initialAudience.body.rings.every((ring) => ring.queuedDivisionNumber));
  assert.ok(initialAudience.body.upcoming.every((item) => item.position === 1));
  assert.equal(initialAudience.body.source, 'simulator');

  const speed = await requestJson(server, 'POST', `/api/simulator/runs/${runId}/speed`, { speed: 1 });
  assert.equal(speed.status, 200);
  const ringId = 'ring-a-1';
  for (let index = 0; index < 3; index += 1) {
    const stepped = await requestJson(server, 'POST', `/api/simulator/runs/${runId}/step`, { ringId });
    assert.equal(stepped.status, 200);
  }
  const progressionAudience = await requestJson(server, 'GET', `/api/simulator/runs/${runId}/audience`);
  const progressedRing = progressionAudience.body.rings.find((ring) => ring.ringId === ringId);
  assert.equal(progressedRing.status, 'paused');
  assert.equal(progressedRing.divisionNumber, '100');
  assert.equal(progressedRing.phases.find((phase) => phase.state === 'active').key, 'setup');
  assert.equal(progressedRing.phases.find((phase) => phase.state === 'active').progress, 25);
  assert.equal(progressionAudience.body.upcoming.length, 16);

  for (let index = 0; index < 17; index += 1) {
    const stepped = await requestJson(server, 'POST', `/api/simulator/runs/${runId}/step`, { ringId });
    assert.equal(stepped.status, 200);
  }
  const nextDivisionAudience = await requestJson(server, 'GET', `/api/simulator/runs/${runId}/audience`);
  const nextRing = nextDivisionAudience.body.rings.find((ring) => ring.ringId === ringId);
  assert.equal(nextRing.divisionNumber, '116');
  assert.equal(nextRing.queuedDivisionNumber, '117');
  assert.equal(nextDivisionAudience.body.upcoming.length, 16);

  // Loading the promoted division is a separate simulator operation before setup.
  for (let index = 0; index < 2; index += 1) {
    const stepped = await requestJson(server, 'POST', `/api/simulator/runs/${runId}/step`, { ringId });
    assert.equal(stepped.status, 200);
  }
  const resumed = await requestJson(server, 'POST', `/api/simulator/runs/${runId}/resume`, {});
  assert.equal(resumed.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const runningAudience = await requestJson(server, 'GET', `/api/simulator/runs/${runId}/audience`);
  assert.equal(runningAudience.body.simulatorStatus, 'running');
  const runningRing = runningAudience.body.rings.find((ring) => ring.ringId === ringId);
  assert.equal(runningRing.status, 'active');
  assert.ok(runningRing.phases.some((phase) => phase.state === 'active' && phase.progress > 0));
  const accelerated = await requestJson(server, 'POST', `/api/simulator/runs/${runId}/speed`, { speed: 3600 });
  assert.equal(accelerated.status, 200);
  let finalRun;
  const deadline = Date.now() + 30000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const inspected = await requestJson(server, 'GET', `/api/simulator/runs/${runId}`);
    assert.equal(inspected.status, 200);
    finalRun = inspected.body;
  } while (finalRun.status === 'running' && Date.now() < deadline);
  assert.equal(finalRun.status, 'complete', finalRun.failure || 'Simulator did not complete before timeout');
  assert.equal(finalRun.diagnostics.progress.completedGroupCount, 64);
  assert.equal(finalRun.diagnostics.progress.percent, 100);
  assert.equal(finalRun.diagnostics.results.length, 64);
  assert.equal(finalRun.diagnostics.rings.reduce((sum, ring) => sum + ring.completedCount, 0), 64);

  const completedAudience = await requestJson(server, 'GET', `/api/simulator/runs/${runId}/audience`);
  assert.equal(completedAudience.body.source, 'simulator');
  assert.equal(completedAudience.body.simulatorStatus, 'complete');
  assert.equal(completedAudience.body.rings.length, 16);
  assert.ok(completedAudience.body.rings.every((ring) => ring.status === 'waiting' && !ring.divisionNumber));
  assert.equal(completedAudience.body.upcoming.length, 0);

  const finalAssignments = JSON.parse(fs.readFileSync(path.join(runDirectory, 'ring-assignments.json'), 'utf8'));
  const completedGroupNumbers = Object.values(finalAssignments.rings).flatMap((ring) =>
    ring.completedGroupDivisionNumbers);
  assert.equal(completedGroupNumbers.length, 64);
  assert.equal(new Set(completedGroupNumbers).size, 64);
  assert.ok(Object.values(finalAssignments.rings).every((ring) =>
    !ring.groupDivisionNumber &&
    ring.queuedGroupDivisionNumbers.length === 0
  ));
  const reset = await requestJson(server, 'POST', `/api/simulator/runs/${runId}/reset`, {});
  assert.equal(reset.status, 200);
  const resetAssignments = JSON.parse(fs.readFileSync(path.join(runDirectory, 'ring-assignments.json'), 'utf8'));
  assert.ok(Object.values(resetAssignments.rings).every((ring) => ring.queuedGroupDivisionNumbers.length <= 1));
  assert.equal(resetAssignments.pendingGroupDivisionNumbers.length, 48);
  assert.equal(fs.readFileSync(data.sourceAssignmentsPath, 'utf8'), sourceAssignmentsBefore);
  assert.equal(fs.readFileSync(path.join(data.activeEventDir, 'ring-assignments.json'), 'utf8'), activeAssignmentsBefore);
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
