const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const express = require('express');
const { registerPageRoutes } = require('../backend/pages');

function simulatorPageHarness({ runs = [], storage = new Map(), failDelete = '', confirm = () => true,
  serverFetch, page = 'simulator' } = {}) {
  const html = require('node:fs').readFileSync(path.join(__dirname, '..', page, 'index.html'), 'utf8');
  const createNode = () => ({
    value: '', textContent: '', disabled: false, checked: false, hidden: false, options: [], handlers: {},
    addEventListener(name, callback) { this.handlers[name] = callback; },
    setAttribute(name, value) { this[name] = value; },
    replaceChildren() { this.options = []; this.textContent = ''; },
    append(...children) { this.options.push(...children); },
    showModal() { this.open = true; }, close() { this.open = false; }, focus() {}
  });
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, createNode()]));
  const requests = [];
  let reloads = 0;
  const context = vm.createContext({
    document: { getElementById: (id) => nodes.get(id), createElement: createNode },
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key) },
    setInterval: () => 1, clearInterval() {}, confirm,
    setTimeout: (callback) => { callback(); }, AbortSignal,
    location: { reload() { reloads += 1; } },
    fetch: async (url, options = {}) => {
      requests.push({ url, method: options.method });
      if (serverFetch && url.startsWith('/api/server-control/')) return serverFetch(url, options);
      const id = decodeURIComponent(url.split('/').pop());
      if (options.method === 'DELETE' && id === failDelete) {
        return { ok: false, status: 500, json: async () => ({ error: 'Deletion failed' }) };
      }
      if (options.method === 'DELETE') runs = runs.filter((run) => run.runId !== id);
      const data = url === '/api/simulator/runs' ? { runs }
        : url === '/api/events/list' ? { events: ['Source'] }
          : url === '/api/events/active' ? { activeEvent: 'Source' }
            : runs.find((run) => run.runId === id) || {};
      return { ok: true, json: async () => data };
    }
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  return { nodes, requests, context, storage, reloads: () => reloads };
}

test('server restart dialog requires typed confirmation, supports cancel, and waits for a new instance', async () => {
  let requested = false;
  let polls = 0;
  const { nodes, requests, reloads } = simulatorPageHarness({
    page: 'admin',
    serverFetch: async (url, options) => {
      if (url.endsWith('/restart')) {
        assert.equal(options.headers['X-Server-Control-Token'], 'test-token');
        assert.equal(JSON.parse(options.body).confirmation, 'RESTART');
        requested = true;
        return { ok: true, json: async () => ({ restarting: true }) };
      }
      if (requested) {
        polls += 1;
        if (polls === 1) throw new Error('Connection refused');
      }
      return { ok: true, json: async () => ({ restartAvailable: true, token: 'test-token',
        instanceId: polls > 2 ? 'new-instance' : 'old-instance', restarting: requested && polls === 2,
        message: 'Managed launcher connected.' }) };
    }
  });
  await new Promise(setImmediate);
  assert.equal(nodes.get('restartServerButton').disabled, false);
  nodes.get('restartServerButton').handlers.click();
  assert.equal(nodes.get('restartServerDialog').open, true);
  nodes.get('cancelRestartButton').handlers.click();
  assert.equal(nodes.get('restartServerDialog').open, false);
  assert.equal(requests.some((request) => request.url.endsWith('/restart')), false);
  nodes.get('restartServerButton').handlers.click();
  nodes.get('restartConfirmation').value = 'restart';
  nodes.get('restartConfirmation').handlers.input();
  assert.equal(nodes.get('confirmRestartButton').disabled, true);
  await nodes.get('confirmRestartButton').handlers.click();
  assert.equal(requested, false);
  nodes.get('restartConfirmation').value = 'RESTART';
  nodes.get('restartConfirmation').handlers.input();
  assert.equal(nodes.get('confirmRestartButton').disabled, false);
  await nodes.get('confirmRestartButton').handlers.click();
  assert.equal(polls, 3);
  assert.equal(reloads(), 1);
});

