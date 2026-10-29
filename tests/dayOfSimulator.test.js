const assert = require('node:assert/strict');
const test = require('node:test');

const { createDayOfSimulator } = require('../backend/dayOfSimulator');

function makeHarness({ rings, groups, failQueueRing = '' }) {
  const calls = [];
  const ringStates = new Map();
  const randomValues = [];
  const simulator = createDayOfSimulator({
    runId: 'sim-test-1',
    eventName: 'spring-event',
    rings,
    groups,
    scenarioSeed: 'repeatable-seed',
    startAt: '2026-01-01T00:00:00.000Z',
    stepDurationMs: 30_000,
    createRingClient({ runId, eventName, ringId }) {
      const state = {
        groupIndex: -1,
        completed: [],
        currentGroupNumber: '',
        heartbeatBodies: []
      };
      ringStates.set(ringId, state);
      return {
        simulationScope: { kind: 'simulator-run', runId, eventName, ringId },
        async queue(groupDivisionNumber) {
          calls.push(['queue', ringId, groupDivisionNumber]);
          if (ringId === failQueueRing) throw new Error(`queue failed for ${ringId}`);
        },
        async bootstrap({ tabletLabel }) {
          calls.push(['bootstrap', ringId, tabletLabel]);
          state.groupIndex = 0;
          state.currentGroupNumber = rings.find((ring) => ring.ringId === ringId).groupDivisionNumbers[0] || '';
          return response(state);
        },
        async heartbeat(body) {
          calls.push(['heartbeat', ringId, body]);
          state.heartbeatBodies.push(body);
          return response(state);
        },
        async complete(packet) {
          calls.push(['complete', ringId, packet]);
          state.completed.push(packet.groupDivisionNumber);
          state.groupIndex += 1;
          state.currentGroupNumber =
            rings.find((ring) => ring.ringId === ringId).groupDivisionNumbers[state.groupIndex] || '';
          return response(state);
        }
      };
    },
    buildResultPacket({ runId, eventName, ringId, group, completedAt, random }) {
      randomValues.push(random());
      return {
        eventName,
        ringId,
        groupId: String(group.groupDivisionNumber),
        groupDivisionNumber: group.groupDivisionNumber,
        completedAt,
        participants: [],
        simulation: { runId }
      };
    },
  });
  return { simulator, calls, ringStates, randomValues };
}

function response(state) {
  return {
    currentGroupDivisionNumber: state.currentGroupNumber,
    currentGroupId: state.currentGroupNumber
  };
}

