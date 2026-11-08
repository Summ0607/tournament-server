const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildAudienceMonitor, buildSimulatorAudienceMonitor } = require('../backend/audienceMonitor');
const { buildEstimates } = require('../backend/ringEstimates');
const ui = require('../audience-monitor/monitor');
const visualRules = require('../assets/visual-definitions');
const now = Date.parse('2026-10-25T16:00:00Z');
const windowAt = (minutes) => ({
  earliestAt: new Date(now + Math.max(0, minutes - 2) * 60000).toISOString(),
  expectedAt: new Date(now + minutes * 60000).toISOString(),
  latestAt: new Date(now + (minutes + 2) * 60000).toISOString()
});
function fixture(count = 4) {
  return {
    version: 1, eventName: 'Active tournament', status: 'ready',
    generatedAt: new Date(now).toISOString(), validUntil: new Date(now + 30000).toISOString(),
    rings: Array.from({ length: count }, (_, index) => ({
      ringId: `ring-a-${index + 1}`, ringLabel: `A${index + 1}`,
      divisionNumber: String(20 + index), description: 'Division description',
      status: 'active', overallProgress: 25, completionWindow: windowAt(index + 2),
      phases: [{ key: 'hyungs', label: 'Hyungs', state: 'active', progress: 25 }]
    })),
    upcoming: Array.from({ length: count }, (_, index) => ({
      ringId: `ring-a-${index + 1}`, ringLabel: `A${index + 1}`, divisionNumber: String(40 + index),
      description: 'Upcoming division', position: 1, startWindow: windowAt(index + 3)
    }))
  };
}

test('public projection includes applicable progression and assigned queues, never private operational fields', () => {
  const groups = [20, 22, 24].map((id) => ({
    groupDivisionNumber: id, name: `Division description ${id}`,
    competitors: [{ firstName: 'Private person', dob: '2010-01-01' }]
  }));
  const rings = [{
    ringId: 'ring-a-1', ringLabel: 'A1', groupDivisionNumber: '20',
    queuedGroupDivisionNumbers: ['22'], tabletLabel: 'Secret device', lastHeartbeatAt: new Date(now).toISOString(),
    assignmentStartedAt: new Date(now - 60000).toISOString(),
    phasePlan: { phases: [{ key: 'hyungs', label: 'Hyungs', state: 'active', progress: 20 }] }
  }];
  const before = JSON.stringify(rings);
  const estimates = buildEstimates({ eventName: 'Active', rings, groups, now });
  const snapshot = buildAudienceMonitor({ eventName: 'Active', rings, groups, estimates });
  assert.equal(snapshot.rings[0].status, 'active');
  assert.equal(snapshot.rings[0].phases[0].label, 'Hyungs');
  assert.equal(snapshot.upcoming[0].divisionNumber, '22');
  assert.equal(snapshot.upcoming[0].description, 'Division description 22');
  assert.ok(snapshot.upcoming[0].startWindow);
  assert.ok(snapshot.rings[0].completionWindow);
  assert.equal(snapshot.rings[0].overallProgress, estimates.rings[0].current.progressPercent);
  assert.equal(snapshot.upcoming.length, 1, 'Unassigned division 24 is not an audience promise');
  assert.doesNotMatch(JSON.stringify(snapshot), /Private person|Secret device|dob|competitors|assistanceType|tabletLabel/);
  assert.equal(JSON.stringify(rings), before);
  assert.equal(ui.validate(snapshot), snapshot);
  for (const [change, status] of [[{ assistanceType: 'medical' }, 'paused'], [{ lastHeartbeatAt: '' }, 'updates-unavailable']]) {
    const modified = [{ ...rings[0], ...change }];
    const result = buildAudienceMonitor({ eventName: 'Active', rings: modified, groups,
      estimates: buildEstimates({ eventName: 'Active', rings: modified, groups, now }) });
    assert.equal(result.rings[0].status, status);
    assert.equal(result.rings[0].overallProgress, null);
    assert.equal(result.upcoming[0].startWindow, null);
  }
});

test('audience descriptions display Special Dragons without rewriting saved names', () => {
  const groups = [{ groupDivisionNumber: 20, name: 'Special Needs Male Gup', competitors: [] }];
  const rings = [{ ringId: 'ring-a-1', ringLabel: 'A1', groupDivisionNumber: '20' }];
  const result = buildAudienceMonitor({ eventName: 'Event', groups, rings,
    estimates: { rings: [], generatedAt: new Date(now).toISOString(), validUntil: new Date(now + 30000).toISOString() } });
  assert.equal(result.rings[0].description, 'Special Dragons Male Gup');
  assert.equal(groups[0].name, 'Special Needs Male Gup');
});