test('server restart handles unavailability, rejected requests and reconnection timeout explicitly', async () => {
  for (const mode of ['unavailable', 'rejected', 'timeout']) {
    const { nodes, reloads } = simulatorPageHarness({
      page: 'admin',
      serverFetch: async (url) => {
        if (url.endsWith('/restart')) return {
          ok: mode !== 'rejected', json: async () => ({ error: 'Restart refused' })
        };
        return { ok: true, json: async () => ({ restartAvailable: mode !== 'unavailable',
          token: 'token', instanceId: 'old-instance', message: 'Use managed launcher.' }) };
      }
    });
    await new Promise(setImmediate);
    if (mode === 'unavailable') {
      assert.equal(nodes.get('restartServerButton').disabled, true);
      assert.match(nodes.get('serverControlStatus').textContent, /managed launcher/);
    } else {
      nodes.get('restartServerButton').handlers.click();
      nodes.get('restartConfirmation').value = 'RESTART';
      await nodes.get('confirmRestartButton').handlers.click();
      assert.match(nodes.get('serverControlStatus').textContent,
        mode === 'rejected' ? /Restart refused/ : /Restart has not completed/);
      assert.equal(nodes.get('refreshServerStatusButton').disabled, false);
    }
    assert.equal(reloads(), 0);
  }
});

test('simulator history and recent events start minimized, expand independently and remember their state', async () => {
  const storage = new Map();
  const { nodes } = simulatorPageHarness({ storage });
  await new Promise(setImmediate);
  assert.equal(nodes.has('restartServerButton'), false);
  assert.equal(nodes.get('savedRunsContent').hidden, true);
  assert.equal(nodes.get('recentEventsContent').hidden, true);
  assert.equal(nodes.get('toggleRunsButton').textContent, 'Expand');
  nodes.get('toggleRunsButton').handlers.click();
  assert.equal(nodes.get('savedRunsContent').hidden, false);
  assert.equal(nodes.get('toggleRunsButton')['aria-expanded'], 'true');
  assert.equal(nodes.get('recentEventsContent').hidden, true);
  const reloaded = simulatorPageHarness({ storage }).nodes;
  assert.equal(reloaded.get('savedRunsContent').hidden, false);
  assert.equal(reloaded.get('recentEventsContent').hidden, true);
  reloaded.get('toggleEventsButton').handlers.click();
  assert.equal(reloaded.get('recentEventsContent').hidden, false);
  assert.equal(reloaded.get('toggleEventsButton').textContent, 'Minimize');
});

test('admin status check reports a prominent timestamped state', async () => {
  const serverFetch = async () => ({ ok: true, json: async () => ({ restartAvailable: false, token: 't', instanceId: 'i',
    message: 'Start using server-launcher.js.' }) });
  const { nodes } = simulatorPageHarness({ page: 'admin', serverFetch });
  await new Promise(setImmediate);
  assert.equal(nodes.has('toggleServerMaintenanceButton'), false);
  const status = nodes.get('serverControlStatus');
  assert.match(status.textContent, /Checked .* Server is running\. Start using server-launcher\.js\./);
  assert.equal(status['data-state'], 'warn');
  assert.equal(nodes.get('refreshServerStatusButton').disabled, false);
});

test('/admin/ serves the administration page', async () => {
  const response = await requestPath('pre', '/admin/');
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Tournament Administration/);
});

