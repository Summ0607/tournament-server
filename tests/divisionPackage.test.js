const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const {
  DIVISION_PACKAGE_TYPE, DIVISION_QR_TYPE, DIVISION_PACKAGE_VERSION, MAX_TABLET_DIVISION_COMPETITORS,
  packageDivision, buildDivisionQrPayload, decodeDivisionQrPayload, createDivisionPackageRouter
} = require('../backend/divisionPackage');
const { apiRoles, isTabletEndpoint, pageView } = require('../backend/browserPermissions');

function savedCompetitor(id, overrides = {}) {
  return {
    id, firstName: `First${id}`, lastName: `Last${id}`, studio: "Vaughn's Dojang",
    rank: '7th Gup', age: 11, height: 56, email: 'parent@example.com', phone: '555-0100',
    associationNumber: `TSD-${id}`, groupDivisionNumber: 20, ...overrides
  };
}

function savedGroup(divisionNumber, competitorCount, overrides = {}) {
  return {
    groupId: `group-${divisionNumber}`, id: String(divisionNumber),
    name: `Youth 7th-6th Gup ${divisionNumber}`, groupDivisionNumber: divisionNumber,
    competitors: Array.from({ length: competitorCount }, (_, index) => savedCompetitor(divisionNumber * 100 + index)),
    ...overrides
  };
}

test('packaged divisions keep only tablet fields and never contact details', () => {
  const division = packageDivision(savedGroup(20, 3, { rankRange: { low: '7th Gup', high: '6th Gup' } }));
  assert.equal(division.groupId, 'group-20');
  assert.equal(division.groupDivisionNumber, 20);
  assert.equal(division.name, 'Youth 7th-6th Gup 20');
  assert.deepEqual(division.rankRange, { low: '7th Gup', high: '6th Gup' });
  assert.deepEqual(division.competitors[0], {
    id: '2000', name: 'First2000 Last2000', studio: "Vaughn's Dojang",
    rank: '7th Gup', age: 11, height: 56
  });
  assert.ok(!JSON.stringify(division).includes('example.com'));
  assert.ok(!JSON.stringify(division).includes('555-0100'));
});

test('divisions above the 12-competitor tablet cap or without competitors are rejected', () => {
  assert.throws(() => packageDivision(savedGroup(20, 13)), /Division 20 has 13 competitors.*at most 12/);
  assert.throws(() => packageDivision(savedGroup(21, 0)), /Division 21 has no competitors/);
  assert.equal(MAX_TABLET_DIVISION_COMPETITORS, 12);
});

test('division QR payloads round-trip and a full 12-competitor division fits one QR code', () => {
  const group = savedGroup(20, 12);
  const payload = buildDivisionQrPayload({ eventName: 'Winter Tournament 2027', group });
  assert.equal(payload.type, DIVISION_QR_TYPE);
  assert.equal(payload.version, DIVISION_PACKAGE_VERSION);
  // Version 40-M byte-mode QR capacity; staying below it guarantees a single printable code.
  assert.ok(JSON.stringify(payload).length <= 2331, `payload is ${JSON.stringify(payload).length} bytes`);
  const decoded = decodeDivisionQrPayload(payload);
  assert.equal(decoded.eventName, 'Winter Tournament 2027');
  assert.deepEqual(decoded.division, packageDivision(group));
});

test('tampered or foreign QR payloads are rejected with clear errors', () => {
  const payload = buildDivisionQrPayload({ eventName: 'Event', group: savedGroup(20, 2) });
  assert.throws(() => decodeDivisionQrPayload({ ...payload, checksum: 'f'.repeat(16) }), /integrity check/);
  assert.throws(() => decodeDivisionQrPayload({ ...payload, type: 'tournament-ring' }), /Not a tournament division QR/);
  assert.throws(() => decodeDivisionQrPayload({ ...payload, version: 2 }), /Unsupported division QR version/);
  assert.throws(() => decodeDivisionQrPayload({ ...payload, data: 'not-deflate' }), /decompressed/);
});

function startApp(t, deps) {
  const app = express();
  app.use(express.json());
  app.use('/api', createDivisionPackageRouter(deps));
  const server = app.listen(0, '127.0.0.1');
  return new Promise((resolve) => server.once('listening', () => {
    t.after(() => new Promise((done) => server.close(done)));
    resolve(`http://127.0.0.1:${server.address().port}`);
  }));
}

function ringDeps(groupsById, ringState) {
  return {
    readAssignmentsState: () => ({ rings: { 'ring-a-1': ringState } }),
    getRingState: (state, ringId) => state.rings[ringId] || null,
    listAllowedRingLabels: () => ['A1'],
    loadGroup: (anchor) => groupsById.get(String(anchor)) || null,
    loadSavedGroups: async () => Array.from(groupsById.values()),
    readActiveEvent: () => 'Winter Tournament 2027'
  };
}

