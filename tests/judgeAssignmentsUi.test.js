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
    judges: [
      { id: 'TEST', name: '<Test>', associationId: 'TEST', potential: true, sources: ['competitor'], rank: 'D1',
        certification: 'CORNER', roles: { corner: true, sktk: true, center: false, arbitrator: false } },
      { id: 'GUP', name: 'Gup Volunteer', associationId: 'GUP', potential: false, sources: ['volunteer', 'competitor'],
        rank: 'G5', certification: 'SK_TK', roles: { corner: false, sktk: true, center: false, arbitrator: false } }
    ] };
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
  assert.match(node('jaContent').innerHTML, /Confirm Gup Volunteer \(GUP\)[^>]*data-ja-available="GUP"[^>]*>/);
  assert.doesNotMatch(node('jaContent').innerHTML.match(/<input id="jaAvailable-\d+" aria-label="Confirm Gup Volunteer \(GUP\)"[^>]*>/)?.[0] || '', /disabled/,
    'Gup competitors may be considered for the non-competing Black Belt phase');
  node('jaPhase').value = 'P2'; node('jaPhase').handlers.change();
  assert.match(node('jaContent').innerHTML.match(/<input id="jaAvailable-\d+" aria-label="Confirm Gup Volunteer \(GUP\)"[^>]*>/)?.[0] || '', /disabled/,
    'Gup competitors cannot be marked available in the Gup phase');
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

test('planner saves the coordinator-created event PIN without reading it back', async () => {
  const nodes = new Map(), calls = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', value: '', handlers: {},
      setAttribute(name, value) { this[name] = value; }, addEventListener(name, fn) { this.handlers[name] = fn; } });
    return nodes.get(id);
  };
  const empty = (discipline) => ({ discipline, rings: [], available: [], arbitrators: [], assignments: {} });
  let state = {
    revision: null, sourceRevision: 'source-1', configurationLocked: false,
    rings: ['A1'], replacementPinConfigured: false,
    phases: { P1: empty('black-belt'), P2: empty('gup') }, judges: []
  };
  const workspace = create({
    document: { getElementById: node }, selectedEvent: () => 'Event A', confirm: () => true,
    request: async (_url, options) => {
      calls.push({ options });
      if (options?.method === 'PUT') {
        const body = JSON.parse(options.body);
        state = { ...state, revision: 'revision-1', replacementPinConfigured: Boolean(body.replacementPin) };
      }
      return structuredClone(state);
    }
  });
  await workspace.load();
  node('jaReplacementPin').value = 'A7!Q';
  node('jaReplacementPin').handlers.input();
  assert.equal(workspace.dirty(), true);
  await node('jaSave').handlers.click();

  const save = calls.find(({ options }) => options?.method === 'PUT');
  assert.equal(JSON.parse(save.options.body).replacementPin, 'A7!Q');
  assert.equal(node('jaReplacementPin').value, '');
  assert.match(node('jaReplacementPinState').textContent, /Configured/);
  assert.equal(JSON.stringify(state).includes('A7!Q'), false);
});

