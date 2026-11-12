const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../tournament-management/judge-management');
const { defaults } = require('../backend/judgeManagementRoutes');
const { certificationLevels, judgeRankOptions } = require('../db/judgeCertification');

test('completed-service attestation uses the shared inline checkbox layout', () => {
  const fs = require('node:fs'), path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'tournament-management', 'index.html'), 'utf8');
  assert.match(html, /<label class="jm-check"><input id="jmServiceCompleted" type="checkbox" required> I confirm/);
  assert.match(html, /#judgeManagementView label\.jm-check \{[^}]*flex-direction: row;[^}]*align-items: center;/);
  assert.match(html, /id="jmServicePacketsReload">Load service packets/);
  assert.match(html, /coordinators must verify it separately/);
});

test('CSV import shows high-contrast success and places Back to Judges in the import panel', async () => {
  const fs = require('node:fs'), path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'tournament-management', 'index.html'), 'utf8');
  const importSection = html.match(/<section id="jmImport" hidden>([\s\S]*?)<\/section>/)?.[1] || '';
  const importPanel = importSection.match(/<div class="jm-panel">([\s\S]*?)<\/div>/)?.[1] || '';
  assert.match(importPanel, /id="jmImportCancel">Back to Judges/);
  assert.match(html, /#judgeManagementView #jmNotice\[data-state="success"\][^{]*\{[^}]*color:\s*#166116/);

  const nodes = new Map(), calls = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', innerHTML: '', textContent: '', handlers: {}, files: [], disabled: false,
      attributes: {}, addEventListener(name, fn) { this.handlers[name] = fn; },
      setAttribute(name, value) { this.attributes[name] = value; }, querySelectorAll() { return []; }
    });
    return nodes.get(id);
  };
  const judge = { id: 1, associationId: 'NEW-1', firstName: 'New', lastName: 'Judge',
    school: 'School', rank: 'D1', certification: 'CORNER', status: 'Active' };
  const state = { revision: 1, aliases: defaults, ranks: judgeRankOptions(),
    certificationLevels: certificationLevels(), judges: [], tests: [], experience: [], eligibility: [] };
  const updated = { ...state, revision: 2, judges: [judge], added: 1, updated: 0 };
  const workspace = create({ document: { getElementById: node }, confirm: () => true, showPanel() {},
    request: async (url, options) => {
      calls.push({ url, options });
      return url === '/api/judge-management' ? state : updated;
    } });
  await workspace.load();
  node('jmCsv').files = [{ size: 10, text: async () => 'Association ID,First Name,Last Name\nNEW-1,New,Judge' }];
  await node('jmImportRun').handlers.click();

  assert.equal(calls.at(-1).url, '/api/judge-management-import');
  assert.match(node('jmNotice').textContent, /Import complete: 1 added, 0 updated/);
  assert.equal(node('jmNotice').attributes['data-state'], 'success');
  assert.match(node('jmBody').innerHTML, /NEW-1/);
  node('jmSelectAll').checked = true;
  node('jmSelectAll').handlers.change();
  assert.equal(node('jmSelectAll').checked, true);
  assert.equal(node('jmDelete').disabled, false);
  await node('jmDelete').handlers.click();
  assert.equal(calls.at(-1).url, '/api/judge-management/delete');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body).ids, [1]);
});

