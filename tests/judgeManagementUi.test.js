const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../tournament-management/judge-management');
const { defaults } = require('../backend/judgeManagementRoutes');
const { certificationLevels, judgeRankOptions } = require('../db/judgeCertification');

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
  await node('jmExperienceBody').handlers.click({ target: { closest() {
    return { getAttribute: () => '12' };
  } } });
  assert.equal(calls.at(-1).url, '/api/judge-management/experience-verify');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), {
    associationId: 'SIM-R-041', ids: [12], verified: true, revision: 3
  });
});