test('planner preserves expanded sections and availability scroll across selections, phases and saves', async () => {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', handlers: {}, open: false, scrollTop: 0,
      setAttribute() {}, addEventListener(name, fn) { this.handlers[name] = fn; } });
    return nodes.get(id);
  };
  Object.defineProperty(node('jaContent'), 'innerHTML', {
    set(html) {
      for (const id of ['jaRings', 'jaAvailability']) {
        node(id).open = html.includes(`<details id="${id}" open>`);
      }
      node('jaAvailabilityList').scrollTop = 0;
    }
  });
  const empty = (discipline) => ({ discipline, rings: [], available: [], arbitrators: [], assignments: {} });
  let state = { revision: null, sourceRevision: 's1', configurationLocked: false, rings: ['A1', 'A2'],
    phases: { P1: empty('black-belt'), P2: empty('gup') },
    judges: ['ONE', 'TWO'].map((id) => ({ id, name: id, potential: false, sources: ['volunteer'],
      roles: { corner: true, sktk: true }, certification: 'CORNER' })) };
  const workspace = create({ document: { getElementById: node }, selectedEvent: () => 'Event', confirm: () => true,
    request: async (_url, options) => {
      if (options?.method === 'PUT') state = { ...state, revision: 'saved', phases: JSON.parse(options.body).phases };
      return structuredClone(state);
    } });
  await workspace.load();
  assert.equal(node('jaRings').open, false);
  node('jaRings').open = true;
  node('jaAvailability').open = true;
  node('jaAvailabilityList').scrollTop = 235;
  const change = (attribute, value) => node('jaContent').handlers.change({
    target: { checked: true, getAttribute: (name) => name === attribute ? value : null }
  });
  for (const ring of ['A1', 'A2']) {
    change('data-ja-ring', ring);
    assert.equal(node('jaRings').open, true);
    assert.equal(node('jaAvailability').open, true);
  }
  for (const member of ['ONE', 'TWO']) {
    change('data-ja-available', member);
    assert.equal(node('jaAvailability').open, true);
    assert.equal(node('jaAvailabilityList').scrollTop, 235);
  }
  node('jaPhase').value = 'P2'; node('jaPhase').handlers.change();
  assert.equal(node('jaRings').open, true);
  assert.equal(node('jaAvailability').open, true);
  node('jaRings').open = false;
  await node('jaSave').handlers.click();
  assert.equal(node('jaRings').open, false, 'a deliberately closed section stays closed');
  assert.equal(node('jaAvailability').open, true);
  assert.equal(node('jaAvailabilityList').scrollTop, 235);
  assert.deepEqual(state.phases.P1.rings, ['A1', 'A2']);
  assert.deepEqual(state.phases.P1.available, ['ONE', 'TWO']);
  assert.deepEqual(state.phases.P2.available, []);
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

test('planner search is display-only, counts confirmed availability, supports persistent multiple reserves and explicit draft saves', async () => {
  const nodes = new Map(), calls = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', handlers: {},
      setAttribute(name, value) { this[name] = value; }, addEventListener(name, fn) { this.handlers[name] = fn; } });
    return nodes.get(id);
  };
  const phase = () => ({ discipline: 'gup', rings: [], available: ['ONE', 'TWO'], arbitrators: [], assignments: {} });
  let state = { revision: 'v1', sourceRevision: 's1', configurationLocked: false, rings: ['A1', 'A2'],
    phases: { P1: phase(), P2: phase() }, judges: ['ONE', 'TWO'].map((id) => ({
      id, associationId: id, name: `<${id}>`, sources: ['volunteer'], rank: 'D5', certification: 'REGIONAL',
      roles: { corner: true, sktk: true, center: true, arbitrator: true }
    })) };
  const workspace = create({ document: { getElementById: node }, selectedEvent: () => 'Event', confirm: () => true,
    request: async (url, options) => {
      calls.push({ url, options });
      if (options) state = { ...state, revision: 'v2', phases: JSON.parse(options.body).phases };
      return structuredClone(state);
    } });
  await workspace.load();
  assert.equal(node('jaSave').disabled, true);
  node('jaSearch').value = 'ONE'; node('jaSearch').handlers.input();
  assert.match(node('jaCandidateCount').textContent, /1 of 2 candidates shown; 2 confirmed available/);
  assert.equal(workspace.dirty(), false);
  assert.match(node('jaContent').innerHTML, /&lt;ONE&gt; \(ONE; REGIONAL\)/, 'reserves show name and Association ID');
  const reserve = (id, checked = true) => node('jaContent').handlers.change({ target: {
    checked, getAttribute: (name) => name === 'data-ja-arbitrator' ? id : null
  } });
  node('jaArbitrators').open = true;
  node('jaArbitratorList').scrollTop = 90;
  reserve('ONE'); reserve('ONE'); reserve('TWO');
  assert.equal(node('jaSave')['data-unsaved'], 'true');
  assert.equal(node('jaSave').disabled, false);
  assert.match(node('jaSaveState').textContent, /Unsaved changes/);
  assert.match(node('jaContent').innerHTML, /id="jaArbitrators" open/);
  assert.equal(node('jaArbitratorList').scrollTop, 90);
  await node('jaSave').handlers.click();
  assert.deepEqual(state.phases.P1.arbitrators, ['ONE', 'TWO'], 'no duplicate reservations');
  assert.deepEqual(state.phases.P2.arbitrators, []);
  assert.equal(node('jaSave')['data-unsaved'], 'false');
  assert.match(node('jaSaveState').textContent, /All assignment changes saved/);
  reserve('ONE', false);
  node('jaClearSearch').handlers.click();
  assert.match(node('jaCandidateCount').textContent, /2 of 2 candidates/);
  const click = (attribute) => node('jaContent').handlers.click({ target: {
    hasAttribute: (name) => name === attribute, getAttribute: () => null
  } });
  click('data-ja-all-rings');
  await node('jaSave').handlers.click();
  assert.deepEqual(state.phases.P1.rings, ['A1', 'A2']);
  assert.deepEqual(state.phases.P1.arbitrators, ['TWO']);
  click('data-ja-clear-rings');
  await node('jaSave').handlers.click();
  assert.deepEqual(state.phases.P1.rings, []);
  assert.deepEqual(state.phases.P1.available, ['ONE', 'TWO']);
  assert.equal(calls.filter((call) => call.options).length, 3, 'only explicit saves write');
});