test('tablet service intake imports packets only as pending experience and supports USB receipts', async () => {
  const nodes = new Map(), calls = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', innerHTML: '', textContent: '', handlers: {}, disabled: false,
      addEventListener(name, fn) { this.handlers[name] = fn; }, setAttribute() {},
      querySelectorAll() { return []; }
    });
    return nodes.get(id);
  };
  const state = { asOf: '2026-01-15', revision: 7, aliases: defaults, ranks: judgeRankOptions(),
    certificationLevels: certificationLevels(), judges: [], tests: [], experience: [], eligibility: [] };
  const record = {
    submissionId: '123e4567-e89b-12d3-a456-426614174000', eventName: 'Event A',
    ringId: 'ring-a-1', phase: 'P1', importedAt: '', event: { date: '2026-01-15', scope: 'REGIONAL' },
    packet: { divisions: [{ seats: { center: [{ associationId: 'ID1' }] }, history: [] }] }
  };
  const workspace = create({
    document: {
      getElementById: node,
      createElement: () => ({ click() {} })
    },
    confirm: () => true, showPanel() {},
    request: async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/judge-management/service-packets') return { packets: [record] };
      if (url === '/api/judge-management/service-packets/usb') {
        return {
          type: 'tournament-judge-service-receipt',
          submissionId: record.submissionId,
          accepted: true,
          serverRecordId: 'server-record',
          receivedAt: '2026-01-15T12:00:00.000Z'
        };
      }
      return { ...state, added: 1, duplicates: 0 };
    }
  });
  await workspace.load();
  await node('jmServicePacketsReload').handlers.click();
  assert.match(node('jmServicePacketsBody').innerHTML, /Ring ring-a-1 — P1/);
  const importButton = {
    disabled: false,
    getAttribute: () => record.submissionId,
    closest: () => ({ querySelectorAll: () => [] })
  };
  await node('jmServicePacketsBody').handlers.click({
    target: { closest: (selector) => selector.includes('replacement-reviews-save') ? null : importButton }
  });
  const request = calls.find((call) => call.url.includes('/import'));
  assert.ok(request);
  assert.equal(request.options.method, 'POST');
  assert.equal(JSON.parse(request.options.body).confirmImport, true);
  assert.equal(JSON.parse(request.options.body).eventName, 'Event A');
  assert.doesNotMatch(request.options.body, /logVerified|verified/);

  const envelope = {
    type: 'tournament-judge-service-transfer',
    schemaVersion: 1,
    eventName: 'Event A',
    packet: { ringId: 'ring-a-1', phase: 'P1' }
  };
  node('jmServicePacketsUsbFile').files = [{ text: async () => JSON.stringify(envelope) }];
  await node('jmServicePacketsUsbFile').handlers.change({ target: node('jmServicePacketsUsbFile') });
  const usbRequest = calls.find((call) => call.url.endsWith('/service-packets/usb'));
  assert.ok(usbRequest);
  assert.deepEqual(JSON.parse(usbRequest.options.body), envelope);
  assert.match(node('jmServicePacketsNotice').textContent, /import that receipt on the tablet/);
});

test('flagged tablet replacements require saved affected-party decisions before import', async () => {
  const nodes = new Map(), calls = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', innerHTML: '', textContent: '', handlers: {}, disabled: false,
      addEventListener(name, fn) { this.handlers[name] = fn; }, setAttribute() {},
      querySelectorAll() { return []; }
    });
    return nodes.get(id);
  };
  const state = { asOf: '2026-01-15', revision: 7, aliases: defaults, ranks: judgeRankOptions(),
    certificationLevels: certificationLevels(), judges: [], tests: [], experience: [], eligibility: [] };
  const record = {
    submissionId: '123e4567-e89b-12d3-a456-426614174000', eventName: 'Event A',
    ringId: 'ring-a-1', phase: 'P1', importedAt: '', event: { date: '2026-01-15', scope: 'REGIONAL' },
    packet: { divisions: [{ groupAnchor: '20', seats: {}, history: [] }] },
    replacementReviews: [{
      replacementId: 'a'.repeat(64), groupAnchor: '20', role: 'center',
      incomingAssociationId: 'ID2', outgoingAssociationId: 'ID1',
      assignmentRevision: 'revision-1', replacementPinVerified: true
    }]
  };
  const decision = { value: 'APPROVED', getAttribute: () => record.replacementReviews[0].replacementId };
  const confirmation = { checked: true };
  const card = {
    querySelectorAll: (selector) => selector === '[data-jm-replacement-decision]' ? [decision] : [],
    querySelector: () => confirmation
  };
  const saveButton = {
    getAttribute: () => record.submissionId,
    closest: () => card
  };
  const importButton = {
    getAttribute: () => record.submissionId,
    closest: () => card
  };
  const workspace = create({
    document: { getElementById: node },
    confirm: () => true, showPanel() {},
    request: async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/judge-management/service-packets') return { packets: [record] };
      if (url.endsWith('/replacement-reviews')) {
        const request = JSON.parse(options.body);
        record.replacementReviews[0] = {
          ...record.replacementReviews[0], ...request.reviews[0], reviewedAt: '2026-01-15T12:00:00.000Z'
        };
        state.revision++;
        return state;
      }
      if (url.endsWith('/import')) return { ...state, added: 1, duplicates: 0 };
      return state;
    }
  });
  await workspace.load();
  await node('jmServicePacketsReload').handlers.click();
  assert.match(node('jmServicePacketsBody').innerHTML, /reviewing the replacement with the affected parties/);
  await node('jmServicePacketsBody').handlers.click({
    target: { closest: (selector) => selector.includes('replacement-reviews-save') ? null : importButton }
  });
  assert.match(node('jmServicePacketsNotice').textContent, /save each decision/);
  assert.equal(calls.some((call) => call.url.endsWith('/import')), false);

  await node('jmServicePacketsBody').handlers.click({
    target: { closest: (selector) => selector.includes('replacement-reviews-save') ? saveButton : null }
  });
  const reviewRequest = calls.find((call) => call.url.endsWith('/replacement-reviews'));
  assert.equal(reviewRequest.options.method, 'PUT');
  assert.equal(JSON.parse(reviewRequest.options.body).reviews[0].decision, 'APPROVED');
  assert.equal(JSON.parse(reviewRequest.options.body).reviews[0].reviewedWithAffectedParties, true);

  await node('jmServicePacketsBody').handlers.click({
    target: { closest: (selector) => selector.includes('service-packet-import') ? importButton : null }
  });
  assert.ok(calls.some((call) => call.url.endsWith('/import')));
});

