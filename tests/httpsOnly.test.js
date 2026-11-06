const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const https = require('node:https');
const http = require('node:http');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { createHttpsFixture } = require('./helpers/httpsFixture');

test('direct startup without HTTPS configuration exits before database initialization', () => {
  const env = { ...process.env };
  delete env.TOURNAMENT_HTTPS_CONFIG;
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'group-server.js')], {
    env, encoding: 'utf8', windowsHide: true, timeout: 10000
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HTTPS configuration is required/);
  assert.doesNotMatch(result.stdout, /server-ready|HTTPS entry|Database initialized/);
});

test('all three real server startup paths create only a TLS listener and report HTTP disabled', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'https-only-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { configFile, config } = createHttpsFixture(root);
  const initializeDatabase = require('../db/init');
  const filename = path.join(__dirname, '..', 'group-server.js');
  const source = fs.readFileSync(filename, 'utf8')
    .replace(/\nstartServer\(\)\.catch\(async \(error\) => \{[\s\S]*?\n\}\);/, '') +
    '\nreturn { startServer, app, db, simulatorRouter, resources: () => ({ httpsServer, accountStore, tabletStore }) };';
  const load = vm.compileFunction(source, ['require', '__dirname', 'console', 'process'], { filename });
  for (const surface of ['pre', 'monitoring', 'adminProgress']) {
    const workspace = path.join(root, surface);
    fs.mkdirSync(path.join(workspace, 'db'), { recursive: true });
    await initializeDatabase(path.join(workspace, 'db', 'tournament.db'));
    const realRequire = createRequire(filename), listeners = [], messages = [];
    const dependencies = (name) => {
      if (name === 'node:http' || name === 'http') {
        return { ...http, createServer() { assert.fail('Production startup must not create an HTTP listener.'); } };
      }
      if (name === 'node:https') {
        return { ...https, createServer(...args) { const server = https.createServer(...args); listeners.push(server); return server; } };
      }
      if (name === './backend/httpsConfig') {
        return { ...realRequire(name), HTTPS_PORTS: { [surface]: 0 } };
      }
      return realRequire(name);
    };
    const runtime = load(dependencies, workspace, { log() {}, warn() {}, error: console.error },
      { env: { TOURNAMENT_HTTPS_CONFIG: configFile, TOURNAMENT_SURFACE: surface },
        argv: [], on() {}, connected: true, send: (message) => messages.push(message) });
    runtime.app.listen = () => assert.fail('Express must not open an implicit HTTP listener.');
    try {
      await runtime.startServer();
      assert.equal(listeners.length, 1, surface);
      assert.deepEqual(messages, [{ type: 'server-ready' }]);
      const { httpsServer } = runtime.resources();
      const response = await new Promise((resolve, reject) => {
        const request = https.get({ hostname: '127.0.0.1', port: httpsServer.address().port,
          path: '/api/https-status', servername: config.hostname, ca: fs.readFileSync(config.caFile)
        }, (res) => {
          let text = '';
          res.on('data', (data) => { text += data; });
          res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
        });
        request.on('error', reject);
      });
      assert.equal(response.status, 200);
      assert.equal(response.data.enabled, true);
      assert.equal(response.data.legacyHttpEnabled, false);
      assert.equal(response.data.tabletAuthorizationEnforced, true);
      await new Promise((resolve, reject) => {
        const request = http.get({ hostname: '127.0.0.1', port: httpsServer.address().port, path: '/api/health' },
          (res) => { res.resume(); reject(new Error(`Cleartext unexpectedly accepted with ${res.statusCode}.`)); });
        request.on('error', (error) => {
          try { assert.ok(['ECONNRESET', 'EPROTO'].includes(error.code), error.message); resolve(); }
          catch (assertion) { reject(assertion); }
        });
      });
    } finally {
      const { accountStore, tabletStore } = runtime.resources();
      await Promise.all(listeners.filter((server) => server.listening).map((server) =>
        new Promise((resolve) => server.close(resolve))));
      await runtime.simulatorRouter.shutdown();
      if (tabletStore) await tabletStore.close();
      if (accountStore) await accountStore.close();
      await new Promise((resolve, reject) => runtime.db.close((error) => error ? reject(error) : resolve()));
    }
  }
});