test('simulator bulk deletion excludes running runs, handles partial failures, and clears the viewed run', async () => {
  const runs = [
    { runId: 'old-1', sourceEventName: 'Source', status: 'complete' },
    { runId: 'old-2', sourceEventName: 'Source', status: 'stopped' },
    { runId: 'old-3', sourceEventName: 'Source', status: 'paused' },
    { runId: 'live', sourceEventName: 'Source', status: 'running' }
  ];
  const { nodes, requests, context, storage } = simulatorPageHarness({ runs, failDelete: 'old-2' });
  await new Promise(setImmediate);
  vm.runInContext("selectRun('old-1')", context);
  nodes.get('selectAllRunsButton').handlers.click();
  assert.equal(nodes.get('deleteSelectedRunsButton').textContent, 'Delete selected (3)');
  assert.equal(nodes.get('runHistory').options[3].options[0].disabled, true);
  await nodes.get('deleteSelectedRunsButton').handlers.click();
  assert.deepEqual(requests.filter((request) => request.method === 'DELETE').map((request) => request.url),
    ['/api/simulator/runs/old-1', '/api/simulator/runs/old-2', '/api/simulator/runs/old-3']);
  assert.match(nodes.get('notice').textContent, /Deleted 2 of 3.*old-2: Deletion failed/);
  assert.equal(storage.has('tournament-simulator-current-run'), false);
  assert.equal(nodes.get('runLogContext').textContent, 'No run selected.');
  assert.equal(nodes.get('deleteSelectedRunsButton').textContent, 'Delete selected (1)');
  assert.equal(nodes.get('runHistory').options.length, 2);
  nodes.get('clearRunSelectionButton').handlers.click();
  assert.equal(nodes.get('deleteSelectedRunsButton').disabled, true);
});

test('simulator bulk deletion honors cancellation and rechecks running status', async () => {
  const run = { runId: 'old', sourceEventName: 'Source', status: 'complete' };
  let confirmed = false;
  const { nodes, requests } = simulatorPageHarness({ runs: [run], confirm: () => confirmed });
  await new Promise(setImmediate);
  const checkbox = nodes.get('runHistory').options[0].options[0];
  checkbox.checked = true;
  checkbox.handlers.change();
  await nodes.get('deleteSelectedRunsButton').handlers.click();
  assert.equal(requests.some((request) => request.method === 'DELETE'), false);
  confirmed = true;
  run.status = 'running';
  await nodes.get('deleteSelectedRunsButton').handlers.click();
  assert.equal(requests.some((request) => request.method === 'DELETE'), false);
  assert.match(nodes.get('notice').textContent, /pause or stop it first/);
  assert.equal(nodes.get('runHistory').options[0].options[0].disabled, true);
});

test('recent simulator events separate real timestamps from simulated elapsed time and filter progress', async () => {
  const { nodes, context } = simulatorPageHarness();
  await new Promise(setImmediate);
  const event = { type: 'phase_progress', ringLabel: 'A1', simulatedAt: '2000-01-01T01:02:03Z',
    occurredAt: '2026-10-28T13:00:00Z', progress: 25, phase: 'setup' };
  context.run = { runId: 'selected-run', sourceEventName: 'Morning tournament', diagnostics: {
    virtualTime: { startedAt: '2000-01-01T00:00:00Z' },
    runLog: [event, { ...event, progress: 100 }, { ...event, type: 'operation_failed',
      occurredAt: undefined, message: 'Upload failed' }]
  } };
  vm.runInContext('displayedRun = run; renderRunLog(run)', context);
  assert.match(nodes.get('runLogContext').textContent, /Morning tournament - Run selected-run/);
  assert.equal(nodes.get('runLog').options.length, 2);
  assert.match(nodes.get('runLog').options[0].textContent, /Actual time not recorded.*simulated elapsed 1h 2m 3s.*Upload failed/);
  assert.match(nodes.get('runLog').options[1].textContent, /2026.*100%/);
  nodes.get('showProgressEvents').checked = true;
  nodes.get('showProgressEvents').handlers.change();
  assert.equal(nodes.get('runLog').options.length, 3);
  context.run.diagnostics.runLog = Array.from({ length: 40 }, (_, sequence) =>
    ({ ...event, type: 'division_completed', groupDivisionNumber: sequence + 1 }));
  vm.runInContext('renderRunLog(run)', context);
  assert.equal(nodes.get('runLog').options.length, 30);
  assert.match(nodes.get('runLog').options[0].textContent, /division 40/);
  vm.runInContext("selectRun('another-run')", context);
  assert.equal(nodes.get('runLogContext').textContent, 'No run selected.');
  assert.equal(nodes.get('showProgressEvents').checked, true);
});