test('judge workspace saves, protects unsaved edits, filters, escapes and surfaces errors', async () => {
  const nodes = new Map(), calls = [], panels = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', files: [], handlers: {},
      addEventListener(name, fn) { this.handlers[name] = fn; }, setAttribute(name, value) { this[name] = value; } });
    return nodes.get(id);
  };
  let accept = false, fail = false;
  const state = { revision: 1, aliases: defaults, ranks: judgeRankOptions(), certificationLevels: certificationLevels(),
    judges: [{ id: 1, associationId: 'ID1', firstName: 'John', lastName: '<Smith>', school: 'School',
      rank: 'D1', certification: 'CORNER', expiration: null, status: 'Active', notes: '' }] };
  const workspace = create({ document: { getElementById: node }, confirm: () => accept,
    showPanel: (...args) => panels.push(args), request: async (url, options) => {
      calls.push({ url, options });
      if (fail) throw new Error('Save failed');
      return state;
    } });
  await workspace.load();
  assert.match(node('jmBody').innerHTML, /&lt;Smith&gt;/);
  node('jmSearch').value = 'nobody'; node('jmFilter').handlers.click();
  assert.match(node('jmBody').innerHTML, /No matching judges/);
  node('jmSearch').value = ''; node('jmFilter').handlers.click();
  workspace.begin('judge-management');
  node('jm-associationId').value = 'ID2';
  node('jm-firstName').value = 'John';
  node('jm-lastName').value = 'Smith';
  assert.equal(workspace.dirty(), true);
  assert.equal(workspace.canLeave(), false);
  fail = true;
  await node('jmForm').handlers.submit({ preventDefault() {} });
  assert.match(node('jmError').textContent, /Save failed/);
  assert.equal(workspace.dirty(), true);
  fail = false;
  await node('jmForm').handlers.submit({ preventDefault() {} });
  assert.equal(calls.at(-1).url, '/api/judge-management');
  assert.equal(JSON.parse(calls.at(-1).options.body).revision, 1);
  assert.equal(workspace.dirty(), false);
  assert.deepEqual(panels.at(-1), ['judge-management']);
  node('jmAlias-school').value = 'different';
  assert.equal(workspace.canLeave(), false);
  accept = true;
  assert.equal(workspace.canLeave(), true);
  assert.equal(workspace.dirty(), false);
});

