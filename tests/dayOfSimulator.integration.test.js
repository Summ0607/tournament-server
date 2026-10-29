const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const test = require('node:test');

const { createDayOfSimulator } = require('../backend/dayOfSimulator');
const { selectEligibleSparringCompetitors } = require('../backend/dayOfSparring');
const { createRingRouter } = require('../backend/ringRoutes');
const { createResultPacketStore } = require('../backend/resultPacket');

const EVENT_NAME = 'simulator-integration-event';

function createRingState(ringLabel) {
  return {
    ringLabel,
    groupDivisionNumber: '',
    currentGroupId: '',
    currentGroupDivisionNumber: '',
    queuedGroupDivisionNumbers: [],
    completedGroupDivisionNumbers: [],
    queuedGroupIds: [],
    completedGroupIds: [],
    assignmentStartedAt: '',
    checkInCount: 0,
    checkInTotal: 0,
    phaseCompletedCount: 0,
    phaseTotalCount: 0,
    phaseProgress: 0,
    assistanceType: '',
    assistanceRequestedAt: '',
    tabletLabel: '',
    lastHeartbeatAt: '',
    phaseStartedAt: '',
    currentPhaseStartTime: '',
    currentPhaseEndTime: null,
    phaseHistory: [],
    phase: 'idle'
  };
}

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
        let parsed;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch (error) {
          reject(new Error(`Invalid JSON from ${method} ${routePath}: ${raw}`));
          return;
        }
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function createPacket({
  eventName,
  ringId,
  ringLabel,
  tabletLabel,
  group,
  completedAt,
  selectEligibleSparringCompetitors: selectEntrants,
  simulateSparring
}) {
  const groupNumber = Number(group.groupDivisionNumber);
  const participants = group.competitors.map((competitor, index) => ({
    participantId: String(competitor.participantId || competitor.id || `${groupNumber}-${index + 1}`),
    competitionDivisionNumber: groupNumber,
    name: String(competitor.name || `Competitor ${index + 1}`),
    studio: String(competitor.studio || 'Test Studio'),
    rankCode: String(competitor.rankCode || competitor.rank || 'G5'),
    rankLabel: String(competitor.rankLabel || competitor.rankCode || competitor.rank || 'G5'),
    age: Number.isInteger(competitor.age) && competitor.age >= 0 ? competitor.age : 18,
    heightInInches: Number.isInteger(competitor.heightInInches) ? competitor.heightInInches : 60,
    checkInStatus: competitor.checkInStatus || 'CHECKED_IN',
    entries: {
      weapons: 'REGISTERED',
      hyungs: 'REGISTERED',
      sparring: (competitor.entries && competitor.entries.sparring) || 'REGISTERED'
    }
  }));
  const sparringEntrants = (selectEntrants || selectEligibleSparringCompetitors)(participants);
  const sparring = simulateSparring
    ? simulateSparring(sparringEntrants)
    : { status: 'NOT_HELD', bracketSize: 0, awards: [], rounds: [] };
  return {
    schemaVersion: 1,
    submissionId: crypto.randomUUID(),
    eventName,
    groupId: String(groupNumber),
    groupDivisionNumber: groupNumber,
    groupName: group.name,
    ringId,
    ringLabel,
    completedAt,
    participants,
    disciplines: {
      weapons: { status: 'NOT_HELD', judgeCount: 0, results: [] },
      hyungs: { status: 'NOT_HELD', judgeCount: 0, results: [] },
      sparring
    },
    overallAwards: { weapons: [], hyungs: [], sparring: sparring.awards },
    signatures: [],
    source: {
      client: 'TournamentScoringApp',
      appVersionName: 'simulator-test',
      appVersionCode: 1,
      tabletLabel,
      createdAt: completedAt
    }
  };
}

