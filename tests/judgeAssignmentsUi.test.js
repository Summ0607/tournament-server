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
  const simulator = fs.readFileSync(path.join(__dirname, '..', 'tournament-management', 'judge-simulation.js'), 'utf8');
  const shell = fs.readFileSync(path.join(__dirname, '..', 'tournament-management', 'judge-simulation.html'), 'utf8');
  assert.match(simulator, /controllers = \[workspace, volunteers, ringJudges, assignments, serviceReview\]/);
  assert.match(simulator, /workspace\.beginService\(draft, revision\)/);
  assert.match(shell, /data-panel="service-review"/);
  assert.match(shell, /judge-service-review\.js/);
  assert.doesNotMatch(html, /judge-service-review\.js/, 'assignment review remains opt-in in the isolated simulator');
});

const { buildReview, create: createServiceReview } = require('../tournament-management/judge-service-review');
function reviewFixture() {
  const config = { eventName: 'Review', name: '<Regional>', date: '2040-01-15', scope: 'regional', location: 'Venue' };
  const plan = { revision: 'plan-1', sourceRevision: 'source-1', phases: {
    P1: { rings: ['A1'], arbitrators: ['MEMBER1'], assignments: { A1: { center: ['MEMBER2'], corner: ['MISSING'], sktk: ['MEMBER3'] } } },
    P2: { rings: ['A1'], arbitrators: [], assignments: { A1: { center: [], corner: ['MEMBER2'], sktk: ['MEMBER3'] } } }
  } };
  const directory = { asOf: '2040-01-15', revision: 3, judges: [1, 2, 3].map((id) =>
    ({ id, associationId: `MEMBER${id}`, firstName: 'Test', lastName: '<Judge>' })), experience: [] };
  return { config, plan, directory };
}
test('service review maps saved plans without credit, preserves event identities and distinguishes recorded actuals', () => {
  const { config, plan, directory } = reviewFixture();
  const before = structuredClone({ plan, directory });
  let review = buildReview(config, plan, directory);
  assert.equal(review.rows.length, 6);
  assert.equal(review.actual.length, 0);
  assert.equal(review.event.eventId, 'simulation-event:Review');
  assert.equal(review.rows[0].seed.role, 'ARBITRATOR');
  assert.equal(review.rows[1].seed.role, 'CENTER_JUDGE');
  assert.equal(review.rows[2].missing, true);
  assert.equal(review.rows[3].seed.role, '', 'SK/TK must explicitly choose actual role');
  assert.equal(review.rows[4].seed.role, 'CORNER_JUDGE');
  assert.equal(review.rows[5].seed.phase, 'P2');
  assert.deepEqual({ plan, directory }, before, 'building a review never mutates plans or experience');
  const record = { id: 8, eventId: 'previous-manual-id', eventName: '<Regional>', eventDate: config.date,
    eventScope: 'REGIONAL', phase: 'P1', role: 'TIMEKEEPER', judgeId: 3, logVerified: 0 };
  directory.experience = [record];
  review = buildReview(config, plan, directory);
  assert.equal(review.event.eventId, record.eventId);
  assert.deepEqual(review.rows[3].matching, [record]);
  assert.equal(review.rows[5].matching.length, 0, 'matching is phase specific');
  directory.experience.push({ ...record, id: 9, judgeId: 1, role: 'CENTER_JUDGE', logVerified: 1 });
  review = buildReview(config, plan, directory);
  assert.equal(review.actual.length, 2, 'replacement service appears even though it differs from plan');
  assert.equal(review.rows[1].matching.length, 0, 'planned judge does not gain replacement credit');
  assert.equal(buildReview({ ...config, date: '2040-01-16' }, plan, directory).future, true);
  assert.equal(buildReview({ ...config, scope: 'in-house' }, plan, { ...directory, experience: [] }).event.eventScope, 'IN_HOUSE');
  for (const experience of [[{ ...record, eventId: null }], [record, { ...record, eventId: 'conflict' }],
    [{ ...record, eventScope: 'WORLD' }], [{ ...record, eventId: 'simulation-event:Review', eventName: 'Other event' }]]) {
    assert.throws(() => buildReview(config, plan, { ...directory, experience }), /conflict|unlinked/);
  }
});

test('service review is read-only, guards stale plans and failures, escapes values and defers completion to manual form', async () => {
  const fixture = reviewFixture(), nodes = new Map(), calls = [], opened = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', handlers: {},
      setAttribute(name, value) { this[name] = value; }, addEventListener(name, fn) { this.handlers[name] = fn; } });
    return nodes.get(id);
  };
  let selected = 'Review', fail = false, release, experienceOpened = false;
  const workspace = createServiceReview({ document: { getElementById: node }, selectedEvent: () => selected,
    beginService: async (...args) => { opened.push(args); }, viewExperience: () => { experienceOpened = true; },
    request: async (url, options) => {
      calls.push({ url, options });
      if (release === true) await new Promise((resolve) => { release = resolve; });
      if (fail) throw new Error('Review request failed');
      return structuredClone(url === '/api/simulation/events' ? { events: [fixture.config] }
        : url === '/api/judge-management' ? fixture.directory : fixture.plan);
    } });
  await workspace.load();
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.options === undefined), 'loading uses GET only');
  assert.equal(workspace.dirty(), false);
  assert.match(node('srBody').innerHTML, /&lt;Judge&gt;/);
  assert.match(node('srNotice').textContent, /Read-only plans earn no credit/);
  const click = (index) => node('srBody').handlers.click({ target: { closest() {
    return { disabled: false, getAttribute: () => String(index) };
  } } });
  await click(2);
  assert.equal(opened.length, 0, 'missing directory member cannot seed service');
  await click(3);
  assert.equal(opened.length, 1);
  assert.equal(opened[0][0].role, '');
  assert.equal(opened[0][0].phase, 'P1');
  assert.equal(opened[0][1], 3);
  fixture.plan.revision = 'changed';
  await click(1);
  assert.equal(opened.length, 1);
  assert.match(node('srNotice').textContent, /Assignments.*changed/);
  await workspace.load();
  fixture.plan.sourceRevision = 'new-qualifications';
  await click(1);
  assert.equal(opened.length, 1);
  await workspace.load();
  release = true;
  const pending = click(1);
  assert.equal(workspace.busy(), true);
  assert.equal(workspace.canLeave(), false);
  await click(1);
  release(); release = false; await pending;
  assert.equal(opened.length, 2);
  fail = true;
  await click(1);
  assert.match(node('srNotice').textContent, /Review request failed/);
  await workspace.load();
  assert.equal(node('srBody').innerHTML, '');
  fail = false; fixture.config.date = '2041-01-15';
  await workspace.load();
  assert.match(node('srNotice').textContent, /Future event/);
  await click(1);
  assert.equal(opened.length, 2);
  node('srExperience').handlers.click();
  assert.equal(experienceOpened, true);
  selected = '';
  await workspace.load();
  assert.match(node('srNotice').textContent, /Select an isolated event/);
});