test('lifecycle table filters retain independent counts, visible rank and explicit award/verification actions', async () => {
  const nodes = new Map(), calls = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', handlers: {},
      addEventListener(name, fn) { this.handlers[name] = fn; }, setAttribute() {} });
    return nodes.get(id);
  };
  const state = { asOf: '2026-01-15', revision: 1, aliases: defaults, ranks: judgeRankOptions(),
    certificationLevels: certificationLevels(),
    judges: [1, 2].map((id) => ({ id, associationId: `MEMBER${id}`, firstName: 'Test', lastName: id === 1 ? '<Ready>' : 'Pending',
      school: 'School', rank: id === 1 ? 'D1' : 'CDB', certification: 'SK_TK', status: 'Active' })),
    tests: [{ judgeId: 1, targetLevel: 'CORNER', writtenScore: 80 }, { judgeId: 2, targetLevel: 'SK_TK', writtenScore: 79 }],
    experience: [1, 2].map((id) => ({ id, judgeId: id, eventName: 'Regional', role: 'TIMEKEEPER', eventScope: 'REGIONAL', logVerified: id === 1 })),
    eligibility: [1, 2].map((id) => ({ judgeId: id, targetLevel: 'CORNER', eligible: true, writtenPassed: id === 1, practicalPassed: true })) };
  const workspace = create({ document: { getElementById: node }, confirm: () => true, showPanel() {},
    request: async (url, options) => { calls.push({ url, options }); return state; } });
  await workspace.load();
  assert.match(node('jmBody').innerHTML, /Cho Dan/);
  assert.match(node('jmCount').textContent, /2 of 2 judges/);
  node('jmEligibilityBody').handlers.change({ target: { getAttribute: () => '1', value: '2026-01-01' } });
  node('jmEligibilityReady').value = 'ready'; node('jmEligibilityReady').handlers.change();
  assert.match(node('jmEligibilityBody').innerHTML, /&lt;Ready&gt;/);
  assert.doesNotMatch(node('jmEligibilityBody').innerHTML, /MEMBER2/);
  assert.equal(node('jmEligibilityCount').textContent, '1 of 2 judges');
  node('jmEligibilityReady').value = 'not-ready'; node('jmEligibilityReady').handlers.change();
  assert.match(node('jmEligibilityBody').innerHTML, /MEMBER2/);
  node('jmEligibilitySearch').value = 'missing'; node('jmEligibilitySearch').handlers.input();
  assert.match(node('jmEligibilityBody').innerHTML, /colspan="10">No matching/);
  node('jmEligibilityClear').handlers.click();
  assert.equal(node('jmEligibilityCount').textContent, '2 of 2 judges');
  assert.match(node('jmEligibilityBody').innerHTML, /data-jm-grant-date="1" value="2026-01-01"/, 'filters retain the chosen award date');
  node('jmTestingSearch').value = 'MEMBER1'; node('jmTestingSearch').handlers.input();
  assert.equal(node('jmTestingCount').textContent, '1 of 2 test records');
  assert.doesNotMatch(node('jmTestingBody').innerHTML, /MEMBER2/);
  node('jmExperienceVerified').value = 'pending'; node('jmExperienceVerified').handlers.change();
  node('jmExperienceSearch').value = 'timekeeper'; node('jmExperienceSearch').handlers.input();
  assert.equal(node('jmExperienceCount').textContent, '1 of 2 service records');
  assert.match(node('jmExperienceBody').innerHTML, /MEMBER2/);
  node('jmExperienceClear').handlers.click();
  node('jmTestingClear').handlers.click();
  assert.equal(node('jmExperienceCount').textContent, '2 of 2 service records');
  assert.equal(node('jmTestingCount').textContent, '2 of 2 test records');
  assert.equal(workspace.dirty(), false);
  assert.equal(calls.length, 1, 'filters never save, award or verify');
  assert.equal(calls[0].options, undefined);
  await workspace.load();
  assert.match(node('jmEligibilityBody').innerHTML, /data-jm-grant-date="1" value="2026-01-15"/, 'explicit reload restores the evaluation date');
});

test('judge expiration filters and award defaults follow the server evaluation date', async () => {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', handlers: {},
      addEventListener(name, fn) { this.handlers[name] = fn; }, setAttribute() {} });
    return nodes.get(id);
  };
  const state = { asOf: '2040-01-15', revision: 1, aliases: defaults, ranks: judgeRankOptions(),
    certificationLevels: certificationLevels(),
    judges: [{ id: 1, associationId: 'SIM-1', firstName: 'Test', lastName: 'Judge',
      school: '', status: 'Active', certification: 'SK_TK', expiration: '2040-02-01' }],
    eligibility: [{ judgeId: 1, targetLevel: 'CORNER', eligible: false }] };
  const workspace = create({ document: { getElementById: node }, confirm: () => true,
    showPanel() {}, request: async () => state });
  await workspace.load();
  assert.match(node('jmEligibilityBody').innerHTML, /value="2040-01-15"/);
  node('jmFilterExpiration').value = '30';
  node('jmFilter').handlers.click();
  assert.match(node('jmBody').innerHTML, /SIM-1/);
  state.asOf = '2039-01-15';
  await workspace.load();
  assert.match(node('jmBody').innerHTML, /No matching judges/);
});