test('lifecycle tables share bounded sticky whole headers without overlapping Ring Judges filter rows', () => {
  const fs = require('node:fs'), path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'tournament-management', 'index.html'), 'utf8');
  const styles = html.match(/<style id="judgeWorkspaceStyles">([\s\S]*?)<\/style>/)[1];
  for (const id of ['judgeManagementView', 'volunteersView', 'ringJudgesView', 'judgeAssignmentsView']) {
    assert.ok(styles.includes(`#${id} .table-wrap thead`));
    assert.ok(styles.includes(`#${id} .table-wrap th`));
  }
  assert.match(styles, /thead \{ position: sticky; top: 0;/);
  assert.match(styles, /th \{ position: static;/);
  assert.match(styles, /@media print.*max-height: none; overflow: visible;/);
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
test('service review filters retain original action indexes and independent planned/actual counts', async () => {
  const fixture = reviewFixture(), nodes = new Map(), opened = [], calls = [];
  fixture.directory.experience = [{ judgeId: 3, eventId: 'simulation-event:Review', eventName: fixture.config.name,
    eventDate: fixture.config.date, eventScope: 'REGIONAL', phase: 'P2', role: 'TIMEKEEPER', logVerified: false }];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', handlers: {}, setAttribute() {},
      addEventListener(name, fn) { this.handlers[name] = fn; } });
    return nodes.get(id);
  };
  const workspace = createServiceReview({ document: { getElementById: node }, selectedEvent: () => 'Review',
    beginService: async (seed) => opened.push(seed), viewExperience() {},
    request: async (url, options) => {
      calls.push({ url, options });
      return structuredClone(url === '/api/simulation/events' ? { events: [fixture.config] }
        : url === '/api/judge-management' ? fixture.directory : fixture.plan);
    } });
  await workspace.load();
  node('srSearch').value = 'MEMBER3'; node('srSearch').handlers.input();
  node('srPhase').value = 'P2'; node('srPhase').handlers.change();
  assert.equal(node('srCount').textContent, '1 of 6 planned positions; 1 of 1 actual service records shown');
  assert.match(node('srBody').innerHTML, /data-service-review="5"/);
  assert.doesNotMatch(node('srBody').innerHTML, /data-service-review="0"/);
  await node('srBody').handlers.click({ target: { closest() {
    return { disabled: false, getAttribute: () => '5' };
  } } });
  assert.equal(opened[0].associationId, 'MEMBER3');
  assert.equal(opened[0].phase, 'P2');
  assert.equal(opened[0].role, '', 'SK/TK still requires the actual role');
  node('srSearch').value = 'not-found'; node('srSearch').handlers.input();
  assert.match(node('srBody').innerHTML, /No matching planned service/);
  assert.match(node('srActual').innerHTML, /No matching actual service/);
  node('srClear').handlers.click();
  assert.equal(node('srCount').textContent, '6 of 6 planned positions; 1 of 1 actual service records shown');
  assert.ok(calls.every((call) => call.options === undefined), 'filtering and reviewing do not write service');
});
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
