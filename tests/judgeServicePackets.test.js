const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const sqlite3 = require('sqlite3');
const { initializeJudgeDatabase } = require('../db/judgeManagement');
const { createJudgeServicePacketStore } = require('../backend/judgeServicePacket');
const { createJudgeManagementRouter } = require('../backend/judgeManagementRoutes');
const { createRingRouter } = require('../backend/ringRoutes');
const { apiRoles, isTabletEndpoint } = require('../backend/browserPermissions');

const packet = (submissionId = '123e4567-e89b-12d3-a456-426614174000') => ({
  type: 'tournament-judge-service',
  schemaVersion: 1,
  submissionId,
  ringId: 'ring-a-1',
  phase: 'P1',
  divisions: [{
    groupAnchor: '20',
    seats: { center: [{ associationId: 'ID2', name: 'New Center', rank: 'D4' }] },
    history: [
      { at: '2026-01-15T09:00:00.000Z', action: 'SEATED', role: 'center', judgeAssociationId: 'ID1', previousJudgeAssociationId: null },
      { at: '2026-01-15T10:00:00.000Z', action: 'REPLACED', role: 'center', judgeAssociationId: 'ID2', previousJudgeAssociationId: 'ID1' },
      { at: '2026-01-15T11:00:00.000Z', action: 'SWAPPED', role: 'corner', judgeAssociationId: 'ID2', previousJudgeAssociationId: 'center' }
    ]
  }]
});

function listen(app, t) {
  const server = app.listen(0, '127.0.0.1');
  return new Promise((resolve) => {
    server.once('listening', () => {
      t.after(() => new Promise((done) => server.close(done)));
      resolve(`http://127.0.0.1:${server.address().port}/api`);
    });
  });
}

test('service packet storage acknowledges exact retries and rejects conflicting ring-phase packets', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-service-packets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createJudgeServicePacketStore({ root, now: () => '2026-01-15T12:00:00.000Z' });
  const submitted = packet();
  const accepted = await store.accept('Event A', submitted, 'ring-a-1', {
    date: '2026-01-15', scope: 'REGIONAL', location: 'Venue'
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.duplicate, false);
  const replay = await store.accept('Event A', submitted, 'ring-a-1', {
    date: '2026-01-15', scope: 'REGIONAL', location: 'Venue'
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.serverRecordId, accepted.serverRecordId);
  const changed = structuredClone(submitted);
  changed.divisions[0].seats.center[0].associationId = 'ID3';
  await assert.rejects(store.accept('Event A', changed, 'ring-a-1', {
    date: '2026-01-15', scope: 'REGIONAL', location: 'Venue'
  }), /submissionId was already used for a different service packet/);
  await assert.rejects(store.accept('Event A', submitted, 'ring-a-2', {
    date: '2026-01-15', scope: 'REGIONAL', location: 'Venue'
  }), /ring does not match|P1 or P2/);
  await assert.rejects(store.accept('Event A', packet('223e4567-e89b-12d3-a456-426614174000'), 'ring-a-1', {
    date: '2026-01-15', scope: 'REGIONAL', location: 'Venue'
  }), /already been received/);
  assert.equal(store.list('Event A').length, 1);
});

test('service packet storage retains replacement PIN verification and coordinator review evidence', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-service-replacement-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createJudgeServicePacketStore({ root });
  const submitted = packet();
  Object.assign(submitted.divisions[0].history[1], {
    assignmentRevision: 'assignment-revision-1',
    replacementPinVerified: true,
    requiresCoordinatorReview: true
  });
  await store.accept('Event A', submitted, 'ring-a-1', {
    date: '2026-01-15', scope: 'REGIONAL', location: ''
  });
  const stored = store.get('Event A', submitted.submissionId);
  assert.deepEqual(stored.packet.divisions[0].history[1], {
    at: '2026-01-15T10:00:00.000Z',
    action: 'REPLACED',
    role: 'center',
    judgeAssociationId: 'ID2',
    previousJudgeAssociationId: 'ID1',
    assignmentRevision: 'assignment-revision-1',
    replacementPinVerified: true,
    requiresCoordinatorReview: true
  });

  const invalid = packet('323e4567-e89b-12d3-a456-426614174000');
  Object.assign(invalid.divisions[0].history[1], {
    assignmentRevision: 'assignment-revision-1',
    replacementPinVerified: false,
    requiresCoordinatorReview: true
  });
  await assert.rejects(store.accept('Event A', invalid, 'ring-a-1', {
    date: '2026-01-15', scope: 'REGIONAL', location: ''
  }), /verified event PIN/);
});