test('API experience remains read-only in edits and coordinator verification uses the shared endpoint', async () => {
  const nodes = new Map(), calls = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', handlers: {},
      addEventListener(name, fn) { this.handlers[name] = fn; }, setAttribute() {} });
    return nodes.get(id);
  };
  const judge = { id: 1, associationId: 'SIM-R-041', firstName: 'Test', lastName: 'Judge',
    certification: 'CORNER', school: '', status: 'Active' };
  const state = { asOf: '2026-01-15', revision: 3, judges: [judge], aliases: defaults,
    ranks: judgeRankOptions(), certificationLevels: certificationLevels(),
    experience: [{ id: 12, judgeId: 1, eventName: 'Regional', eventDate: '2026-01-01', location: '',
      role: 'CORNER_JUDGE', eventScope: 'REGIONAL', phase: 'P2', sourceId: 'service-1', logVerified: 0 }] };
  const workspace = create({ document: { getElementById: node }, confirm: () => true, showPanel() {},
    request: async (url, options) => { calls.push({ url, options }); return state; } });
  await workspace.load();
  assert.match(node('jmExperienceBody').innerHTML, /Regional \(P2\)/);
  workspace.begin('judge-management', judge);
  assert.match(node('jmExperienceRecords').innerHTML, /<fieldset disabled>/);
  await node('jmExperienceBody').handlers.click({ target: { closest(selector) {
    return selector === '[data-jm-verify]' ? { getAttribute: () => '12' } : null;
  } } });
  assert.equal(calls.at(-1).url, '/api/judge-management/experience-verify');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), {
    associationId: 'SIM-R-041', ids: [12], verified: true, revision: 3
  });
});

test('coordinator service form guards drafts, attestation, failures, duplicate writes, corrections and withdrawal', async () => {
  const nodes = new Map(), calls = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, handlers: {},
      addEventListener(name, fn) { this.handlers[name] = fn; }, setAttribute() {} });
    return nodes.get(id);
  };
  const service = { id: 21, judgeId: 1, eventId: 'event-1', eventName: '<Regional>',
    eventDate: '2026-01-10', eventScope: 'REGIONAL', phase: 'P1', role: 'CORNER_JUDGE',
    location: 'Venue', source: 'MANUAL', sourceId: 'manual:1', logVerified: 1 };
  const state = { asOf: '2026-01-15', revision: 4, aliases: defaults, ranks: judgeRankOptions(),
    certificationLevels: certificationLevels(), judges: [{ id: 1, associationId: 'ID1', firstName: 'Test',
      lastName: '<Judge>', certification: 'CORNER', school: '', status: 'Active' }], experience: [service] };
  let accept = false, fail = false, release;
  const workspace = create({ document: { getElementById: node }, confirm: () => accept, showPanel() {},
    request: async (url, options) => {
      calls.push({ url, options });
      if (fail) throw new Error('Stale revision: reload before saving');
      if (release === true) await new Promise((resolve) => { release = resolve; });
      return state;
    } });
  await workspace.load();
  assert.match(node('jmExperienceBody').innerHTML, /Coordinator-recorded actual service/);
  assert.match(node('jmExperienceBody').innerHTML, /&lt;Regional&gt;/);
  assert.match(node('jmService-associationId').innerHTML, /&lt;Judge&gt;/);
  node('jmServiceAdd').handlers.click();
  for (const [field, value] of Object.entries({ associationId: 'ID1', eventId: 'event-1', eventName: '<Regional>',
    eventDate: '2026-01-10', eventScope: 'REGIONAL', location: 'Venue', phase: 'P2', role: 'CORNER_JUDGE' })) {
    node(`jmService-${field}`).value = value;
  }
  assert.equal(workspace.dirty(), true);
  assert.equal(workspace.canLeave(), false);
  const submit = () => node('jmServiceForm').handlers.submit({ preventDefault() {} });
  await submit();
  assert.match(node('jmServiceError').textContent, /Confirm actual completed service/);
  assert.equal(calls.length, 1);
  node('jmServiceCompleted').checked = true;
  await submit();
  assert.equal(calls.length, 1);
  accept = true; fail = true;
  await submit();
  assert.match(node('jmNotice').textContent, /Stale revision/);
  assert.equal(workspace.dirty(), true);
  assert.equal(node('jmService-phase').value, 'P2');
  fail = false; release = true;
  const pending = submit();
  assert.equal(workspace.busy(), true);
  assert.equal(node('jmServiceFields').disabled, true);
  assert.equal(workspace.canLeave(), false);
  await submit();
  assert.equal(calls.length, 3);
  release(); await pending;
  const body = JSON.parse(calls.at(-1).options.body);
  assert.equal(calls.at(-1).url, '/api/judge-management/experience');
  assert.equal(body.records[0].source, 'MANUAL');
  assert.equal(body.records[0].phase, 'P2');
  assert.equal(body.confirmedCompleted, true);
  assert.equal(body.revision, 4);
  assert.equal(workspace.dirty(), false);
  assert.equal(node('jmServiceForm').hidden, true);
  const action = (attribute) => ({ target: { closest: (selector) =>
    selector === `[${attribute}]` ? { getAttribute: () => '21' } : null } });
  node('jmExperienceBody').handlers.click(action('data-jm-service-edit'));
  assert.equal(node('jmService-eventId').disabled, true);
  assert.equal(node('jmServiceEvent').disabled, true);
  assert.equal(node('jmServiceCompleted').checked, false);
  node('jmServiceCompleted').checked = true;
  await submit();
  assert.equal(calls.at(-1).url, '/api/judge-management/experience/21');
  assert.equal(calls.at(-1).options.method, 'PUT');
  await node('jmExperienceBody').handlers.click(action('data-jm-service-delete'));
  assert.equal(calls.at(-1).options.method, 'DELETE');
  assert.equal(JSON.parse(calls.at(-1).options.body).confirmedWithdrawal, true);
  node('jmServiceAdd').handlers.click();
  node('jmServiceEvent').value = 'event-1';
  node('jmServiceEvent').handlers.change();
  assert.equal(node('jmService-eventId').value, 'event-1');
  assert.equal(node('jmService-eventName').disabled, true);
  assert.equal(workspace.canLeave(), true);
  assert.equal(workspace.dirty(), false);
});

