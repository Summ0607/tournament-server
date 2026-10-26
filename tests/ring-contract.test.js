const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');

const { createRingRouter } = require('../backend/ringRoutes');
const { createResultPacketStore } = require('../backend/resultPacket');
const {
  readAssignmentsState,
  writeAssignmentsState,
  normalizeRingState,
  buildRingResponse
} = require('../modules/ring-status/status.service');

function makeRingState(overrides) {
  return Object.assign({
    ringLabel: 'A1',
    groupDivisionNumber: '',
    queuedGroupDivisionNumbers: [],
    completedGroupDivisionNumbers: [],
    currentGroupId: '',
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
  }, overrides || {});
}

function createPacket(groupDivisionNumber) {
  const iso = new Date().toISOString();
  return {
    schemaVersion: 1,
    submissionId: '22a5d4b5-659a-4859-8664-52fd4016c985',
    eventName: 'InHouse_Tourn_2027',
    groupId: String(groupDivisionNumber),
    groupDivisionNumber: null,
    groupName: 'Male G10 - G6 · Ages 6-7',
    ringId: 'ring-a-1',
    ringLabel: 'A1',
    completedAt: iso,
    participants: [],
    disciplines: {
      weapons: { status: 'NOT_HELD', judgeCount: 0, results: [] },
      hyungs: { status: 'NOT_HELD', judgeCount: 0, results: [] },
      sparring: { status: 'NOT_HELD', bracketSize: 0, awards: [], rounds: [] }
    },
    overallAwards: { weapons: [], hyungs: [], sparring: [] },
    signatures: [],
    source: {
      client: 'TournamentScoringApp',
      appVersionName: '1.0.0',
      appVersionCode: 1,
      tabletLabel: 'Tablet-1',
      createdAt: iso
    }
  };
}

function createCompletionSnapshot() {
  return {
    checkInCount: 8,
    checkInTotal: 10,
    phaseCompletedCount: 4,
    phaseTotalCount: 5,
    phaseProgress: 80,
    assistanceType: 'tablet',
    assistanceRequestedAt: '2026-10-04T13:12:50.625-04:00',
    ringElapsed: '12:34',
    ringEstimated: '15:00',
    ringPacePercent: 15,
    phaseHistory: [
      {
        name: 'setup',
        startTime: '2026-10-04T13:00:00.000-04:00',
        endTime: '2026-10-04T13:05:00.000-04:00',
        elapsed: '5:00',
        estimated: '7:00'
      }
    ],
    transientUiState: 'discard-me'
  };
}

function legacyQueueAliasKey() {
  return ['queue', 'GroupDivisionNumbers'].join('');
}