async function createFixture(t, ringDefinitions, groups) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'day-of-simulator-integration-'));
  const resultsDirectory = path.join(temporaryRoot, 'results');
  const groupByNumber = new Map(Object.entries(groups).map(([number, group]) => [String(number), group]));
  const state = {
    config: { letterCount: 1, numberCount: Math.max(1, ringDefinitions.length) },
    eventStartedAt: '',
    rings: Object.fromEntries(ringDefinitions.map((ring) => [
      ring.ringId,
      createRingState(ring.ringLabel)
    ]))
  };
  const resultPacketStore = createResultPacketStore({ getResultsDirectory: () => resultsDirectory });
  const app = express();
  app.use(express.json());
  app.use('/api', createRingRouter({
    readAssignmentsState: () => state,
    writeAssignmentsState: () => {},
    applyHeartbeatPolicy: () => false,
    setRingConfig: () => {},
    getRingState: (currentState, ringId) => currentState.rings[ringId] || null,
    listAllowedRingLabels: () => ringDefinitions.map((ring) => ring.ringLabel),
    buildRingResponse: (req, ringId, ringState) => {
      const currentNumber = ringState.groupDivisionNumber || ringState.currentGroupId || '';
      return {
        ringId,
        ringLabel: ringState.ringLabel,
        serverBaseUrl: `http://${req.get('host')}`,
        groupDivisionNumber: currentNumber,
        currentGroupDivisionNumber: currentNumber,
        currentGroupId: currentNumber,
        queuedGroupDivisionNumbers: ringState.queuedGroupDivisionNumbers,
        completedGroupDivisionNumbers: ringState.completedGroupDivisionNumbers,
        checkInCount: ringState.checkInCount,
        checkInTotal: ringState.checkInTotal,
        phaseCompletedCount: ringState.phaseCompletedCount,
        phaseTotalCount: ringState.phaseTotalCount,
        phaseProgress: ringState.phaseProgress,
        tabletLabel: ringState.tabletLabel,
        phase: ringState.phase,
        currentGroup: groupByNumber.get(String(currentNumber)) || null
      };
    },
    touchHeartbeat: (ringState) => {
      ringState.lastHeartbeatAt = 'isolated-test-heartbeat';
    },
    setRingPhase: (ringState, phase) => {
      ringState.phase = phase;
    },
    resetRingToScratch: (ringState) => {
      const ringLabel = ringState.ringLabel;
      Object.assign(ringState, createRingState(ringLabel));
    },
    resetAssignments: () => {},
    groupExists: (groupNumber) => groupByNumber.has(String(groupNumber)),
    findGroupUsageAcrossRings: (currentState, groupNumber, excludedRingId) => {
      for (const [ringId, ringState] of Object.entries(currentState.rings)) {
        if (ringId === excludedRingId) continue;
        if (ringState.groupDivisionNumber === String(groupNumber) ||
            ringState.queuedGroupDivisionNumbers.includes(String(groupNumber))) {
          return { ringLabel: ringState.ringLabel };
        }
      }
      return null;
    },
    loadGroup: (groupNumber) => groupByNumber.get(String(groupNumber)) || null,
    loadGroups: () => Array.from(groupByNumber.values()),
    loadSavedGroups: async () => {},
    serverBaseUrlForRequest: (req) => `http://${req.get('host')}`,
    DISCONNECT_AFTER_MS: 90_000,
    saveUploadedDivisionPacket: () => {},
    resultPacketStore,
    readActiveEvent: () => EVENT_NAME,
    appendDivisionTrace: () => {}
  }));
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.on('error', reject);
  });

  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  function createClient({ runId, eventName, ringId, ringLabel, failAfterQueue = false }) {
    let shouldFailAfterQueue = failAfterQueue;
    const route = `/api/rings/${encodeURIComponent(ringId)}`;
    async function send(method, endpoint, body) {
      const response = await requestJson(server, method, `${route}/${endpoint}`, body);
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`${method} ${endpoint} failed (${response.status}): ${JSON.stringify(response.body)}`);
      }
      return response.body;
    }
    return {
      simulationScope: { kind: 'simulator-run', runId, eventName, ringId },
      async queue(groupDivisionNumber) {
        await send('POST', 'queue', { groupDivisionNumber });
        if (shouldFailAfterQueue) {
          shouldFailAfterQueue = false;
          throw new Error('simulated disconnect after queue acceptance');
        }
      },
      async bootstrap({ tabletLabel }) {
        return send('POST', 'request-group', { tabletLabel });
      },
      async heartbeat(body) {
        return send('POST', 'heartbeat', body);
      },
      async complete(packet) {
        const response = await send('POST', 'complete', packet);
        if (!response.accepted || !response.ringAssignment) {
          throw new Error('Ring completion was not accepted');
        }
        return {
          ...response.ringAssignment,
          serverRecordId: response.serverRecordId
        };
      }
    };
  }

  function makeSimulator({ runId, rings = ringDefinitions, failAfterQueueRing = '' }) {
    return createDayOfSimulator({
      runId,
      eventName: EVENT_NAME,
      rings,
      groups,
      createRingClient(args) {
        return createClient({
          ...args,
          ringLabel: rings.find((ring) => ring.ringId === args.ringId).ringLabel,
          failAfterQueue: args.ringId === failAfterQueueRing
        });
      },
      buildResultPacket: createPacket,
      scenarioSeed: 'integration-test-seed',
      startAt: '2026-01-01T00:00:00.000Z',
      stepDurationMs: 1_000
    });
  }

  return { server, state, resultsDirectory, resultPacketStore, makeSimulator };
}