test('flagged replacement review decisions persist, require affected-party review and lock after import', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-service-reconciliation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createJudgeServicePacketStore({ root });
  const submitted = packet('623e4567-e89b-12d3-a456-426614174000');
  Object.assign(submitted.divisions[0].history[1], {
    assignmentRevision: 'assignment-revision-1',
    replacementPinVerified: true,
    requiresCoordinatorReview: true
  });
  await store.accept('Event A', submitted, 'ring-a-1', {
    date: '2026-01-15', scope: 'REGIONAL', location: ''
  });
  const replacement = store.get('Event A', submitted.submissionId).replacementReviews[0];
  assert.equal(replacement.incomingAssociationId, 'ID2');
  assert.equal(replacement.outgoingAssociationId, 'ID1');
  await assert.rejects(store.markImported('Event A', submitted.submissionId), /Review every flagged replacement/);
  await assert.rejects(store.saveReplacementReviews('Event A', submitted.submissionId, [{
    replacementId: replacement.replacementId,
    decision: 'APPROVED',
    reviewedWithAffectedParties: false
  }]), /Confirm that the replacement was reviewed/);
  const reviews = await store.saveReplacementReviews('Event A', submitted.submissionId, [{
    replacementId: replacement.replacementId,
    decision: 'REJECTED',
    reviewedWithAffectedParties: true
  }]);
  assert.equal(reviews[0].decision, 'REJECTED');
  const reopened = createJudgeServicePacketStore({ root }).get('Event A', submitted.submissionId);
  assert.equal(reopened.replacementReviews[0].decision, 'REJECTED');
  assert.equal(reopened.replacementReviews[0].reviewedWithAffectedParties, true);
  await store.markImported('Event A', submitted.submissionId);
  await assert.rejects(store.saveReplacementReviews('Event A', submitted.submissionId, reviews),
    /cannot be changed after service import/);
});

test('tablet service intake persists, replays acknowledgements and binds ring authorization scope', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-service-route-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createJudgeServicePacketStore({ root: path.join(root, 'packets') });
  const state = { rings: { 'ring-a-1': {} } };
  const app = express();
  app.use(express.json());
  app.use('/api', createRingRouter({
    readAssignmentsState: () => state,
    getRingState: (current, ringId) => current.rings[ringId],
    listAllowedRingLabels: () => ['ring-a-1'],
    readActiveEvent: () => 'Event A',
    readEventConfig: () => ({ date: '2026-01-15', scope: 'regional', location: 'Venue' }),
    servicePacketStore: store
  }));
  const base = await listen(app, t);
  const post = () => fetch(`${base}/rings/ring-a-1/service-packets`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(packet())
  });
  const first = await post();
  assert.equal(first.status, 200);
  const receipt = await first.json();
  assert.equal(receipt.accepted, true);
  const replay = await post();
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).serverRecordId, receipt.serverRecordId);
  assert.equal(apiRoles('POST', '/api/rings/ring-a-1/service-packets').includes('tournament-operator'), true);
  assert.equal(isTabletEndpoint('POST', '/api/rings/ring-a-1/service-packets'), true);
  assert.equal(isTabletEndpoint('POST', '/api/rings/ring-a-2/service-packets'), true);
});