test('assignment seed opens guarded actual-service draft with no implicit role, attestation, verification or write', async () => {
  const nodes = new Map(), calls = [], panels = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, handlers: {},
      addEventListener(name, fn) { this.handlers[name] = fn; }, setAttribute() {} });
    return nodes.get(id);
  };
  const state = { asOf: '2040-01-15', revision: 4, aliases: defaults, ranks: judgeRankOptions(),
    certificationLevels: certificationLevels(), judges: [{ id: 1, associationId: 'ID1', firstName: 'Test',
      lastName: 'Judge', certification: 'SK_TK', school: '', status: 'Active' }], experience: [] };
  let accept = false, fail = false;
  const workspace = create({ document: { getElementById: node }, confirm: () => accept,
    showPanel: (panel) => panels.push(panel), request: async (url, options) => {
      calls.push({ url, options });
      if (fail) throw new Error('Directory unavailable');
      return state;
    } });
  const seed = { associationId: 'ID1', eventId: 'simulation-event:Review', eventName: 'Review',
    eventDate: '2040-01-15', eventScope: 'REGIONAL', phase: 'P2', role: '', location: 'Venue', context: 'P2, Ring A1, planned SK/TK' };
  await assert.rejects(workspace.beginService(seed, 3), /Judge data or service changed/);
  assert.equal(node('jmServiceForm').hidden, true);
  assert.equal(await workspace.beginService(seed, 4), true);
  assert.equal(panels.at(-1), 'judge-experience');
  assert.equal(node('jmService-role').value, '');
  assert.equal(node('jmService-phase').value, 'P2');
  assert.equal(node('jmService-eventId').disabled, true);
  assert.equal(node('jmServiceCompleted').checked, false);
  assert.match(node('jmServiceContext').textContent, /Ring A1.*not proof of service/);
  assert.equal(workspace.dirty(), true);
  assert.equal(workspace.canLeave(), false);
  assert.ok(calls.every((call) => call.options === undefined));
  await node('jmServiceForm').handlers.submit({ preventDefault() {} });
  assert.match(node('jmServiceError').textContent, /Confirm actual completed service/);
  node('jmService-role').value = 'TIMEKEEPER';
  node('jmServiceCompleted').checked = true;
  accept = true;
  await node('jmServiceForm').handlers.submit({ preventDefault() {} });
  const body = JSON.parse(calls.at(-1).options.body);
  assert.equal(body.confirmedCompleted, true);
  assert.equal(body.records[0].role, 'TIMEKEEPER');
  assert.equal(body.records[0].source, 'MANUAL');
  assert.equal(body.records[0].eventId, seed.eventId);
  assert.equal(body.records[0].phase, 'P2');
  assert.equal(body.records[0].logVerified, undefined);
  assert.equal(workspace.dirty(), false);
  node('jmServiceAdd').handlers.click();
  assert.equal(node('jmServiceContext').hidden, true, 'ordinary manual entry has no stale plan context');
  assert.equal(node('jmService-eventId').disabled, false);
  fail = true;
  await assert.rejects(workspace.beginService(seed, 4), /Unable to reload Judge Management/);
});