test('simulator Audience View estimates queued start from remaining active phase time', () => {
  const simulatedAt = '2000-01-01T00:00:00.000Z';
  const workspace = {
    manifest: {
      runId: '12345678-run',
      sourceEventName: 'Simulation event',
      status: 'running',
      speed: 20,
      startAt: simulatedAt,
      state: {
        simulatedAt,
        rings: [{
          ringId: 'ring-a-1',
          state: 'running',
          currentGroupNumber: '10',
          currentPhase: 'setup',
          currentPhaseProgress: 50,
          phaseDurationsMs: {
            setup: 60_000,
            hyungs: 120_000,
            sparring: 180_000,
            awards: 60_000
          }
        }]
      }
    },
    groups: [
      { groupDivisionNumber: '10', name: 'Active division', competitors: [] },
      { groupDivisionNumber: '11', name: 'Queued division', competitors: [] }
    ],
    assignments: {
      rings: {
        'ring-a-1': {
          ringLabel: 'A1',
          groupDivisionNumber: '10',
          queuedGroupDivisionNumbers: ['11']
        }
      }
    }
  };

  const snapshot = buildSimulatorAudienceMonitor(workspace, now);
  const expectedMs = now + 21_000;
  const uncertaintyMs = 2_100;
  assert.equal(snapshot.upcoming.length, 1);
  assert.deepEqual(snapshot.upcoming[0].startWindow, {
    earliestAt: new Date(expectedMs - uncertaintyMs).toISOString(),
    expectedAt: new Date(expectedMs).toISOString(),
    latestAt: new Date(expectedMs + uncertaintyMs).toISOString()
  });
  assert.equal(snapshot.upcoming[0].divisionNumber, '11');
  assert.equal(snapshot.rings[0].overallProgress, 25, 'Setup and awards use their saved simulated durations');
  assert.equal(Date.parse(snapshot.rings[0].completionWindow.expectedAt), expectedMs - 1500,
    'Finish does not include the 30 simulated seconds between divisions');
  workspace.manifest.state.rings[0].phaseDurationsMs.awards = 180_000;
  assert.equal(buildSimulatorAudienceMonitor(workspace, now).rings[0].overallProgress, 12.5,
    'Longer awards phase changes overall progress; phases are not equally weighted');
  workspace.manifest.status = 'paused';
  const paused = buildSimulatorAudienceMonitor(workspace, now);
  assert.equal(paused.rings[0].overallProgress, null);
  assert.equal(paused.rings[0].completionWindow, null);
});

test('pagination capacity, stable refresh order, queue ordering and date windows are deterministic', () => {
  assert.deepEqual(ui.capacity(660, 310, 146), { columns: 2, count: 4 });
  assert.deepEqual(ui.capacity(320, 146, 146), { columns: 1, count: 1 });
  assert.deepEqual(ui.capacity(1820, 400, 80, 760), { columns: 2, count: 8 });
  assert.deepEqual(ui.capacity(1253, 238, 80, 540), { columns: 2, count: 4 });
  assert.deepEqual(ui.capacity(1820, 320, 80, 540), { columns: 3, count: 9 });
  const snapshot = fixture(12);
  const sorted = snapshot.rings.slice().reverse().sort(ui.ringOrder);
  assert.equal(sorted[1].ringLabel, 'A2');
  const old = snapshot.upcoming;
  const newOrder = old.slice().reverse();
  assert.deepEqual(ui.reconcile(old, newOrder).map(ui.key), old.map(ui.key));
  assert.deepEqual(newOrder.sort(ui.upcomingOrder), old);
  assert.equal(ui.fresh(snapshot, now + 29999), true);
  assert.equal(ui.fresh(snapshot, now + 30000), false);
  assert.equal(ui.fresh(snapshot, now - 60000), false);
  assert.equal(ui.windowText(null), 'Start TBD');
  assert.notEqual(ui.windowText(windowAt(3), true), ui.windowText(windowAt(3)));
  assert.equal(ui.validWindow({ ...windowAt(3), expectedAt: 'invalid' }), false);
  assert.match(ui.windowText(windowAt(24 * 60)), /^~/);
  assert.doesNotMatch(ui.windowText(windowAt(24 * 60)), /Oct 26|,/);
  assert.throws(() => ui.validate({ ...snapshot, version: 2 }), /Invalid/);
  assert.throws(() => ui.validate({ ...snapshot, upcoming: null }), /Invalid/);
  assert.throws(() => ui.validate({ ...snapshot, validUntil: snapshot.generatedAt }), /Invalid/);
  assert.throws(() => ui.validate({ ...snapshot, rings: [{ ...snapshot.rings[0], overallProgress: 101 }] }), /Invalid/);
  const later = { ...old[0], divisionNumber: '100', position: 2, startWindow: windowAt(0) };
  assert.equal([later, old[1]].sort(ui.upcomingOrder)[0], old[1], 'Every next division precedes later queue entries');
});