test('coordinator USB intake validates the active event and returns a duplicate-safe receipt', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-service-usb-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const judgeFile = path.join(root, 'judges.db');
  await initializeJudgeDatabase(judgeFile);
  const store = createJudgeServicePacketStore({ root: path.join(root, 'packets') });
  let activeEvent = 'Event A';
  const app = express();
  app.use(express.json());
  app.use('/api', createJudgeManagementRouter({
    file: judgeFile,
    servicePacketStore: store,
    readActiveEvent: () => activeEvent,
    readEventConfig: () => ({ date: '2026-01-15', scope: 'regional', location: 'Venue' }),
    isKnownRing: (ringId) => ringId === 'ring-a-1'
  }));
  const base = await listen(app, t);
  const envelope = {
    type: 'tournament-judge-service-transfer',
    schemaVersion: 1,
    eventName: 'Event A',
    packet: packet()
  };
  const post = (body) => fetch(`${base}/judge-management/service-packets/usb`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const acceptedResponse = await post(envelope);
  assert.equal(acceptedResponse.status, 200);
  const accepted = await acceptedResponse.json();
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.eventName, 'Event A');
  assert.equal(accepted.type, 'tournament-judge-service-receipt');
  const retryResponse = await post(envelope);
  assert.equal((await retryResponse.json()).serverRecordId, accepted.serverRecordId);
  assert.equal((await post({ ...envelope, eventName: 'Other Event' })).status, 409);
  assert.equal((await post({
    ...envelope,
    packet: { ...envelope.packet, ringId: 'ring-a-2' }
  })).status, 409);
  assert.deepEqual(apiRoles('POST', '/api/judge-management/service-packets/usb'),
    ['administrator', 'judging-coordinator']);
  activeEvent = '';
  assert.equal((await post(envelope)).status, 409);
});

