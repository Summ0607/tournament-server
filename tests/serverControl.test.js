const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const express = require('express');
const { createServerControl, isLocalRequest } = require('../backend/serverControl');
const { startSupervisor } = require('../server-launcher');

async function withControl(enabled, callback) {
  let restarts = 0;
  const app = express();
  app.use(express.json());
  app.use('/api/server-control', createServerControl({
    enabled, instanceId: 'original-instance', requestRestart: () => { restarts += 1; }
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const request = (pathname, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: `/api/server-control/${pathname}`,
      method, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try { await callback(request, () => restarts, port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('server restart requires a managed launcher, confirmation, token, and only schedules once', async () => {
  await withControl(false, async (request, restarts) => {
    assert.equal((await request('status')).body.restartAvailable, false);
    assert.equal((await request('restart', { method: 'POST' })).status, 409);
    assert.equal(restarts(), 0);
  });
  await withControl(true, async (request, restarts) => {
    const status = await request('status');
    assert.equal(status.headers['cache-control'], 'no-store');
    assert.equal(status.body.instanceId, 'original-instance');
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: { confirmation: 'RESTART' } };
    assert.equal((await request('restart', options)).status, 403);
    options.headers['X-Server-Control-Token'] = status.body.token;
    options.body.confirmation = 'restart';
    assert.equal((await request('restart', options)).status, 403);
    options.body.confirmation = 'RESTART';
    assert.equal((await request('restart', options)).status, 202);
    assert.equal(restarts(), 1);
    assert.equal((await request('restart', options)).status, 409);
    assert.equal(restarts(), 1);
  });
});

test('server controls reject LAN clients, rebinding hosts and cross-origin requests', async () => {
  const mockRequest = (address, headers = {}) => ({ socket: { remoteAddress: address }, protocol: 'http',
    get: (name) => ({ host: 'localhost:3000', ...headers })[name] });
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLocalRequest(mockRequest(address)), true);
  }
  assert.equal(isLocalRequest(mockRequest('192.168.1.12')), false);
  assert.equal(isLocalRequest(mockRequest('127.0.0.1', { host: 'evil.example:3000' })), false);
  await withControl(true, async (request, restarts, port) => {
    for (const headers of [
      { Origin: 'http://evil.example' }, { Host: 'evil.example' },
      { 'Sec-Fetch-Site': 'cross-site' }, { Origin: `http://localhost:${port + 1}` }
    ]) {
      assert.equal((await request('status', { headers })).status, 403);
      assert.equal((await request('restart', { method: 'POST', headers })).status, 403);
    }
    assert.equal((await request('status', { headers: { Origin: `http://localhost:${port}` } })).status, 200);
    assert.equal(restarts(), 0);
  });
});

test('supervisor relaunches only after an explicit clean restart and forwards shutdown', () => {
  const children = [];
  const oldExitCode = process.exitCode;
  const supervisor = startSupervisor({ serverPath: 'test-server.js', args: [], spawn(file, args, options) {
    assert.equal(file, 'test-server.js');
    assert.deepEqual(args, []);
    assert.equal(options.env.TOURNAMENT_MANAGED_SERVER, '1');
    const child = new EventEmitter();
    child.connected = true;
    child.send = (message) => { child.lastMessage = message; };
    children.push(child);
    return child;
  } });
  const signals = {
    SIGINT: process.listeners('SIGINT').at(-1),
    SIGTERM: process.listeners('SIGTERM').at(-1)
  };
  try {
    children[0].emit('message', { type: 'restart-ready' });
    assert.equal(children.length, 1);
    children[0].emit('exit', 0, null);
    assert.equal(children.length, 2);
    children[1].emit('exit', 1, null);
    assert.equal(children.length, 2);
    assert.equal(process.exitCode, 1);
    supervisor.stop();
    assert.deepEqual(children[1].lastMessage, { type: 'shutdown' });
    children[1].emit('message', { type: 'restart-ready' });
    children[1].emit('exit', 0, null);
    assert.equal(children.length, 2);
  } finally {
    process.exitCode = oldExitCode;
    for (const [signal, listener] of Object.entries(signals)) process.removeListener(signal, listener);
  }
});

test('managed restart replaces a real server process and responds with a new instance', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'server-restart-test-'));
  const readyPath = path.join(directory, 'ready.json');
  const fixturePath = path.join(directory, 'fixture.js');
  const runnerPath = path.join(directory, 'runner.js');
  const root = path.join(__dirname, '..');
  fs.writeFileSync(fixturePath, `
    const express = require(${JSON.stringify(require.resolve('express'))});
    const fs = require('node:fs');
    const { createServerControl } = require(${JSON.stringify(path.join(root, 'backend', 'serverControl.js'))});
    const app = express();
    app.use(express.json());
    function shutdown(restart) {
      server.close(() => {
        if (restart) process.send({ type: 'restart-ready' }, () => process.exit(0));
        else process.exit(0);
      });
      server.closeIdleConnections();
    }
    app.use('/api/server-control', createServerControl({
      enabled: process.env.TOURNAMENT_MANAGED_SERVER === '1',
      requestRestart: () => shutdown(true)
    }));
    const server = app.listen(0, '127.0.0.1', () =>
      fs.writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ port: server.address().port, pid: process.pid })));
    process.on('message', (message) => { if (message.type === 'shutdown') shutdown(false); });
  `);
  fs.writeFileSync(runnerPath, `
    const { startSupervisor } = require(${JSON.stringify(path.join(root, 'server-launcher.js'))});
    const supervisor = startSupervisor({ serverPath: ${JSON.stringify(fixturePath)}, args: [] });
    process.on('message', () => { supervisor.stop(); process.disconnect(); });
  `);
  const runner = fork(runnerPath, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  runner.stdout.on('data', (data) => { output += data; });
  runner.stderr.on('data', (data) => { output += data; });
  let latest;
  const exited = new Promise((resolve) => runner.once('exit', resolve));
  async function waitForInstance(previousPid) {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      if (fs.existsSync(readyPath)) {
        const content = fs.readFileSync(readyPath, 'utf8');
        if (content) {
          latest = JSON.parse(content);
          if (latest.pid !== previousPid) return latest;
        }
      }
      await delay(20);
    }
    throw new Error(`Timed out waiting for fixture server: ${output}`);
  }
  const request = (port, route, options = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: `/api/server-control/${route}`,
      ...options }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.end(options.method === 'POST' ? JSON.stringify({ confirmation: 'RESTART' }) : undefined);
  });
  try {
    const first = await waitForInstance();
    const status = await request(first.port, 'status');
    const restarted = await request(first.port, 'restart', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Server-Control-Token': status.body.token } });
    assert.equal(restarted.status, 202);
    const second = await waitForInstance(first.pid);
    const ready = await request(second.port, 'status');
    assert.equal(ready.status, 200);
    assert.notEqual(ready.body.instanceId, status.body.instanceId);
    assert.notEqual(ready.body.token, status.body.token);
    assert.equal(ready.body.restartAvailable, true);
  } finally {
    if (runner.connected) runner.send({ type: 'stop' });
    const stopped = await Promise.race([exited.then(() => true), delay(5000).then(() => false)]);
    if (!stopped) {
      if (latest) process.kill(latest.pid);
      runner.kill();
      await exited;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
