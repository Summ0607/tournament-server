const assert = require('node:assert/strict');
const test = require('node:test');

const simulatorModule = require('../backend/dayOfSimulator');
const originalCreateSimulator = simulatorModule.createDayOfSimulator;
let currentSimulator;
simulatorModule.createDayOfSimulator = () => currentSimulator;
const { createSimulatorRunRouter } = require('../backend/simulatorRunRoutes');
simulatorModule.createDayOfSimulator = originalCreateSimulator;

async function drain() {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}

function fixture(t, { completeAfter = Infinity, failRing, failPersistence, beforeStep } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-27T12:00:00Z') });
  const rings = [
    { ringId: 'small', state: 'running', recommendedDelayMs: 10, steps: 0 },
    { ringId: 'large', state: 'running', recommendedDelayMs: 1000, steps: 0 }
  ];
  const errors = [];
  currentSimulator = {
    getState: () => ({ rings: rings.map((ring) => ({ ...ring })), errors: [...errors] }),
    async step(ringId) {
      const ring = rings.find((item) => item.ringId === ringId);
      ring.steps += 1;
      if (beforeStep) await beforeStep(ring);
      if (ringId === failRing) {
        ring.state = 'failed';
        errors.push({ ringId, message: 'Ring operation failed' });
        throw new Error('Ring operation failed');
      }
      if (ring.steps >= completeAfter) ring.state = 'complete';
      return { ...ring };
    }
  };
  let manifest = { runId: 'scheduler', sourceEventName: 'Test', status: 'created', speed: 1 };
  let writes = 0;
  const store = {
    createRun() {},
    getRun: () => manifest,
    listRuns: () => [manifest],
    getRunWorkspace: () => ({
      manifest,
      groups: [],
      assignments: { rings: Object.fromEntries(rings.map((ring) => [ring.ringId, {}])) }
    }),
    resetRun() {},
    deleteRun() {},
    updateRun(_runId, patch) {
      writes += 1;
      if (writes === failPersistence) throw new Error('Persistence failed');
      manifest = {
        ...manifest,
        ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
      };
      return manifest;
    }
  };
  const router = createSimulatorRunRouter({
    eventsRoot: __dirname,
    simulatorRunStore: store,
    loadGroupsFromDatabase: async () => [],
    createRunClient: () => ({})
  });
  async function post(action, body = {}) {
    const layer = router.stack.find((item) =>
      item.route && item.route.path === `/simulator/runs/:runId/${action}`);
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; }
    };
    await layer.route.stack[0].handle({ params: { runId: 'scheduler' }, body }, response);
    await drain();
    return response;
  }
  async function tick(milliseconds) {
    t.mock.timers.tick(milliseconds);
    await drain();
  }
  t.after(() => post('stop'));
  return { rings, post, tick, getRun: () => manifest };
}

test('rings independently advance at their own operation durations', async (t) => {
  const { rings, post, tick, getRun } = fixture(t);
  assert.equal((await post('start')).statusCode, 202);
  assert.deepEqual(rings.map((ring) => ring.steps), [1, 1]);
  for (let step = 0; step < 4; step += 1) await tick(10);
  assert.deepEqual(rings.map((ring) => ring.steps), [5, 1]);
  assert.equal(getRun().state.rings[0].steps, 5);
  await tick(960);
  assert.deepEqual(rings.map((ring) => ring.steps), [6, 2]);
});

test('pause, resume, speed changes, and stop interrupt all independent waits', async (t) => {
  const { rings, post, tick, getRun } = fixture(t);
  await post('start');
  assert.equal((await post('pause')).body.status, 'paused');
  await tick(5000);
  assert.deepEqual(rings.map((ring) => ring.steps), [1, 1]);
  assert.equal((await post('resume')).statusCode, 202);
  assert.deepEqual(rings.map((ring) => ring.steps), [1, 1]);
  assert.equal((await post('speed', { speed: 20 })).body.speed, 20);
  assert.deepEqual(rings.map((ring) => ring.steps), [1, 1]);
  await tick(10);
  assert.deepEqual(rings.map((ring) => ring.steps), [2, 1]);
  await tick(40);
  assert.deepEqual(rings.map((ring) => ring.steps), [3, 2]);
  assert.equal((await post('stop')).body.status, 'stopped');
  const stoppedSteps = rings.map((ring) => ring.steps);
  await tick(10000);
  assert.deepEqual(rings.map((ring) => ring.steps), stoppedSteps);
  assert.equal(getRun().status, 'stopped');
  assert.equal((await post('resume')).statusCode, 409);
});