test('coordinator intake creates unverified tournament experience from the full service timeline', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-service-intake-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const judgeFile = path.join(root, 'judges.db');
  await initializeJudgeDatabase(judgeFile);
  const db = new sqlite3.Database(judgeFile);
  await new Promise((resolve, reject) => db.run(`INSERT INTO judges
    (association_id,first_name,last_name,rank,certification,status)
    VALUES ('ID1','Outgoing','Judge','D2','CORNER','Active'),
      ('ID2','Incoming','Judge','D4','REGIONAL','Active')`,
  (error) => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));

  const servicePacketStore = createJudgeServicePacketStore({ root: path.join(root, 'packets') });
  await servicePacketStore.accept('Event A', packet(), 'ring-a-1', {
    date: '2026-01-15', scope: 'REGIONAL', location: 'Venue'
  });
  const app = express();
  app.use(express.json());
  app.use('/api', createJudgeManagementRouter({
    file: judgeFile,
    currentDate: () => '2026-01-15',
    servicePacketStore
  }));
  const base = await listen(app, t);
  const request = async (endpoint, method = 'GET', body) => {
    const response = await fetch(`${base}${endpoint}`, {
      method,
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
    });
    return { status: response.status, data: await response.json() };
  };
  let state = await request('/judge-management');
  const packets = await request('/judge-management/service-packets');
  assert.equal(packets.data.packets.length, 1);
  const submissionId = packets.data.packets[0].submissionId;
  const imported = await request(`/judge-management/service-packets/${submissionId}/import`, 'POST', {
    revision: state.data.revision, eventName: 'Event A', confirmImport: true
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.data.added, 3);
  assert.ok(imported.data.experience.every((entry) => entry.source === 'TOURNAMENT' && entry.logVerified === 0));
  assert.deepEqual(imported.data.experience.map((entry) => entry.role).sort(),
    ['CENTER_JUDGE', 'CENTER_JUDGE', 'CORNER_JUDGE']);
  assert.ok(imported.data.experience.every((entry) => entry.phase === 'P1'));
  state = imported;

  const retry = await request(`/judge-management/service-packets/${submissionId}/import`, 'POST', {
    revision: state.data.revision, eventName: 'Event A', confirmImport: true
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.alreadyImported, true);
  assert.equal(retry.data.experience.length, 3);
  assert.deepEqual(apiRoles('POST', `/api/judge-management/service-packets/${submissionId}/import`),
    ['administrator', 'judging-coordinator']);
});

test('coordinator replacement reconciliation gates import and can reject replacement credit', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-service-replacement-review-route-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const judgeFile = path.join(root, 'judges.db');
  await initializeJudgeDatabase(judgeFile);
  const db = new sqlite3.Database(judgeFile);
  await new Promise((resolve, reject) => db.run(`INSERT INTO judges
    (association_id,first_name,last_name,rank,certification,status)
    VALUES ('ID1','Outgoing','Judge','D2','CORNER','Active'),
      ('ID2','Incoming','Judge','D4','REGIONAL','Active')`,
  (error) => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));

  const servicePacketStore = createJudgeServicePacketStore({ root: path.join(root, 'packets') });
  const flagged = packet('723e4567-e89b-12d3-a456-426614174000');
  Object.assign(flagged.divisions[0].history[1], {
    assignmentRevision: 'assignment-revision-1',
    replacementPinVerified: true,
    requiresCoordinatorReview: true
  });
  await servicePacketStore.accept('Event A', flagged, 'ring-a-1', {
    date: '2026-01-15', scope: 'REGIONAL', location: 'Venue'
  });
  const app = express(); app.use(express.json());
  app.use('/api', createJudgeManagementRouter({
    file: judgeFile,
    currentDate: () => '2026-01-15',
    servicePacketStore
  }));
  const base = await listen(app, t);
  const request = async (endpoint, method = 'GET', body) => {
    const response = await fetch(`${base}${endpoint}`, {
      method,
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
    });
    return { status: response.status, data: await response.json() };
  };
  let state = await request('/judge-management');
  const intake = await request('/judge-management/service-packets');
  const replacement = intake.data.packets[0].replacementReviews[0];
  assert.equal(replacement.decision, undefined);
  const importPath = `/judge-management/service-packets/${flagged.submissionId}/import`;
  const unreviewed = await request(importPath, 'POST', {
    revision: state.data.revision, eventName: 'Event A', confirmImport: true
  });
  assert.equal(unreviewed.status, 409);
  assert.match(unreviewed.data.error, /affected parties/);

  const reviewPath = `/judge-management/service-packets/${flagged.submissionId}/replacement-reviews`;
  const saved = await request(reviewPath, 'PUT', {
    revision: state.data.revision,
    eventName: 'Event A',
    reviews: [{
      replacementId: replacement.replacementId,
      decision: 'REJECTED',
      reviewedWithAffectedParties: true
    }]
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.replacementReviews[0].decision, 'REJECTED');
  state = saved;

  const imported = await request(importPath, 'POST', {
    revision: state.data.revision, eventName: 'Event A', confirmImport: true
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.data.added, 1);
  assert.equal(imported.data.rejectedReplacements, 1);
  const outgoingJudgeId = state.data.judges.find((judge) => judge.associationId === 'ID1').id;
  assert.deepEqual(imported.data.experience.map((entry) => entry.judgeId), [outgoingJudgeId]);
  assert.deepEqual(imported.data.experience.map((entry) => entry.role), ['CENTER_JUDGE']);
  assert.equal(apiRoles('PUT', `/api${reviewPath}`)?.includes('judging-coordinator'), true);
});

test('a Center/Corner swap credits both judges with Center service only', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-service-role-swap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const judgeFile = path.join(root, 'judges.db');
  await initializeJudgeDatabase(judgeFile);
  const db = new sqlite3.Database(judgeFile);
  await new Promise((resolve, reject) => db.run(`INSERT INTO judges
    (association_id,first_name,last_name,rank,certification,status)
    VALUES ('ID1','Center','Judge','D5','REGIONAL','Active'),
      ('ID2','Corner','Judge','D4','REGIONAL','Active')`,
  (error) => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));

  const servicePacketStore = createJudgeServicePacketStore({ root: path.join(root, 'packets') });
  const swapped = packet('423e4567-e89b-12d3-a456-426614174000');
  swapped.divisions[0].seats = {
    center: [{ associationId: 'ID2', name: 'Corner Judge', rank: 'D4' }],
    corner: [{ associationId: 'ID1', name: 'Center Judge', rank: 'D5' }]
  };
  swapped.divisions[0].history = [{
    at: '2026-01-15T11:00:00.000Z',
    action: 'SWAPPED',
    role: 'center',
    judgeAssociationId: 'ID2',
    previousJudgeAssociationId: 'corner',
    swapPartnerAssociationId: 'ID1',
    otherRole: 'corner',
    creditedRole: 'center'
  }];
  const invalidSwap = structuredClone(swapped);
  invalidSwap.submissionId = '523e4567-e89b-12d3-a456-426614174000';
  invalidSwap.divisions[0].history[0].creditedRole = 'corner';
  await assert.rejects(servicePacketStore.accept('Event A', invalidSwap, 'ring-a-1', {
    date: '2026-01-15', scope: 'REGIONAL', location: 'Venue'
  }), /award Center service only/);
  await servicePacketStore.accept('Event A', swapped, 'ring-a-1', {
    date: '2026-01-15', scope: 'REGIONAL', location: 'Venue'
  });

  const app = express(); app.use(express.json());
  app.use('/api', createJudgeManagementRouter({
    file: judgeFile,
    currentDate: () => '2026-01-15',
    servicePacketStore
  }));
  const base = await listen(app, t);
  const state = await fetch(`${base}/judge-management`).then((response) => response.json());
  const importedResponse = await fetch(
    `${base}/judge-management/service-packets/${swapped.submissionId}/import`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: state.revision, eventName: 'Event A', confirmImport: true })
    }
  );
  assert.equal(importedResponse.status, 200);
  const imported = await importedResponse.json();
  assert.equal(imported.added, 2);
  assert.deepEqual(imported.experience.map((entry) => entry.role), ['CENTER_JUDGE', 'CENTER_JUDGE']);
  assert.ok(imported.experience.every((entry) => entry.logVerified === 0));
});