test('completes prebuilt work across multiple real ring routes and persists only in isolated results', async (t) => {
  const rings = [
    { ringId: 'ring-a-1', ringLabel: 'A1', groupDivisionNumbers: [11, 12] },
    { ringId: 'ring-b-1', ringLabel: 'B1', groupDivisionNumbers: [13] }
  ];
  const groups = Object.fromEntries([11, 12, 13].map((number) => [number, {
    groupDivisionNumber: number,
    name: `Division ${number}`,
    competitors: number === 11
      ? [
        { id: 'c1', name: 'C1', studio: 'A', heightInInches: 57 },
        { id: 'c2', name: 'C2', studio: 'B', heightInInches: 58 },
        { id: 'c3', name: 'C3', studio: 'A', heightInInches: 60 },
        { id: 'c4', name: 'C4', studio: 'B', heightInInches: 61 }
      ]
      : []
  }]));
  const fixture = await createFixture(t, rings, groups);
  const simulator = fixture.makeSimulator({ runId: 'integration-run-1' });

  const finalState = await simulator.runToCompletion();

  assert.equal(finalState.status, 'complete');
  assert.deepEqual(finalState.rings.map((ring) => ring.completedGroupNumbers), [['11', '12'], ['13']]);
  assert.deepEqual(fixture.state.rings['ring-a-1'].completedGroupDivisionNumbers, ['11', '12']);
  assert.deepEqual(fixture.state.rings['ring-b-1'].completedGroupDivisionNumbers, ['13']);
  assert.equal(fixture.resultPacketStore.listSummaries().length, 3);
  for (const groupNumber of [11, 12, 13]) {
    const [record] = fixture.resultPacketStore.findByGroupId(String(groupNumber));
    assert.ok(record);
    assert.equal(record.packetBlock.simulation.runId, 'integration-run-1');
    assert.ok(fs.existsSync(path.join(fixture.resultsDirectory, `${record.serverRecordId}.json`)));
    if (groupNumber === 11) {
      assert.equal(record.packetBlock.disciplines.sparring.status, 'COMPLETED');
      assert.equal(record.packetBlock.disciplines.sparring.rounds.length, 2);
      assert.equal(record.packetBlock.disciplines.sparring.rounds[1].bouts.length, 1);
      assert.equal(record.packetBlock.disciplines.sparring.awards.length, 4);
    }
  }
  assert.equal(fs.readdirSync(fixture.resultsDirectory).length, 3);
});

test('completes an empty ring assignment without creating result records', async (t) => {
  const rings = [{ ringId: 'ring-a-1', ringLabel: 'A1', groupDivisionNumbers: [] }];
  const fixture = await createFixture(t, rings, {});

  const finalState = await fixture.makeSimulator({ runId: 'empty-run' }).runToCompletion();

  assert.equal(finalState.status, 'complete');
  assert.equal(finalState.rings[0].state, 'complete');
  assert.deepEqual(finalState.rings[0].completedGroupNumbers, []);
  assert.deepEqual(fixture.resultPacketStore.listSummaries(), []);
  assert.deepEqual(fixture.state.rings['ring-a-1'].queuedGroupDivisionNumbers, []);
});

test('resets isolated ring state after an ambiguous queue failure and retries successfully', async (t) => {
  const rings = [{ ringId: 'ring-a-1', ringLabel: 'A1', groupDivisionNumbers: [21] }];
  const groups = {
    21: { groupDivisionNumber: 21, name: 'Division 21', competitors: [] }
  };
  const fixture = await createFixture(t, rings, groups);
  const failedRun = fixture.makeSimulator({
    runId: 'retry-run-1',
    failAfterQueueRing: 'ring-a-1'
  });

  const failedState = await failedRun.runToCompletion();
  assert.equal(failedState.status, 'failed');
  assert.match(failedState.errors[0].message, /disconnect after queue acceptance/);
  assert.deepEqual(fixture.state.rings['ring-a-1'].queuedGroupDivisionNumbers, ['21']);

  const reset = await requestJson(
    fixture.server,
    'POST',
    '/api/rings/ring-a-1/reset',
    {}
  );
  assert.equal(reset.status, 200);
  assert.deepEqual(fixture.state.rings['ring-a-1'].queuedGroupDivisionNumbers, []);
  assert.deepEqual(fixture.state.rings['ring-a-1'].completedGroupDivisionNumbers, []);

  const retryState = await fixture.makeSimulator({ runId: 'retry-run-2' }).runToCompletion();
  assert.equal(retryState.status, 'complete');
  assert.deepEqual(retryState.rings[0].completedGroupNumbers, ['21']);
  assert.equal(fixture.resultPacketStore.listSummaries().length, 1);
  assert.equal(fixture.resultPacketStore.findByGroupId('21')[0].packetBlock.simulation.runId, 'retry-run-2');
});