test('completion waits for every ring without repeatedly stepping a finished ring', async (t) => {
  const { rings, post, tick, getRun } = fixture(t, { completeAfter: 2 });
  await post('start');
  await tick(10);
  assert.equal(rings[0].state, 'complete');
  assert.equal(rings[1].state, 'running');
  await tick(990);
  assert.deepEqual(rings.map((ring) => ring.steps), [2, 2]);
  await tick(1000);
  assert.equal(getRun().status, 'complete');
  assert.ok(getRun().wallClockCompletedAt);
  await tick(10000);
  assert.deepEqual(rings.map((ring) => ring.steps), [2, 2]);
});

test('a failed ring does not prevent other rings finishing and the run reports failure', async (t) => {
  const { rings, post, tick, getRun } = fixture(t, { completeAfter: 2, failRing: 'small' });
  await post('start');
  assert.equal(rings[0].state, 'failed');
  await tick(1000);
  await tick(1000);
  assert.equal(getRun().status, 'failed');
  assert.match(getRun().failure, /Ring operation failed/);
  assert.deepEqual(rings.map((ring) => ring.steps), [1, 2]);
});

test('persistence failure wakes sibling waits and drains them before the runner exits', async (t) => {
  const { rings, post, tick, getRun } = fixture(t, { failPersistence: 3 });
  await post('start');
  assert.equal(getRun().status, 'failed');
  assert.match(getRun().failure, /Persistence failed/);
  const failedSteps = rings.map((ring) => ring.steps);
  await tick(10000);
  assert.deepEqual(rings.map((ring) => ring.steps), failedSteps);
});

test('pause drains in-flight operations before resuming without duplicate ring loops', async (t) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { rings, post, tick } = fixture(t, {
    beforeStep: (ring) => ring.ringId === 'large' && ring.steps === 1 ? pending : undefined
  });
  await post('start');
  let paused = false;
  const pause = post('pause').then(() => { paused = true; });
  await drain();
  assert.equal(paused, false);
  release();
  await pause;
  await tick(10000);
  assert.deepEqual(rings.map((ring) => ring.steps), [1, 1]);
  await post('resume');
  await tick(10);
  assert.deepEqual(rings.map((ring) => ring.steps), [2, 1]);
});

test('speed changes retain elapsed work at the old speed and wait the remainder at the new speed', async (t) => {
  const { rings, post, tick, getRun } = fixture(t);
  await post('start');
  await tick(200);
  await post('speed', { speed: 2 });
  const pending = getRun().state.rings.find((ring) => ring.ringId === 'large');
  assert.equal(pending.pendingOperationMs, 800);
  assert.equal(pending.operationWaitSpeed, 2);
  assert.equal(pending.operationWaitStartedAt, '2026-10-27T12:00:00.200Z');
  assert.equal(rings[1].steps, 1);
  await tick(399);
  assert.equal(rings[1].steps, 1);
  await tick(1);
  assert.equal(rings[1].steps, 2);
});

test('pause freezes the remaining operation and resume waits before publishing further progress', async (t) => {
  const { rings, post, tick, getRun } = fixture(t);
  await post('start');
  await tick(250);
  await post('pause');
  const pending = getRun().state.rings.find((ring) => ring.ringId === 'large');
  assert.equal(pending.pendingOperationMs, 750);
  assert.equal(pending.operationWaitStartedAt, null);
  await tick(10000);
  await post('speed', { speed: 3 });
  await post('resume');
  assert.equal(rings[1].steps, 1);
  await tick(249);
  assert.equal(rings[1].steps, 1);
  await tick(1);
  assert.equal(rings[1].steps, 2);
});

test('manual stepping while paused bypasses that ring wait without adding an automated wait', async (t) => {
  const { rings, post, tick, getRun } = fixture(t);
  await post('start');
  await tick(250);
  await post('pause');
  assert.equal((await post('step', { ringId: 'large' })).statusCode, 200);
  assert.equal(rings[1].steps, 2);
  const stateRing = getRun().state.rings.find((ring) => ring.ringId === 'large');
  assert.equal(stateRing.pendingOperationMs, 0);
  assert.equal(stateRing.operationWaitStartedAt, null);
  await post('resume');
  assert.equal(rings[1].steps, 3);
});