test('simulates prebuilt ring assignments through phase heartbeats and division completion', async () => {
  const rings = [
    { ringId: 'ring-a-1', ringLabel: 'A1', groupDivisionNumbers: [1, 2] },
    { ringId: 'ring-b-1', ringLabel: 'B1', groupDivisionNumbers: [3] }
  ];
  const groups = {
    1: { groupDivisionNumber: 1, competitors: [{ id: 'a' }, { id: 'b', weaponsEligible: true }] },
    2: { groupDivisionNumber: 2, competitors: [{ id: 'c' }] },
    3: { groupDivisionNumber: 3, competitors: [{ id: 'd' }] }
  };
  const { simulator, calls, ringStates } = makeHarness({ rings, groups });

  const state = await simulator.runToCompletion();

  assert.deepEqual(state.rings.map((ring) => ring.completedGroupNumbers), [['1', '2'], ['3']]);
  assert.ok(state.rings.every((ring) => ring.state === 'complete'));
  assert.equal(calls.filter(([name]) => name === 'queue').length, 3);
  assert.equal(calls.filter(([name]) => name === 'bootstrap').length, 2);
  assert.equal(calls.filter(([name]) => name === 'complete').length, 3);
  assert.equal(calls.filter(([name, , body]) => name === 'heartbeat' && body.phase === 'weapons').length, 4);
  assert.equal(calls.filter(([name, , body]) => name === 'heartbeat' && body.phase === 'setup').length, 12);
  assert.deepEqual(ringStates.get('ring-a-1').completed, [1, 2]);
  const simulatedPackets = calls.filter(([name]) => name === 'complete').map(([, , packet]) => packet);
  assert.ok(simulatedPackets.every((packet) => packet.simulation.runId === 'sim-test-1'));
  assert.ok(simulatedPackets.every((packet) => packet.simulation.seed === 'repeatable-seed'));
  assert.equal(state.status, 'complete');
  assert.equal(state.startedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(state.stepDurationMs, 30_000);
  assert.equal(state.operationCount, state.events.length);
  assert.deepEqual(state.rings[0].queuedGroupNumbers, []);
  assert.deepEqual(state.rings[0].pendingGroupNumbers, []);
  assert.deepEqual(state.rings[0].completedGroupNumbers, ['1', '2']);
  assert.ok(state.events.every((event, index) =>
    event.sequence === index + 1 && Number.isFinite(Date.parse(event.simulatedAt))));
  assert.ok(state.events.filter((event) => event.type === 'division_completed')
    .every((event) => event.durationMs > 0 && event.estimatedDurationMinutes > 0));
  const setupProgress = state.events.filter((event) => event.type === 'phase_progress' && event.phase === 'setup')
    .filter((event) => event.groupDivisionNumber === '1')
    .map((event) => event.progress);
  assert.deepEqual(setupProgress.slice(0, 4), [25, 50, 75, 100]);
  const firstPacket = simulatedPackets[0];
  const firstCompletion = state.events.find((event) =>
    event.type === 'division_completed' &&
    event.ringId === firstPacket.ringId &&
    event.groupDivisionNumber === String(firstPacket.groupDivisionNumber));
  assert.equal(firstPacket.simulation.simulatedAt, firstCompletion.simulatedAt);
});

test('exposes report upload, division loading and final idle without production phase heartbeats', async () => {
  const { simulator, calls } = makeHarness({
    rings: [{ ringId: 'ring-a-1', ringLabel: 'A1', groupDivisionNumbers: [1, 2] }],
    groups: {
      1: { groupDivisionNumber: 1, competitors: [{ id: 'a' }] },
      2: { groupDivisionNumber: 2, competitors: [{ id: 'b' }] }
    }
  });
  const phases = [];
  for (let index = 0; index < 100; index += 1) {
    const ring = await simulator.step('ring-a-1');
    phases.push(ring.currentPhase);
    if (ring.currentPhase === 'uploading-report') {
      assert.equal(calls.filter(([name]) => name === 'complete').length, ring.completedCount);
      assert.equal(ring.currentGroupNumber, String(ring.completedCount + 1));
    }
    if (ring.currentPhase === 'loading-division') {
      assert.equal(ring.currentGroupNumber, '2');
      assert.equal(ring.completedCount, 1);
      assert.equal(calls.filter(([name]) => name === 'complete').length, 1);
    }
    if (ring.state === 'complete') break;
  }
  assert.ok(phases.includes('uploading-report'));
  const loadingIndex = phases.indexOf('loading-division');
  assert.ok(loadingIndex > phases.indexOf('uploading-report'));
  assert.equal(phases[loadingIndex + 1], 'setup');
  assert.equal(phases.at(-1), 'idle');
  assert.equal(simulator.getState().rings[0].state, 'complete');
  assert.ok(calls.filter(([name]) => name === 'heartbeat')
    .every(([, , body]) => !['uploading-report', 'loading-division', 'idle'].includes(body.phase)));
});

test('advances one simulated operation at a time', async () => {
  const { simulator, calls } = makeHarness({
    rings: [{ ringId: 'ring-a-1', ringLabel: 'A1', groupDivisionNumbers: [7] }],
    groups: { 7: { groupDivisionNumber: 7, competitors: [{ id: 'a' }] } }
  });

  assert.equal(simulator.getState().rings[0].state, 'ready');
  await simulator.step('ring-a-1');
  assert.equal(simulator.getState().rings[0].state, 'ready');
  assert.equal(calls[0][0], 'queue');
  assert.deepEqual(simulator.getState().rings[0].queuedGroupNumbers, ['7']);
  assert.deepEqual(simulator.getState().rings[0].pendingGroupNumbers, []);
  await simulator.step('ring-a-1');
  assert.equal(simulator.getState().rings[0].state, 'running');
  assert.equal(simulator.getState().rings[0].currentGroupNumber, '7');
  assert.deepEqual(simulator.getState().rings[0].queuedGroupNumbers, []);
  assert.equal(calls.length, 2);
  await simulator.step('ring-a-1');
  assert.equal(calls.at(-1)[0], 'heartbeat');
});

test('replays the same scenario seed and virtual start time deterministically', async () => {
  const options = {
    rings: [{ ringId: 'ring-a-1', ringLabel: 'A1', groupDivisionNumbers: [7] }],
    groups: { 7: { groupDivisionNumber: 7, competitors: [{ id: 'a' }] } }
  };
  const first = makeHarness(options);
  const second = makeHarness(options);

  const [firstState, secondState] = await Promise.all([
    first.simulator.runToCompletion(),
    second.simulator.runToCompletion()
  ]);

  assert.equal(firstState.scenarioId, secondState.scenarioId);
  const withoutActualTimes = (events) => events.map(({ occurredAt, ...event }) => {
    assert.ok(Number.isFinite(Date.parse(occurredAt)));
    return event;
  });
  assert.deepEqual(withoutActualTimes(firstState.events), withoutActualTimes(secondState.events));
  assert.deepEqual(first.randomValues, second.randomValues);
  assert.equal(firstState.simulatedAt, secondState.simulatedAt);
});

test('reports a failed ring and continues progressing other rings', async () => {
  const { simulator } = makeHarness({
    failQueueRing: 'ring-a-1',
    rings: [
      { ringId: 'ring-a-1', ringLabel: 'A1', groupDivisionNumbers: [1] },
      { ringId: 'ring-b-1', ringLabel: 'B1', groupDivisionNumbers: [2] }
    ],
    groups: {
      1: { groupDivisionNumber: 1, competitors: [] },
      2: { groupDivisionNumber: 2, competitors: [] }
    }
  });

  const state = await simulator.runToCompletion();

  assert.equal(state.status, 'failed');
  assert.equal(state.rings[0].state, 'failed');
  assert.match(state.rings[0].error, /queue failed/);
  assert.equal(state.rings[1].state, 'complete');
  assert.equal(state.errors.length, 1);
  assert.equal(state.events.at(-1).type, 'division_completed');
  assert.ok(state.events.some((event) => event.type === 'operation_failed'));
});

test('rejects clients not explicitly scoped to the simulator run', () => {
  assert.throws(() => createDayOfSimulator({
    runId: 'sim-test-1',
    eventName: 'spring-event',
    rings: [{ ringId: 'ring-a-1', ringLabel: 'A1', groupDivisionNumbers: [] }],
    groups: {},
    createRingClient: () => ({ bootstrap() {}, heartbeat() {}, complete() {} }),
    buildResultPacket() {}
  }), /not scoped to simulator run/);
});

test('rejects result packets that do not match the active run assignment', async () => {
  const simulator = createDayOfSimulator({
    runId: 'sim-test-1',
    eventName: 'spring-event',
    rings: [{ ringId: 'ring-a-1', ringLabel: 'A1', groupDivisionNumbers: [7] }],
    groups: { 7: { groupDivisionNumber: 7, competitors: [] } },
    createRingClient({ runId, eventName, ringId }) {
      return {
        simulationScope: { kind: 'simulator-run', runId, eventName, ringId },
        async queue() {},
        async bootstrap() { return { currentGroupDivisionNumber: 7 }; },
        async heartbeat() {},
        async complete() { throw new Error('must not submit mismatched packet'); }
      };
    },
    buildResultPacket: () => ({ eventName: 'spring-event', ringId: 'ring-a-1', groupId: '99' })
  });

  await simulator.step('ring-a-1');
  for (let index = 0; index < 30; index += 1) {
    if (simulator.getState().rings[0].state === 'failed') break;
    try {
      await simulator.step('ring-a-1');
    } catch (error) {
      assert.match(error.message, /does not match active simulator assignment/);
      break;
    }
  }
  assert.equal(simulator.getState().rings[0].state, 'failed');
});