test('simulator history loads saved runs, deletes only the selected run and clears stale panels', async () => {
  const html = require('node:fs').readFileSync(path.join(__dirname, '..', 'simulator', 'index.html'), 'utf8');
  const nodes = new Map();
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) {
    nodes.set(id, { value: '', textContent: '', disabled: false, options: [], handlers: {},
      addEventListener(name, callback) { this.handlers[name] = callback; },
      setAttribute(name, value) { this[name] = value; },
      replaceChildren() { this.options = []; },
      append(option) { this.options.push(option); }
    });
  }
  const storage = new Map([['tournament-simulator-current-run', 'missing']]);
  const requests = [];
  let runs = [{ runId: 'old-run', sourceEventName: 'Rehearsal', status: 'complete' }];
  const context = vm.createContext({
    document: { getElementById: (id) => nodes.get(id), createElement: () => ({
      addEventListener() {}, append() {}
    }) },
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key) },
    setInterval: () => 1, clearInterval() {}, confirm: () => true,
    fetch: async (url, options) => {
      requests.push({ url, method: options.method });
      if (options.method === 'DELETE') runs = [];
      const data = url === '/api/simulator/runs' ? { runs }
        : url === '/api/events/list' ? { events: ['Source'] }
          : url === '/api/events/active' ? { activeEvent: 'Source' } : {};
      return { ok: true, json: async () => data };
    }
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  await new Promise(setImmediate);
  assert.equal(storage.has('tournament-simulator-current-run'), false);
  assert.match(nodes.get('notice').textContent, /no longer exists/);
  assert.ok(nodes.get('runSelect').options.some((option) => option.value === 'old-run'));
  vm.runInContext("selectRun('old-run')", context);
  nodes.get('deleteButton').disabled = false;
  for (const id of ['rings', 'availableDivisions', 'runLog']) nodes.get(id).textContent = 'Old run data';
  await nodes.get('deleteButton').handlers.click();
  assert.deepEqual(requests.filter((request) => request.method === 'DELETE'),
    [{ url: '/api/simulator/runs/old-run', method: 'DELETE' }]);
  assert.equal(storage.has('tournament-simulator-current-run'), false);
  for (const id of ['rings', 'availableDivisions', 'runLog']) {
    assert.doesNotMatch(nodes.get(id).textContent, /Old run data/);
  }
  assert.equal(nodes.get('deleteButton').disabled, true);
  assert.equal(nodes.get('runSelect').options.length, 1);
});

function requestPath(activeSurface, requestPathname) {
  return new Promise((resolve, reject) => {
    const app = express();
    const rootDir = path.join(__dirname, '..');
    const controlBoardDir = path.join(rootDir, 'head-table');
    registerPageRoutes(app, rootDir, controlBoardDir, activeSurface);

    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const req = http.get({
        host: '127.0.0.1',
        port,
        path: requestPathname
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          server.close(() => resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body
          }));
        });
      });

      req.on('error', (error) => {
        server.close(() => reject(error));
      });
    });
  });
}

test('progress surfaces redirect legacy aliases to the canonical entry point', async () => {
  const monitoringAlias = await requestPath('monitoring', '/control-board');
  assert.ok([301, 302].includes(monitoringAlias.statusCode));
  assert.equal(monitoringAlias.headers.location, '/event-progress/');

  const adminAlias = await requestPath('adminProgress', '/dashboard');
  assert.ok([301, 302].includes(adminAlias.statusCode));
  assert.equal(adminAlias.headers.location, '/administration-progress/');
});

test('canonical progress routes still serve the page directly', async () => {
  const monitoringPage = await requestPath('monitoring', '/event-progress/');
  assert.equal(monitoringPage.statusCode, 200);
  assert.match(monitoringPage.body, /<!DOCTYPE html>/);

  const adminPage = await requestPath('adminProgress', '/administration-progress/');
  assert.equal(adminPage.statusCode, 200);
  assert.match(adminPage.body, /<!DOCTYPE html>/);
});

test('pre-tournament root opens the integrated interface', async () => {
  const rootPage = await requestPath('pre', '/');
  assert.ok([301, 302].includes(rootPage.statusCode));
  assert.equal(rootPage.headers.location, '/tournament-management/');
});