test('testing retains failed attempts and retakes while eligibility requires an explicit confirmed award', async () => {
  const nodes = new Map(), calls = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', handlers: {},
      addEventListener(name, fn) { this.handlers[name] = fn; }, setAttribute() {},
      querySelector() { return { value: '2026-01-15' }; } });
    return nodes.get(id);
  };
  const judge = { id: 1, associationId: 'SIM-STEP4', firstName: 'Test', lastName: 'Judge',
    certification: 'CORNER', rank: 'D2', status: 'Active' };
  const state = { asOf: '2026-01-15', revision: 1, aliases: defaults, ranks: judgeRankOptions(),
    certificationLevels: certificationLevels(), judges: [judge], experience: [],
    tests: [
      { judgeId: 1, targetLevel: 'REGIONAL', writtenDate: '2026-01-12', writtenScore: 79,
        practicalDate: '2026-01-12', practicalPassed: 0 },
      { judgeId: 1, targetLevel: 'REGIONAL', writtenDate: '2026-01-13', writtenScore: 80,
        practicalDate: null, practicalPassed: null },
      { judgeId: 1, targetLevel: 'REGIONAL', writtenDate: null, writtenScore: null,
        practicalDate: '2026-01-15', practicalPassed: 1 }
    ],
    eligibility: [{ judgeId: 1, targetLevel: 'REGIONAL', experienceCount: 2, requiredExperience: 2,
      eligible: true, writtenPassed: true, practicalRequired: true, practicalPassed: false, status: 'Eligible to test' }] };
  let accept = false, finish;
  const workspace = create({ document: { getElementById: node }, confirm: () => accept, showPanel() {},
    request: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/award')) await new Promise((resolve) => { finish = resolve; });
      return state;
    } });
  await workspace.load();
  assert.match(node('jmTestingBody').innerHTML, /79%.*Fail/);
  assert.match(node('jmTestingBody').innerHTML, /80%/);
  assert.match(node('jmTestingBody').innerHTML, /2026-01-15.*Pass/);
  assert.match(node('jmEligibilityBody').innerHTML, /data-jm-award="1" disabled/);
  workspace.begin('judge-testing', judge);
  await node('jmForm').handlers.submit({ preventDefault() {} });
  const savedTests = JSON.parse(calls.at(-1).options.body).tests;
  assert.equal(savedTests.length, 3);
  assert.equal(savedTests[0].writtenScore, 79);
  assert.equal(savedTests[0].practicalPassed, false);
  assert.equal(savedTests[1].writtenScore, 80);
  assert.equal(savedTests[2].practicalPassed, true);
  state.eligibility[0].practicalPassed = true;
  await workspace.load();
  assert.match(node('jmEligibilityBody').innerHTML, /Ready for coordinator award/);
  assert.match(node('jmEligibilityBody').innerHTML, /max="2026-01-15"/);
  assert.equal(calls.some((call) => call.url.endsWith('/award')), false);
  const event = { target: { closest() {
    return { disabled: false, getAttribute: () => '1' };
  } } };
  node('jmEligibilityBody').handlers.click(event);
  assert.equal(calls.some((call) => call.url.endsWith('/award')), false, 'cancel prevents award');
  accept = true;
  const pending = node('jmEligibilityBody').handlers.click(event);
  assert.equal(workspace.busy(), true);
  node('jmEligibilityBody').handlers.click(event);
  assert.equal(calls.filter((call) => call.url.endsWith('/award')).length, 1);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { revision: 1, grantedAt: '2026-01-15' });
  finish(); await pending;
  assert.equal(workspace.busy(), false);
});