test('legacy combined SK/TK service requires an explicit actual role during coordinator intake', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-service-sktk-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const judgeFile = path.join(root, 'judges.db');
  await initializeJudgeDatabase(judgeFile);
  const db = new sqlite3.Database(judgeFile);
  await new Promise((resolve, reject) => db.run(`INSERT INTO judges
    (association_id,first_name,last_name,rank,certification,status)
    VALUES ('ID1','Score','Judge','D1','SK_TK','Active')`,
  (error) => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  const servicePacketStore = createJudgeServicePacketStore({ root: path.join(root, 'packets') });
  const legacy = packet();
  legacy.divisions[0].seats = { sktk: [{ associationId: 'ID1', name: 'Score Judge', rank: 'D1' }] };
  legacy.divisions[0].history = [{
    at: '2026-01-15T09:00:00.000Z', action: 'SEATED', role: 'sktk',
    judgeAssociationId: 'ID1', previousJudgeAssociationId: null
  }];
  await servicePacketStore.accept('Event A', legacy, 'ring-a-1', {
    date: '2026-01-15', scope: 'REGIONAL', location: ''
  });
  const app = express(); app.use(express.json());
  app.use('/api', createJudgeManagementRouter({ file: judgeFile, servicePacketStore, currentDate: () => '2026-01-15' }));
  const base = await listen(app, t);
  const request = async (body) => {
    const response = await fetch(`${base}/judge-management/service-packets/${legacy.submissionId}/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: response.status, data: await response.json() };
  };
  let state = await fetch(`${base}/judge-management`).then((response) => response.json());
  const missingRole = await request({ revision: state.revision, eventName: 'Event A', confirmImport: true });
  assert.equal(missingRole.status, 409);
  assert.match(missingRole.data.error, /Select SCOREKEEPER or TIMEKEEPER/);
  const imported = await request({ revision: state.revision, eventName: 'Event A',
    confirmImport: true, sktkRoles: { ID1: 'TIMEKEEPER' } });
  assert.equal(imported.status, 200);
  assert.equal(imported.data.experience[0].role, 'TIMEKEEPER');
  assert.equal(imported.data.experience[0].logVerified, 0);
});