test('simulator control page is available as an isolated standalone route', async () => {
  const response = await requestPath('pre', '/simulator/');
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Tournament Simulator/);
  assert.match(response.body, /Simulation time scale/);
  assert.match(response.body, /value="10">10× — 10 simulated seconds \/ real second/);
  assert.match(response.body, /value="2">2× — 2 simulated seconds \/ real second/);
  assert.match(response.body, /value="5">5× — 5 simulated seconds \/ real second/);
  assert.match(response.body, /value="20" selected>20× — 20 simulated seconds \/ real second/);
  assert.match(response.body, /value="40">40× — 40 simulated seconds \/ real second/);
  assert.match(response.body, /Queued division/);
  assert.match(response.body, /<h2>Unassigned divisions<\/h2>/);
  assert.match(response.body, /addMetric\(summary, 'Unassigned divisions'/);
  assert.doesNotMatch(response.body, /Available divisions|available divisions/);
  assert.doesNotMatch(response.body, /Pending divisions|Queued divisions/);
  assert.match(response.body, /\/api\/simulator\/runs/);
  assert.match(response.body, /audienceViewLink/);
  assert.match(response.body, /id="headTableLink" href="\/tournament-management\/\?view=head-table"/);
  assert.match(response.body, /simulatorRunId=\$\{encodeURIComponent\(activeRunId\)\}/);
  assert.match(response.body, /Open Head Table/);
  assert.match(response.body, /id="systemClock"[^>]*aria-label="Current local time"/);
  assert.match(response.body, /setInterval\(updateSystemClock, 1000\)/);
  assert.match(response.body, /'Tournament started'/);
  assert.match(response.body, /'Run completed' : 'Estimated Tournament Completion'/);
  assert.match(response.body, /'uploading-report': 'Uploading report'/);
  assert.match(response.body, /'loading-division': 'Loading division'/);
  assert.doesNotMatch(response.body, /ring\.currentPhase \|\| 'Waiting'/);
  assert.match(response.body, /Paused - resume for estimate/);
  assert.doesNotMatch(response.body, /addMetric\(summary, 'Virtual time'/);
});

test('simulator selector displays the saved run speed rather than the markup default', async () => {
  const response = await requestPath('pre', '/simulator/');
  const source = response.body.match(/    function syncRunSpeed\(speed\) \{[\s\S]*?\n    \}/);
  assert.ok(source);
  const select = {
    value: '20',
    options: ['10', '20', '40', '600'].map((value) => ({ value })),
    append(option) { this.options.push(option); }
  };
  const context = vm.createContext({
    $: (id) => {
      assert.equal(id, 'speedSelect');
      return select;
    },
    document: { createElement: () => ({}) }
  });
  vm.runInContext(source[0], context);
  for (const speed of [600, 20, 40, 10, 25, 25]) {
    vm.runInContext(`syncRunSpeed(${speed})`, context);
    assert.equal(select.value, String(speed));
  }
  assert.equal(select.options.filter((option) => option.value === '25').length, 1);
  assert.match(response.body, /function renderRun\(run\) \{\s+if \(!speedChangePending\) syncRunSpeed\(run\.speed\);/);
});

test('audience monitor has standalone routes and assets without replacing legacy progress pages', async () => {
  for (const surface of ['pre', 'monitoring']) {
    const redirect = await requestPath(surface, '/audience-monitor');
    assert.equal(redirect.headers.location, '/audience-monitor/');
    for (const route of ['/audience-monitor/', '/audience-monitor.html', '/audience-monitor/index.html']) {
      const response = await requestPath(surface, route);
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /<h2 id="ringsTitle">Ring Status<\/h2>/);
      assert.match(response.body, /<h2 id="upcomingTitle">On Deck<\/h2>/);
      assert.match(response.body, /id="sourceRun"/);
      assert.doesNotMatch(response.body, /data-ra-reset|data-ht-clear/);
    }
    const script = await requestPath(surface, '/audience-monitor/monitor.js');
    assert.equal(script.statusCode, 200);
    assert.match(script.body, /\/api\/rings\/monitor/);
  }
});

test('retired workflow pages and legacy aliases redirect to matching integrated views', async () => {
  const workflows = [
    { prefixes: ['/tournament-setup', '/tournament-mgmt', '/setup', '/event-administration', '/tournament-setup/event-definition'], view: 'event-setup' },
    { prefixes: ['/tournament-setup/import'], view: 'import' },
    { prefixes: ['/group-builder', '/tournament-setup/build-groups', '/tournament-setup/review-save'], view: 'groups' }
  ];
  for (const { prefixes, view } of workflows) {
    for (const prefix of prefixes) {
      for (const suffix of ['', '/', '.html', '/index.html']) {
        const pathname = prefix + suffix;
        const response = await requestPath('pre', pathname);
        assert.equal(response.statusCode, 302, pathname);
        assert.equal(response.headers.location, `/tournament-management/?view=${view}`, pathname);
      }
    }
  }
  const saved = await requestPath('pre', '/tournament-setup/review-save/?source=saved');
  assert.equal(saved.headers.location, '/tournament-management/?view=groups&source=saved');
  const retiredScript = await requestPath('pre', '/tournament-setup/build-groups/app.js');
  assert.equal(retiredScript.statusCode, 404);
});

test('integrated tournament management is available directly and through workflow URLs', async () => {
  const shellRoot = await requestPath('pre', '/tournament-management');
  assert.ok([301, 302].includes(shellRoot.statusCode));
  assert.equal(shellRoot.headers.location, '/tournament-management/');

  const shellPage = await requestPath('pre', '/tournament-management/');
  assert.equal(shellPage.statusCode, 200);
  assert.match(shellPage.body, /Tournament Management System/);
  assert.match(shellPage.body, /Under Development/);
  assert.match(shellPage.body, /Event Setup/);
  assert.match(shellPage.body, /Selected event metadata/);
  assert.match(shellPage.body, /No event selected/);
  assert.doesNotMatch(shellPage.body, /applyEventRingLayoutBtn|raLayoutBtn|Save &amp; apply ring layout/);
  assert.match(shellPage.body, /id="saveMetadataBtn"/);
  assert.match(shellPage.body, /id="resetRunBtn"/);
  assert.match(shellPage.body, /All settings are locked once tablets, assignments, queues, or progress exist/);
  assert.doesNotMatch(shellPage.body, /<strong>Winter Tournament<\/strong>/);

  const shellHtml = await requestPath('pre', '/tournament-management.html');
  assert.equal(shellHtml.statusCode, 200);
  assert.match(shellHtml.body, /Tournament Management System/);
  const directFile = await requestPath('pre', '/tournament-management/index.html');
  assert.equal(directFile.statusCode, 200);
  for (const view of ['event-setup', 'import', 'groups', 'head-table']) {
    const response = await requestPath('pre', `/tournament-management/?view=${view}`);
    assert.equal(response.statusCode, 200);
  }
  assert.match(directFile.body, /id="htSourceRun" aria-label="Head Table data source"/);
  assert.match(directFile.body, /\/api\/simulator\/runs\/\$\{encodeURIComponent\(ht\.simulatorRunId\)\}\/head-table/);
  assert.match(directFile.body, /SIMULATION - \$\{ht\.simulatorStatus/);
  assert.match(directFile.body, /!ht\.simulatorRunId && !htIsStale\(\)/);
  assert.match(directFile.body, /audience-monitor\/\?simulatorRunId=\$\{encodeURIComponent\(ht\.simulatorRunId\)\}/);
});

test('day-of pages still serve their existing interfaces and link to integrated setup', async () => {
  const ringAssignment = await requestPath('ringOps', '/ring-assignment/index.html');
  assert.equal(ringAssignment.statusCode, 200);
  assert.match(ringAssignment.body, /href="\/tournament-management\/\?view=event-setup"/);
  assert.match(ringAssignment.body, /id="ringDetails"/);
  assert.match(ringAssignment.body, /\/api\/groups\?eventName=' \+ encodeURIComponent\(state\.activeEvent\)/);
  assert.match(ringAssignment.body, /Select a ring to view its details/);
  for (const pathname of ['/head-table/index.html', '/competitors/index.html']) {
    const response = await requestPath('pre', pathname);
    assert.equal(response.statusCode, 200);
  }
});