async function harness(initial = fixture(), { palette = visualRules.defaults(), paletteFailure = false } = {}) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      textContent: '', innerHTML: '', style: {}, clientWidth: 320, clientHeight: id === 'rings' ? 64 : 136,
      handlers: {}, attributes: {}, value: '', options: [],
      addEventListener(name, callback) { this.handlers[name] = callback; },
      setAttribute(name, value) { this.attributes[name] = value; },
      replaceChildren(...children) { this.options = children; },
      append(child) { this.options.push(child); }
    });
    return nodes.get(id);
  };
  let time = now;
  let payload = initial;
  let simulatorPayload = initial;
  let simulatorRuns = [];
  let fail = false;
  const intervals = [];
  const timeouts = new Map();
  let timerId = 0;
  const requests = [];
  const errors = [];
  const context = vm.createContext({
    Date: class extends Date { static now() { return time; } },
    URLSearchParams,
    window: { location: { search: '' } },
    AbortController, AbortSignal, VisualDefinitionRules: visualRules,
    console: { error: (...args) => errors.push(args) },
    document: {
      getElementById: node, querySelector: () => node('display'), hidden: false,
      createElement: () => ({ value: '', textContent: '' }),
      documentElement: { style: { setProperty(name, value) { node('palette').style[name] = value; } },
        requestFullscreen: async () => { throw new Error('Denied'); } }
    },
    ResizeObserver: class { observe() {} },
    setTimeout: (callback, delay) => { timeouts.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id) => timeouts.delete(id),
    setInterval: (callback, delay) => intervals.push({ callback, delay }),
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === '/api/visual-definitions') return paletteFailure
        ? { ok: false, status: 500 } : { ok: true, json: async () => ({ values: palette }) };
      if (fail) return { ok: false, status: 503 };
      if (url === '/api/simulator/runs') return { ok: true, json: async () => ({ runs: simulatorRuns }) };
      if (url.includes('/audience')) return { ok: true, json: async () => simulatorPayload };
      return { ok: true, json: async () => payload };
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'audience-monitor', 'monitor.js'), 'utf8'), context);
  const settle = () => new Promise(setImmediate);
  await settle();
  return {
    node, requests, errors,
    payload: (value) => { payload = value; },
    simulator: (runs, value) => { simulatorRuns = runs; simulatorPayload = value; },
    fail: (value) => { fail = value; },
    tick: async (delay) => { intervals.find((timer) => timer.delay === delay).callback(); await settle(); },
    advance: async (ms) => { time += ms; intervals.find((timer) => timer.delay === 1000).callback(); await settle(); },
    refresh: async () => {
      const [id, timer] = [...timeouts].find(([, entry]) => entry.delay === ui.REFRESH_MS);
      timeouts.delete(id);
      await timer.callback();
      await settle();
    },
    click: async (id) => { await node(id).handlers.click({ currentTarget: node(id) }); await settle(); },
    selectRun: async (runId) => {
      node('sourceRun').value = runId;
      await node('sourceRun').handlers.change();
      await settle();
    }
  };
}