function requestJson(server, method, pathName, body) {
  const payload = body ? JSON.stringify(body) : '';
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: pathName,
      method,
      headers: body ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      } : {}
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let parsed = null;
        if (raw) {
          try {
            parsed = JSON.parse(raw);
          } catch (error) {
            reject(new Error(`Invalid JSON response for ${method} ${pathName}: ${raw}`));
            return;
          }
        }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const assignmentsPath = path.join(__dirname, '..', 'ring-assignments.json');
  const activeEventPath = path.join(__dirname, '..', 'events', 'active.json');
  const originalAssignments = fs.existsSync(assignmentsPath)
    ? fs.readFileSync(assignmentsPath, 'utf8')
    : null;
  const originalActiveEvent = fs.existsSync(activeEventPath)
    ? fs.readFileSync(activeEventPath, 'utf8')
    : null;

  try {
    if (fs.existsSync(activeEventPath)) {
      fs.unlinkSync(activeEventPath);
    }

    const legacyFileState = {
      config: { letterCount: 1, numberCount: 1 },
      eventStartedAt: '',
      rings: {
        'ring-a-1': {
          ringLabel: 'A1',
          currentGroupId: '22',
          [legacyQueueAliasKey()]: ['99'],
          queuedGroupIds: ['23'],
          completedGroupIds: ['21']
        }
      }
    };
    fs.writeFileSync(assignmentsPath, JSON.stringify(legacyFileState, null, 2));
    const parsedState = readAssignmentsState();
    assert.strictEqual(parsedState.rings['ring-a-1'].groupDivisionNumber, '22');
    assert.deepStrictEqual(parsedState.rings['ring-a-1'].queuedGroupDivisionNumbers, ['23']);
    assert.deepStrictEqual(parsedState.rings['ring-a-1'].completedGroupDivisionNumbers, ['21']);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(parsedState.rings['ring-a-1'], legacyQueueAliasKey()), false);

    writeAssignmentsState({
      config: { letterCount: 1, numberCount: 1 },
      eventStartedAt: '',
      rings: {
        'ring-a-1': makeRingState({
          groupDivisionNumber: '22',
          currentGroupId: '22',
          currentGroupDivisionNumber: '22',
          queuedGroupDivisionNumbers: ['23'],
          queuedGroupIds: ['23'],
          completedGroupDivisionNumbers: ['21'],
          completedGroupIds: ['21'],
          phaseHistory: [
            {
              name: 'setup',
              startTime: '2026-10-04T13:00:00.000-04:00',
              endTime: '2026-10-04T13:05:00.000-04:00',
              elapsed: '5:00',
              estimated: '7:00'
            }
          ]
        })
      }
    });
    const persistedState = JSON.parse(fs.readFileSync(assignmentsPath, 'utf8'));
    const persistedRing = persistedState.rings['ring-a-1'];
    assert.strictEqual(Object.prototype.hasOwnProperty.call(persistedRing, 'currentGroupId'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(persistedRing, 'currentGroupDivisionNumber'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(persistedRing, legacyQueueAliasKey()), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(persistedRing, 'queuedGroupIds'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(persistedRing, 'completedGroupIds'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(persistedRing, 'phaseHistory'), false);
    assert.deepStrictEqual(persistedRing.queuedGroupDivisionNumbers, ['23']);
    assert.deepStrictEqual(persistedRing.completedGroupDivisionNumbers, ['21']);
  } finally {
    if (originalAssignments == null) {
      if (fs.existsSync(assignmentsPath)) fs.unlinkSync(assignmentsPath);
    } else {
      fs.writeFileSync(assignmentsPath, originalAssignments);
    }

    if (originalActiveEvent == null) {
      if (fs.existsSync(activeEventPath)) fs.unlinkSync(activeEventPath);
    } else {
      fs.writeFileSync(activeEventPath, originalActiveEvent);
    }
  }

  const legacyState = makeRingState({
    groupDivisionNumber: '',
    currentGroupId: '22',
    queuedGroupDivisionNumbers: [],
    [legacyQueueAliasKey()]: ['99'],
    queuedGroupIds: ['23'],
    completedGroupIds: ['21']
  });

  const normalized = normalizeRingState(legacyState, 'A1');
  assert.strictEqual(normalized.groupDivisionNumber, '22');
  assert.deepStrictEqual(normalized.queuedGroupDivisionNumbers, ['23']);
  assert.deepStrictEqual(normalized.completedGroupDivisionNumbers, ['21']);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(normalized, legacyQueueAliasKey()), false);

  const buildReq = {
    protocol: 'http',
    get: (name) => (name === 'host' ? 'localhost:3000' : '')
  };
  const ringResponse = buildRingResponse(buildReq, 'ring-a-1', normalized, { eventStartedAt: '' });
  assert.strictEqual(ringResponse.groupDivisionNumber, '22');
  assert.deepStrictEqual(ringResponse.queuedGroupDivisionNumbers, ['23']);
  assert.deepStrictEqual(ringResponse.completedGroupDivisionNumbers, ['21']);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(ringResponse, 'currentGroupId'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(ringResponse, 'currentGroupDivisionNumber'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(ringResponse, legacyQueueAliasKey()), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(ringResponse, 'queuedGroupIds'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(ringResponse, 'completedGroupIds'), false);

  const resultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'result-packet-contract-'));
  try {
    const resultPacketStore = createResultPacketStore({ getResultsDirectory: () => resultsRoot });
    const persistedPacket = createPacket('22');
    persistedPacket.completionSnapshot = createCompletionSnapshot();
    persistedPacket.packetBlock = {
      schemaVersion: 1,
      eventName: 'InHouse_Tourn_2027',
      groupId: '22',
      groupDivisionNumber: null,
      groupName: 'Male G10 - G6 · Ages 6-7',
      ringId: 'ring-a-1',
      ringLabel: 'A1',
      completedAt: persistedPacket.completedAt,
      participants: persistedPacket.participants,
      disciplines: persistedPacket.disciplines,
      overallAwards: persistedPacket.overallAwards,
      signatures: persistedPacket.signatures,
      source: persistedPacket.source,
      transientPostTransitionState: 'discard-me'
    };

    assert.deepStrictEqual(
      resultPacketStore.validate(persistedPacket, 'ring-a-1', 'InHouse_Tourn_2027'),
      []
    );

    const storedRecord = resultPacketStore.store(persistedPacket, {
      receivedAt: '2026-10-04T13:12:51.000-04:00',
      acknowledgement: {}
    });
    const persistedFile = JSON.parse(fs.readFileSync(storedRecord.filePath, 'utf8'));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(persistedFile, 'packet'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(persistedFile, 'receipt'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(persistedFile, 'phaseHistory'), false);
    assert.deepStrictEqual(
      Object.keys(persistedFile.completionSnapshot).sort(),
      [
        'assistanceRequestedAt',
        'assistanceType',
        'checkInCount',
        'checkInTotal',
        'phaseCompletedCount',
        'phaseHistory',
        'phaseProgress',
        'phaseTotalCount',
        'ringElapsed',
        'ringEstimated',
        'ringPacePercent'
      ].sort()
    );
    assert.strictEqual(persistedFile.completionSnapshot.transientUiState, undefined);
    assert.strictEqual(persistedFile.packetBlock.transientPostTransitionState, undefined);
  } finally {
    fs.rmSync(resultsRoot, { recursive: true, force: true });
  }

  const state = {
    eventStartedAt: '',
    rings: {
      'ring-a-1': makeRingState()
    }
  };

  const app = express();
  app.use(express.json());
  const previewGroups = new Map();

  const router = createRingRouter({
    readAssignmentsState: () => state,
    writeAssignmentsState: () => {},
    applyHeartbeatPolicy: () => false,
    setRingConfig: () => {},
    getRingState: (currentState, ringId) => currentState.rings[ringId],
    listAllowedRingLabels: () => ['A1'],
    buildRingResponse,
    touchHeartbeat: () => {},
    setRingPhase: (ringState, phase) => { ringState.phase = phase; },
    resetRingToScratch: (ringState) => {
      ringState.groupDivisionNumber = '';
      ringState.queuedGroupDivisionNumbers = [];
      ringState.completedGroupDivisionNumbers = [];
      ringState.currentGroupId = '';
      ringState.queuedGroupIds = [];
      ringState.completedGroupIds = [];
      ringState.assignmentStartedAt = '';
      ringState.checkInCount = 0;
      ringState.checkInTotal = 0;
      ringState.phaseCompletedCount = 0;
      ringState.phaseTotalCount = 0;
      ringState.phaseProgress = 0;
      ringState.phase = 'idle';
    },
    resetAssignments: () => {},
    groupExists: () => true,
    findGroupUsageAcrossRings: () => null,
    loadGroup: (id) => previewGroups.get(String(id)) || null,
    loadGroups: () => ([
      { groupDivisionNumber: '21', name: 'Division 21' },
      { groupDivisionNumber: '22', name: 'Division 22' },
      { groupDivisionNumber: '23', name: 'Division 23' },
      { groupDivisionNumber: '24', name: 'Division 24' }
    ]),
    serverBaseUrlForRequest: () => 'http://127.0.0.1:0',
    DISCONNECT_AFTER_MS: 90000,
    saveUploadedDivisionPacket: () => {},
    resultPacketStore: {
      validate: () => [],
      store: () => ({ serverRecordId: 'result-test', filePath: 'result-test.json' }),
      findBySubmissionId: () => null,
      findByGroupId: () => []
    },
    readActiveEvent: () => 'InHouse_Tourn_2027'
  });

  app.use('/api', router);

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });

  try {
    for (const [method, pathname, body] of [
      ['GET', '/api/rings', null],
      ['POST', '/api/rings/ring-a-1/queue', { groupDivisionNumber: '22' }],
      ['DELETE', '/api/rings/ring-a-1/queue/22', null],
      ['POST', '/api/rings/ring-a-1/reset', {}],
      ['POST', '/api/rings/ring-a-1/assistance/clear', {}],
      ['POST', '/api/rings/config', { letterCount: 2, numberCount: 3 }]
    ]) {
      const rejected = await requestJson(server, method, `${pathname}?eventName=OldEvent`, body);
      assert.strictEqual(rejected.status, 409);
      assert.match(rejected.body.error, /active event changed/);
      assert.deepStrictEqual(state.rings['ring-a-1'].queuedGroupDivisionNumbers, []);
    }
    const scopedRings = await requestJson(server, 'GET', '/api/rings?eventName=InHouse_Tourn_2027');
    assert.strictEqual(scopedRings.status, 200);

    state.rings['ring-a-1'].assistanceType = 'medical';
    state.rings['ring-a-1'].assistanceRequestedAt = '2026-10-25T15:00:00.000Z';
    const staleClear = await requestJson(server, 'POST', '/api/rings/ring-a-1/assistance/clear?eventName=InHouse_Tourn_2027', {
      expectedAssistanceRequestedAt: 'older-request'
    });
    assert.strictEqual(staleClear.status, 409);
    assert.strictEqual(state.rings['ring-a-1'].assistanceType, 'medical');
    const clear = await requestJson(server, 'POST', '/api/rings/ring-a-1/assistance/clear?eventName=InHouse_Tourn_2027', {
      expectedAssistanceRequestedAt: '2026-10-25T15:00:00.000Z'
    });
    assert.strictEqual(clear.status, 200);
    assert.strictEqual(state.rings['ring-a-1'].assistanceType, '');

    const queueResponse = await requestJson(server, 'POST', '/api/rings/ring-a-1/queue', { groupId: '22' });
    assert.strictEqual(queueResponse.status, 200);
    assert.strictEqual(queueResponse.body.groupDivisionNumber, '');
    assert.deepStrictEqual(queueResponse.body.queuedGroupDivisionNumbers, ['22']);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(queueResponse.body, legacyQueueAliasKey()), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(queueResponse.body, 'queuedGroupIds'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(queueResponse.body, 'currentGroupId'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(queueResponse.body, 'currentGroupDivisionNumber'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(queueResponse.body, 'completedGroupIds'), false);

    state.rings['ring-a-2'] = makeRingState({
      ringLabel: 'A2',
      groupDivisionNumber: '21',
      currentGroupId: '21',
      currentGroupDivisionNumber: '21'
    });
    state.rings['ring-a-3'] = makeRingState({
      ringLabel: 'A3',
      queuedGroupDivisionNumbers: ['23'],
      queuedGroupIds: ['23']
    });

    previewGroups.set('22', { competitors: [{ weaponsEligible: true }] });
    previewGroups.set('23', { competitors: [{ weaponsEligible: false }] });
    const ringsResponse = await requestJson(server, 'GET', '/api/rings');
    assert.strictEqual(ringsResponse.status, 200);
    assert.deepStrictEqual(ringsResponse.body.availableGroupDivisionNumbers, ['24']);
    const previewA1 = ringsResponse.body.rings.find((ring) => ring.ringId === 'ring-a-1').queuedPhasePlan;
    const previewA3 = ringsResponse.body.rings.find((ring) => ring.ringId === 'ring-a-3').queuedPhasePlan;
    assert.strictEqual(previewA1.groupDivisionNumber, '22');
    assert.deepStrictEqual(previewA1.phases.map((phase) => phase.key), ['setup', 'weapons', 'hyungs', 'sparring', 'awards']);
    assert.deepStrictEqual(previewA3.phases.map((phase) => phase.key), ['setup', 'hyungs', 'sparring', 'awards']);
    assert.strictEqual(ringsResponse.body.rings.find((ring) => ring.ringId === 'ring-a-2').queuedPhasePlan, null);
    previewGroups.clear();

    state.rings['ring-a-1'] = makeRingState({
      groupDivisionNumber: '22',
      currentGroupId: '22',
      currentGroupDivisionNumber: '22',
      queuedGroupDivisionNumbers: ['23'],
      [legacyQueueAliasKey()]: ['99'],
      queuedGroupIds: ['23'],
      completedGroupDivisionNumbers: [],
      completedGroupIds: []
    });

    const completionPacket = createPacket('22');
    completionPacket.completionSnapshot = createCompletionSnapshot();
    const completeResponse = await requestJson(server, 'POST', '/api/rings/ring-a-1/complete', completionPacket);
    assert.strictEqual(completeResponse.status, 200);
    assert.ok(completeResponse.body.ringAssignment);
    assert.strictEqual(completeResponse.body.ringAssignment.groupDivisionNumber, '23');
    assert.deepStrictEqual(completeResponse.body.ringAssignment.queuedGroupDivisionNumbers, []);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(completeResponse.body.ringAssignment, 'currentGroupId'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(completeResponse.body.ringAssignment, 'currentGroupDivisionNumber'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(completeResponse.body.ringAssignment, legacyQueueAliasKey()), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(completeResponse.body.ringAssignment, 'queuedGroupIds'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(completeResponse.body.ringAssignment, 'completedGroupIds'), false);

    assert.strictEqual(state.eventStartedAt, '', 'completion without a named tablet does not start the event');
    state.rings['ring-a-1'] = makeRingState({ queuedGroupDivisionNumbers: ['24'], queuedGroupIds: ['24'] });
    const bareHeartbeat = await requestJson(server, 'POST', '/api/rings/ring-a-1/heartbeat', { phase: 'check-in' });
    assert.strictEqual(bareHeartbeat.status, 200);
    assert.strictEqual(state.eventStartedAt, '', 'heartbeat without a tablet name does not start the event');
    const tabletHeartbeat = await requestJson(server, 'POST', '/api/rings/ring-a-1/heartbeat', { tabletLabel: 'Tablet-1' });
    assert.strictEqual(tabletHeartbeat.status, 200);
    assert.ok(Number.isFinite(Date.parse(state.eventStartedAt)), 'a named tablet starts the event');
    const started = state.eventStartedAt;
    await requestJson(server, 'POST', '/api/rings/ring-a-1/heartbeat', { tabletLabel: 'Tablet-1' });
    assert.strictEqual(state.eventStartedAt, started, 'later activity never moves the start');

    const groupServer = fs.readFileSync(path.join(__dirname, '..', 'group-server.js'), 'utf8');
    assert.doesNotMatch(groupServer, /inferredStart/, 'start is never inferred from stale heartbeat or phase timestamps');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().then(() => {
  console.log('ring contract tests passed');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
