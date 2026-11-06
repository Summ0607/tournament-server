const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { EventEmitter } = require('node:events');
const { startServiceGroup, SURFACES } = require('../backend/serviceGroup');
const { startSupervisor } = require('../server-launcher');
const fs = require('node:fs');
const { fork, execFileSync } = require('node:child_process');

function endpoint() {
  const name = `tournament-test-${crypto.randomUUID()}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), name);
}
async function until(predicate) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail('Timed out waiting for managed service-group state.');
}

test('all three services coordinate restart, minimize each console and open home exactly once after readiness', async (t) => {
  const address = endpoint(), token = crypto.randomUUID(), groups = new Map(), states = new Map();
  const restarts = [], minimized = [];
  let browsers = 0;
  t.after(() => { for (const group of groups.values()) group.stop(); });
  for (const surface of SURFACES) {
    groups.set(surface, startServiceGroup({ endpoint: address, token, surface,
      openOnStart: true, launchHome: async () => { browsers++; },
      minimize: async () => { minimized.push(surface); },
      onState: (state) => states.set(surface, state),
      onRestart: () => { restarts.push(surface); }
    }));
    groups.get(surface).markReady();
  }
  await until(() => states.get('pre')?.restartAvailable);
  assert.equal(browsers, 1);
  groups.get('monitoring').requestRestart();
  await until(() => restarts.length === 3);
  assert.deepEqual(minimized.sort(), [...SURFACES].sort());
  assert.equal(states.get('pre').restarting, true);
  groups.get('pre').markReady();
  groups.get('monitoring').markReady();
  await delay(30);
  assert.equal(browsers, 1, 'home must not open while a service is still restarting');
  groups.get('adminProgress').markReady();
  await until(() => browsers === 2 && states.get('pre')?.restartAvailable);
  groups.get('pre').markReady();
  await delay(30);
  assert.equal(browsers, 2, 'duplicate readiness must not open duplicate browsers');
  groups.get('monitoring').markUnavailable();
  await until(() => states.get('pre')?.restartAvailable === false);
  assert.equal(states.get('pre').services.find((service) => service.name === 'monitoring').ready, false);
});

test('missing services and unauthenticated pipe clients cannot trigger a group restart', async (t) => {
  const address = endpoint(), token = crypto.randomUUID();
  let state, restarts = 0;
  const group = startServiceGroup({ endpoint: address, token, surface: 'pre',
    onState: (next) => { state = next; }, onRestart: () => { restarts++; } });
  t.after(() => group.stop());
  group.markReady();
  await until(() => state?.services?.[0].ready);
  group.requestRestart();
  await delay(30);
  assert.equal(restarts, 0);
  assert.equal(state.restartAvailable, false);
  const stranger = net.createConnection(address);
  t.after(() => stranger.destroy());
  await new Promise((resolve) => stranger.once('connect', resolve));
  stranger.write(`${JSON.stringify({ type: 'hello', token: 'wrong', surface: 'monitoring' })}\n`);
  await new Promise((resolve) => stranger.once('close', resolve));
  assert.equal(restarts, 0);
});

test('restart timeout is explicit and never opens home before all three services recover', async (t) => {
  const address = endpoint(), token = crypto.randomUUID(), groups = [];
  let state, browsers = 0;
  t.after(() => groups.forEach((group) => group.stop()));
  for (const surface of SURFACES) {
    const group = startServiceGroup({ endpoint: address, token, surface, restartTimeoutMs: 40,
      launchHome: async () => { browsers++; }, minimize: async () => {},
      onState: (next) => { if (surface === 'pre') state = next; }, onRestart() {} });
    groups.push(group);
    group.markReady();
  }
  await until(() => state?.restartAvailable);
  groups[0].requestRestart();
  await until(() => /timed out/.test(state?.message || ''));
  assert.equal(browsers, 0);
  assert.equal(state.restartAvailable, false);
});

test('supervisors replace every child on coordinated restart, preserve launcher state and drain on stop', async () => {
  const address = endpoint(), token = crypto.randomUUID(), supervisors = [], children = new Map();
  const sigint = new Set(process.listeners('SIGINT')), sigterm = new Set(process.listeners('SIGTERM'));
  let browsers = 0;
  try {
    for (const surface of SURFACES) {
      const versions = [];
      children.set(surface, versions);
      supervisors.push(startSupervisor({ serverPath: 'fixture.js', args: [],
        groupConfig: { endpoint: address, token, surface, launchHome: async () => { browsers++; }, minimize: async () => {} },
        spawn() {
          const child = new EventEmitter();
          child.connected = true;
          child.send = (message) => {
            if (message.type === 'restart') {
              child.emit('message', { type: 'restart-ready' });
              child.connected = false;
              child.emit('exit', 0);
            } else if (message.type === 'shutdown') child.connected = false;
            else if (message.type === 'services-state') child.state = message.state;
          };
          versions.push(child);
          setImmediate(() => child.emit('message', { type: 'server-ready' }));
          return child;
        }
      }));
    }
    await until(() => children.get('pre')[0].state?.restartAvailable);
    children.get('adminProgress')[0].emit('message', { type: 'restart-services' });
    await until(() => SURFACES.every((surface) => children.get(surface).length === 2) && browsers === 1);
    for (const versions of children.values()) assert.equal(versions[1].connected, true);
  } finally {
    supervisors.forEach((supervisor) => supervisor.stop());
    for (const listener of process.listeners('SIGINT')) if (!sigint.has(listener)) process.removeListener('SIGINT', listener);
    for (const listener of process.listeners('SIGTERM')) if (!sigterm.has(listener)) process.removeListener('SIGTERM', listener);
  }
});

test('coordinated restart drains and replaces three real service processes before opening home', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tournament-group-processes-'));
  const fixture = path.join(root, 'server.js');
  fs.writeFileSync(fixture, `
    const http = require('node:http');
    let stopping = false;
    const server = http.createServer((_req, res) => res.end('ready'));
    server.listen(0, '127.0.0.1', () => process.send({type:'server-ready'}));
    process.on('message', message => {
      if (!['shutdown','restart'].includes(message.type) || stopping) return;
      stopping = true;
      server.close(() => {
        if (message.type === 'restart') process.send({type:'restart-ready'}, () => process.exit(0));
        else process.exit(0);
      });
      server.closeIdleConnections();
    });
  `);
  const address = endpoint(), token = crypto.randomUUID(), supervisors = [], versions = new Map(), exits = [];
  const sigint = new Set(process.listeners('SIGINT')), sigterm = new Set(process.listeners('SIGTERM'));
  let state, opened = 0;
  t.after(async () => {
    supervisors.forEach((supervisor) => supervisor.stop());
    await Promise.all(exits);
    for (const listener of process.listeners('SIGINT')) if (!sigint.has(listener)) process.removeListener('SIGINT', listener);
    for (const listener of process.listeners('SIGTERM')) if (!sigterm.has(listener)) process.removeListener('SIGTERM', listener);
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const surface of SURFACES) {
    const children = [];
    versions.set(surface, children);
    supervisors.push(startSupervisor({ serverPath: fixture, args: [],
      groupConfig: { endpoint: address, token, surface, minimize: async () => {},
        launchHome: async () => {
          assert.ok(SURFACES.every((name) => versions.get(name).length === 2));
          assert.ok(SURFACES.every((name) => versions.get(name)[1].ready));
          opened++;
        } },
      spawn(file, args, options) {
        const child = fork(file, args, options);
        children.push(child);
        exits.push(new Promise((resolve) => child.once('exit', resolve)));
        child.on('message', (message) => {
          if (message.type === 'server-ready') child.ready = true;
          if (message.type === 'services-state' && surface === 'pre') state = message.state;
        });
        const originalSend = child.send.bind(child);
        child.send = (message) => {
          if (message.type === 'services-state' && surface === 'pre') state = message.state;
          return originalSend(message);
        };
        return child;
      }
    }));
  }
  await until(() => state?.restartAvailable);
  versions.get('monitoring')[0].emit('message', { type: 'restart-services' });
  await until(() => opened === 1 && state?.restartAvailable);
  for (const children of versions.values()) {
    assert.notEqual(children[0].pid, children[1].pid);
    assert.equal(children[0].exitCode, 0);
    assert.equal(children[1].connected, true);
  }
});

test('Windows launcher starts exactly three minimized consoles with one shared group and home-browser policy', {
  skip: process.platform !== 'win32'
}, () => {
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'launchSurfaces.test.ps1')], { encoding: 'utf8' });
  assert.match(result, /Launcher checks passed/);
});
