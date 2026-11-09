const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../tournament-management/judge-assignments');
test('phase planner confirms competitor agreement, preserves other phase, saves revisions, escapes names and guards drafts', async () => {
  const nodes = new Map(), calls = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', value: '', handlers: {},
      setAttribute(name, value) { this[name] = value; }, addEventListener(name, fn) { this.handlers[name] = fn; } });
    return nodes.get(id);
  };
  const empty = (discipline) => ({ discipline, rings: [], available: [], arbitrators: [], assignments: {} });
  let state = { revision: null, sourceRevision: 's1', configurationLocked: false, rings: ['A1'],
    phases: { P1: empty('black-belt'), P2: empty('gup') },
    judges: [{ id: 'TEST', name: '<Test>', associationId: 'TEST', potential: true, sources: ['competitor'], rank: 'D1',
      certification: 'CORNER', roles: { corner: true, sktk: true, center: false, arbitrator: false } }] };
  let agree = false, fail = false, eventName = 'Event', delayed;
  const workspace = create({ document: { getElementById: node }, selectedEvent: () => eventName, confirm: () => agree,
    request: async (url, options) => {
      calls.push({ url, options });
      if (delayed) await delayed;
      if (fail) throw new Error('Source changed');
      if (options?.method === 'PUT') state = { ...state, revision: 'saved', phases: JSON.parse(options.body).phases };
      return structuredClone(state);
    } });
  await workspace.load();
  assert.match(node('jaContent').innerHTML, /&lt;Test&gt;/);
  node('jaPhase').value = 'P2'; node('jaPhase').handlers.change();
  const change = (attributes, checked = true) => node('jaContent').handlers.change({
    target: { checked, value: '', getAttribute(name) { return attributes[name]; } }
  });
  change({ 'data-ja-available': 'TEST' });
  assert.equal(workspace.dirty(), false);
  agree = true; change({ 'data-ja-available': 'TEST' });
  assert.equal(workspace.dirty(), true);
  agree = false; assert.equal(workspace.canLeave(), false);
  fail = true; await node('jaSave').handlers.click();
  assert.match(node('jaNotice').textContent, /Source changed/);
  assert.equal(workspace.dirty(), true);
  fail = false; await node('jaSave').handlers.click();
  const body = JSON.parse(calls.at(-1).options.body);
  assert.equal(body.sourceRevision, 's1');
  assert.deepEqual(body.phases.P1.available, []);
  assert.deepEqual(body.phases.P2.available, ['TEST']);
  assert.equal(workspace.dirty(), false);
  change({ 'data-ja-ring': 'A1' });
  agree = true; assert.equal(workspace.canLeave(), true);
  assert.equal(workspace.dirty(), false);
  let resolve;
  delayed = new Promise((done) => { resolve = done; });
  const loading = workspace.load();
  eventName = 'Other'; workspace.leave(); resolve(); await loading;
  assert.match(node('jaContent').innerHTML, /Select a tournament/);
});

test('main shell wires selected-event preparation, not live-only routing, with departure guards', () => {
  const fs = require('node:fs'), path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'tournament-management', 'index.html'), 'utf8');
  assert.match(html, /judge-assignments\.js/);
  assert.match(html, /judgeAssignmentsWorkspace\.canLeave/);
  assert.match(html, /judgeAssignmentsWorkspace\.dirty/);
  assert.doesNotMatch(html.match(/const dayOfViews = .*;/)[0], /judge-assignments/);
  assert.doesNotMatch(html.match(/<button[^>]*data-nav-id="judge-assignments"[^>]*>/)[0], /data-nav-planned/);
});