test('monitor applies saved palette colors without changing layout and reports palette loading errors', async () => {
  const page = await harness(fixture(), { palette: { ...visualRules.defaults(), primary: '#123456', text: '#223344' } });
  assert.equal(page.node('palette').style['--audience-primary'], '#123456');
  assert.equal(page.node('palette').style['--audience-text'], '#223344');
  assert.equal(page.node('paletteStatus').hidden, true);
  assert.ok(Object.keys(page.node('palette').style).every((key) => key.startsWith('--audience-')));
  const failed = await harness(fixture(), { paletteFailure: true });
  assert.equal(failed.node('paletteStatus').hidden, false);
  assert.match(failed.node('paletteStatus').textContent, /Saved display colors unavailable.*built-in palette/);
  assert.match(failed.node('rings').innerHTML, /Ring A1/);
  assert.equal(failed.errors.length, 1);
  const invalid = await harness(fixture(), { palette: { ...visualRules.defaults(), primary: 'invalid' } });
  assert.match(invalid.node('paletteStatus').textContent, /Invalid Primary buttons/);
});

test('display rotates independently, wraps, pauses, preserves pages on refresh, and resets on event switch', async () => {
  const page = await harness();
  assert.match(page.node('rings').innerHTML, /Ring A1/);
  assert.match(page.node('rings').innerHTML, /class="ring-label">Ring A1/);
  assert.match(page.node('rings').innerHTML, /role="meter"[^>]*aria-valuenow="25"/);
  assert.match(page.node('rings').innerHTML, /Est\. finish/);
  assert.doesNotMatch(page.node('rings').innerHTML, /Hyungs|25%<\/|class="phase /);
  assert.doesNotMatch(page.node('rings').innerHTML, /class="badge"|>Waiting<|>In progress</);
  assert.match(page.node('upcoming').innerHTML, /Division 40/);
  assert.match(page.node('upcoming').innerHTML, /<strong class="ring-label">Ring A1<\/strong>/);
  assert.doesNotMatch(page.node('upcoming').innerHTML, /queue-position|Queue \d/);
  assert.match(page.node('upcoming').innerHTML, /class="division"[\s\S]*class="description"[\s\S]*Est\. start/);
  assert.doesNotMatch(page.node('upcoming').innerHTML, /Ring A1 &middot; Queue/);
  assert.equal(page.node('ringsPages').textContent, 'Page 1 of 4');
  await page.tick(ui.ROTATE_MS);
  assert.match(page.node('rings').innerHTML, /Ring A2/);
  assert.match(page.node('upcoming').innerHTML, /Division 41/);
  const updated = fixture();
  updated.upcoming[3].startWindow = windowAt(0);
  page.payload(updated);
  await page.refresh();
  assert.match(page.node('upcoming').innerHTML, /Division 41/, 'Refreshing does not reorder the row being read');
  assert.equal(page.node('ringsPages').textContent, 'Page 2 of 4');
  await page.click('pause');
  await page.tick(ui.ROTATE_MS);
  assert.match(page.node('rings').innerHTML, /Ring A2/);
  assert.equal(page.node('pause').attributes['aria-pressed'], 'true');
  await page.click('pause');
  await page.tick(ui.ROTATE_MS);
  await page.tick(ui.ROTATE_MS);
  await page.tick(ui.ROTATE_MS);
  assert.match(page.node('rings').innerHTML, /Ring A1/);
  page.payload({ ...fixture(), eventName: 'New active event' });
  await page.refresh();
  assert.equal(page.node('eventName').textContent, 'New active event');
  assert.equal(page.node('ringsPages').textContent, 'Page 1 of 4');
  assert.ok(page.requests.some((request) => request.url === '/api/rings/monitor'));
  assert.ok(page.requests.some((request) => request.url === '/api/simulator/runs'));
});

test('display suppresses stale and failed data, recovers, escapes descriptions and reports fullscreen errors', async () => {
  const snapshot = fixture();
  snapshot.rings[0].description = '<img src=x onerror=alert(1)>';
  const page = await harness(snapshot);
  assert.match(page.node('rings').innerHTML, /&lt;img/);
  assert.doesNotMatch(page.node('rings').innerHTML, /<img/);
  await page.advance(31000);
  assert.match(page.node('connection').textContent, /stale/);
  assert.doesNotMatch(page.node('rings').innerHTML, /role="meter"|Est\. finish/);
  assert.doesNotMatch(page.node('upcoming').innerHTML, /Est\. start/);
  page.payload({ ...fixture(), generatedAt: new Date(now + 31000).toISOString(), validUntil: new Date(now + 61000).toISOString() });
  await page.refresh();
  assert.match(page.node('rings').innerHTML, /role="meter"/);
  page.fail(true);
  await page.refresh();
  assert.match(page.node('connection').textContent, /503/);
  assert.match(page.node('upcoming').innerHTML, /unavailable/);
  assert.equal(page.errors.length, 1);
  await page.click('fullscreen');
  assert.match(page.node('connection').textContent, /Fullscreen unavailable/);
});

test('header shows a running current-time clock', async () => {
  const page = await harness();
  const before = page.node('clock').textContent;
  assert.match(before, /\d{1,2}:\d{2}:\d{2}/);
  await page.advance(61000);
  assert.notEqual(page.node('clock').textContent, before);
  const markup = fs.readFileSync(path.join(__dirname, '..', 'audience-monitor', 'index.html'), 'utf8');
  assert.match(markup, /<time id="clock" class="clock" aria-label="Current time">/);
});

test('one-page content does not rotate and no-active-event response has an explicit waiting state', async () => {
  const page = await harness(fixture(1));
  const before = page.node('rings').innerHTML;
  await page.tick(ui.ROTATE_MS);
  assert.equal(page.node('rings').innerHTML, before);
  assert.equal(page.node('ringsPages').textContent, '');
  page.payload({ ...fixture(0), eventName: null, status: 'unavailable' });
  await page.refresh();
  assert.match(page.node('connection').textContent, /Waiting for an active event/);
  assert.match(page.node('rings').innerHTML, /unavailable/);
});

test('upper and lower sections use different capacities and wrap independently', async () => {
  const page = await harness();
  page.node('rings').clientHeight = 232;
  await page.click('pause');
  assert.equal(page.node('ringsPages').textContent, 'Page 1 of 2 - paused');
  assert.equal(page.node('upcomingPages').textContent, 'Page 1 of 4 - paused');
  await page.click('pause');
  await page.tick(ui.ROTATE_MS);
  assert.match(page.node('rings').innerHTML, /Ring A3/);
  assert.match(page.node('upcoming').innerHTML, /Division 41/);
  await page.tick(ui.ROTATE_MS);
  assert.match(page.node('rings').innerHTML, /Ring A1/);
  assert.match(page.node('upcoming').innerHTML, /Division 42/);
  page.payload(fixture(1));
  await page.refresh();
  assert.equal(page.node('ringsPages').textContent, '');
  assert.equal(page.node('upcomingPages').textContent, '');
  assert.match(page.node('upcoming').innerHTML, /Division 40/);
});

test('paused rings and unavailable start windows stay explicit without displaying old progression', async () => {
  const snapshot = fixture(1);
  snapshot.rings[0].status = 'paused';
  snapshot.upcoming[0].startWindow = null;
  const page = await harness(snapshot);
  assert.match(page.node('rings').innerHTML, /Temporarily paused/);
  assert.match(page.node('rings').innerHTML, /class="ring-status"/);
  assert.doesNotMatch(page.node('rings').innerHTML, /role="meter"|~\d/);
  assert.match(page.node('upcoming').innerHTML, /Not available/);
  const invalid = fixture();
  invalid.rings[0].phases[0].progress = NaN;
  page.payload(invalid);
  await page.refresh();
  assert.match(page.node('connection').textContent, /Invalid audience monitor rows/);
  assert.doesNotMatch(page.node('upcoming').innerHTML, /Division 40/);
});

test('only active divisions appear in the upper panel and overall progress is never fabricated', async () => {
  const snapshot = fixture(1);
  snapshot.rings[0] = { ...snapshot.rings[0], divisionNumber: null, description: '', status: 'waiting', phases: [] };
  const page = await harness(snapshot);
  assert.match(page.node('rings').innerHTML, /No current division/);
  assert.doesNotMatch(page.node('rings').innerHTML, /role="meter"/);
  const groups = [{ groupDivisionNumber: 22, name: 'Queued weapons division', competitors: [] }];
  const rings = [{
    ringId: 'ring-a-1', ringLabel: 'A1', queuedGroupDivisionNumbers: ['22'],
    queuedPhasePlan: { groupDivisionNumber: '22', phases: [
      { key: 'setup', label: 'Setup' }, { key: 'weapons', label: 'Weapons' },
      { key: 'hyungs', label: 'Hyungs' }, { key: 'sparring', label: 'Sparring' }, { key: 'awards', label: 'Awards' }
    ] }
  }];
  const projected = buildAudienceMonitor({ eventName: 'Active', rings, groups,
    estimates: buildEstimates({ eventName: 'Active', rings, groups, now }) });
  assert.equal(projected.rings[0].queuedDivisionNumber, '22');
  assert.equal(projected.rings[0].queuedDescription, 'Queued weapons division');
  assert.equal(projected.rings[0].phases.length, 5);
  assert.ok(projected.rings[0].phases.every((phase) => phase.state === 'upcoming' && phase.progress === 0));
  page.payload(projected);
  await page.refresh();
  assert.doesNotMatch(page.node('rings').innerHTML, /Division 22|Weapons|role="meter"/);
  assert.match(page.node('upcoming').innerHTML, /Division 22/);
  page.payload(fixture(1));
  await page.refresh();
  assert.match(page.node('rings').innerHTML, /role="meter"[\s\S]*style="width:25%"/);
  const missingProgress = fixture(1);
  missingProgress.rings[0].overallProgress = null;
  missingProgress.rings[0].completionWindow = null;
  page.payload(missingProgress);
  await page.refresh();
  assert.match(page.node('rings').innerHTML, /Progress unavailable/);
  assert.match(page.node('rings').innerHTML, /Not available/);
  assert.doesNotMatch(page.node('rings').innerHTML, /role="meter"/);
  const unavailable = fixture(1);
  unavailable.rings[0].status = 'updates-unavailable';
  page.payload(unavailable);
  await page.refresh();
  assert.match(page.node('rings').innerHTML, /class="ring-status">Updates unavailable/);
  assert.doesNotMatch(page.node('rings').innerHTML, /role="meter"|~\d/);
});

test('eight rings remain visible and stationary at desktop capacity while added rings retain natural order', async () => {
  const page = await harness(fixture(8));
  page.node('rings').clientWidth = 1820;
  page.node('rings').clientHeight = 400;
  await page.click('pause');
  assert.equal((page.node('rings').innerHTML.match(/class="card ring-card"/g) || []).length, 8);
  assert.equal(page.node('ringsPages').textContent, '');
  const before = page.node('rings').innerHTML;
  await page.click('pause');
  await page.tick(ui.ROTATE_MS);
  assert.equal(page.node('rings').innerHTML, before);
  page.payload(fixture(9));
  await page.refresh();
  assert.match(page.node('rings').innerHTML, /Ring A1[\s\S]*Ring A2[\s\S]*Ring A8/);
});

test('ordinary desktop widths show two compact ring columns with matching rotation capacity', async () => {
  const page = await harness(fixture(8));
  page.node('rings').clientWidth = 1253;
  page.node('rings').clientHeight = 238;
  await page.click('pause');
  assert.equal(page.node('rings').style.gridTemplateColumns, 'repeat(2, minmax(0, 1fr))');
  assert.equal((page.node('rings').innerHTML.match(/class="card ring-card"/g) || []).length, 4);
  assert.equal(page.node('ringsPages').textContent, 'Page 1 of 2 - paused');
  await page.click('pause');
  await page.tick(ui.ROTATE_MS);
  assert.match(page.node('rings').innerHTML, /Ring A5/);
  assert.equal(page.node('ringsPages').textContent, 'Page 2 of 2');
});

test('audience monitor offers simulator selection without changing its default active-event source', async () => {
  const page = await harness();
  assert.equal(page.node('sourceRun').value, '');
  assert.ok(page.requests.some((request) => request.url === '/api/rings/monitor'));
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'audience-monitor', 'index.html'), 'utf8'), /id="sourceRun"/);
});

test('selected simulator run loads its isolated snapshot and labels the display as simulation', async () => {
  const simulated = fixture(1);
  simulated.source = 'simulator';
  simulated.eventName = 'SIMULATION · Saved tournament · abcdef12';
  simulated.simulatorStatus = 'running';
  simulated.simulatedAt = '2000-01-01T01:00:00.000Z';
  const run = { runId: 'abcdef12-0000-4000-8000-000000000001', sourceEventName: 'Saved tournament', status: 'running' };
  const page = await harness();
  page.simulator([run], simulated);
  await page.tick(30000);
  assert.ok(page.node('sourceRun').options.some((option) => option.value === run.runId));
  await page.refresh();
  await page.selectRun(run.runId);
  assert.ok(page.requests.some((request) => request.url === `/api/simulator/runs/${run.runId}/audience`));
  assert.match(page.node('eventName').textContent, /SIMULATION/);
  assert.match(page.node('connection').textContent, /SIMULATION - running/);
  assert.match(page.node('rings').innerHTML, /Ring A1/);
});