test('ring division package returns current and queued divisions in order', async (t) => {
  const groups = new Map([['20', savedGroup(20, 4)], ['21', savedGroup(21, 5)], ['22', savedGroup(22, 6)]]);
  const base = await startApp(t, ringDeps(groups, {
    ringLabel: 'A1', currentGroupId: '20', queuedGroupDivisionNumbers: ['21', '22']
  }));
  const response = await fetch(`${base}/api/rings/ring-a-1/division-package`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.type, DIVISION_PACKAGE_TYPE);
  assert.equal(body.version, DIVISION_PACKAGE_VERSION);
  assert.equal(body.eventName, 'Winter Tournament 2027');
  assert.equal(body.ringId, 'ring-a-1');
  assert.equal(body.ringLabel, 'A1');
  assert.deepEqual(body.divisions.map((division) => division.groupDivisionNumber), [20, 21, 22]);
  assert.equal(body.divisions[0].competitors.length, 4);
});

test('ring division package rejects unknown rings, missing divisions, and oversize divisions', async (t) => {
  const missingBase = await startApp(t, ringDeps(new Map([['20', savedGroup(20, 4)]]), {
    ringLabel: 'A1', currentGroupId: '20', queuedGroupDivisionNumbers: ['21']
  }));
  const unknownRing = await fetch(`${missingBase}/api/rings/ring-z-9/division-package`);
  assert.equal(unknownRing.status, 400);
  assert.match((await unknownRing.json()).error, /Allowed rings: A1/);
  const missing = await fetch(`${missingBase}/api/rings/ring-a-1/division-package`);
  assert.equal(missing.status, 409);
  assert.match((await missing.json()).error, /not found: 21/);

  const oversizeBase = await startApp(t, ringDeps(new Map([['20', savedGroup(20, 13)]]), {
    ringLabel: 'A1', currentGroupId: '20', queuedGroupDivisionNumbers: []
  }));
  const oversize = await fetch(`${oversizeBase}/api/rings/ring-a-1/division-package`);
  assert.equal(oversize.status, 409);
  assert.match((await oversize.json()).error, /Division 20 has 13 competitors/);
});

test('division QR codes endpoint prints all or selected divisions and flags oversize ones', async (t) => {
  const groups = new Map([['20', savedGroup(20, 4)], ['21', savedGroup(21, 13)]]);
  const base = await startApp(t, ringDeps(groups, {}));
  const all = await fetch(`${base}/api/divisions/qr-codes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
  });
  assert.equal(all.status, 200);
  const allBody = await all.json();
  assert.equal(allBody.eventName, 'Winter Tournament 2027');
  assert.equal(allBody.codes.length, 2);
  assert.match(allBody.codes[0].image, /^data:image\/png/);
  assert.equal(allBody.codes[0].competitorCount, 4);
  assert.equal(allBody.codes[1].image, undefined);
  assert.match(allBody.codes[1].error, /Division 21 has 13 competitors/);

  const selected = await fetch(`${base}/api/divisions/qr-codes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupIds: [20] })
  });
  const selectedBody = await selected.json();
  assert.equal(selectedBody.codes.length, 1);
  assert.equal(selectedBody.codes[0].groupDivisionNumber, 20);

  const unknown = await fetch(`${base}/api/divisions/qr-codes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupIds: [99] })
  });
  assert.equal(unknown.status, 404);
  assert.match((await unknown.json()).error, /not found for this event: 99/);
});

test('division QR codes endpoint requires an event and saved divisions', async (t) => {
  const base = await startApp(t, {
    ...ringDeps(new Map(), {}),
    readActiveEvent: () => '',
    loadSavedGroups: async () => []
  });
  const noEvent = await fetch(`${base}/api/divisions/qr-codes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
  });
  assert.equal(noEvent.status, 400);
  assert.match((await noEvent.json()).error, /Activate a tournament/);
  const noGroups = await fetch(`${base}/api/divisions/qr-codes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventName: 'Winter Tournament 2027' })
  });
  assert.equal(noGroups.status, 404);
  assert.match((await noGroups.json()).error, /No saved divisions/);
});

test('division package routes are classified for browsers, tablets, and the QR page', () => {
  assert.ok(apiRoles('GET', '/api/rings/ring-a-1/division-package').includes('tournament-operator'));
  assert.ok(apiRoles('POST', '/api/divisions/qr-codes').includes('tournament-operator'));
  assert.equal(isTabletEndpoint('GET', '/api/rings/ring-a-1/division-package'), true);
  assert.equal(isTabletEndpoint('POST', '/api/divisions/qr-codes'), false);
  assert.equal(pageView('/division-qr/'), 'division-qr');
  assert.equal(pageView('/division-qr'), 'division-qr');
});
