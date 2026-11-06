const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { createTabletStore, localDay, nextMidnight } = require('../backend/tabletAuthorization');
const { createAccountSessions } = require('../backend/accountSessions');
const { createAccountWeb } = require('../backend/accountWeb');
const { loadHttpsConfig } = require('../backend/httpsConfig');
const { registerPageRoutes } = require('../backend/pages');
const { createHttpsFixture } = require('./helpers/httpsFixture');
const { allowedViews } = require('../backend/browserPermissions');

test('dedicated Ring Assignment workspace is available only to day-of roles', () => {
  for (const role of ['administrator', 'event-coordinator', 'tournament-operator']) {
    assert.ok(allowedViews([role]).includes('tablet-pairing'));
  }
  for (const role of ['judging-coordinator', 'viewer']) {
    assert.equal(allowedViews([role]).includes('tablet-pairing'), false);
  }
});

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tablet-pairing-'));
  let timestamp = new Date(2026, 10, 5, 12).getTime();
  const file = path.join(root, 'devices.db');
  const store = await createTabletStore({ file, now: () => timestamp });
  t.after(async () => { await store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const context = { event: 'Test Tournament', rings: { 'ring-a-1': { ringLabel: 'A1' }, 'ring-a-2': { ringLabel: 'A2' } } };
  const code = (ring = 'ring-a-1') => store.code({ event: context.event, ring, ringLabel: context.rings[ring].ringLabel, server: 'https://tourn-svr.home.arpa:3443' });
  const deviceId = crypto.randomUUID();
  const input = (overrides = {}) => ({ ...code(), deviceId, tabletLabel: 'Test Tablet', ...overrides });
  return { root, file, store, context, code, input, setTime(value) { timestamp = value; } };
}

test('daily code is reusable and stable across processes; credentials survive restart and expire at local midnight', async (t) => {
  const p = await fixture(t);
  const first = await p.store.pair(p.input(), p.context);
  assert.ok(await p.store.resolve(first.credential, p.context));
  assert.notEqual(first.credential, p.code().token);
  const other = await createTabletStore({ file: p.file, now: () => new Date(2026, 10, 5, 20).getTime() });
  try {
    assert.equal(other.code({ event: p.context.event, ring: 'ring-a-1', server: 'https://example.test' }).token, p.code().token);
    assert.ok(await other.resolve(first.credential, p.context));
  } finally { await other.close(); }
  const second = await p.store.pair(p.input(), p.context);
  assert.equal(await p.store.resolve(first.credential, p.context), null);
  assert.ok(await p.store.resolve(second.credential, p.context));
  p.setTime(second.expiresAt - 1);
  assert.ok(await p.store.resolve(second.credential, p.context));
  p.setTime(second.expiresAt);
  assert.equal(await p.store.resolve(second.credential, p.context), null);
  await assert.rejects(p.store.pair(p.input({ day: first.day }), p.context), { statusCode: 401 });
  assert.equal(localDay(new Date(2026, 10, 5, 23, 59, 59).getTime()), '2026-11-05');
  assert.equal(nextMidnight(new Date(2026, 10, 5, 23).getTime()), new Date(2026, 10, 6).getTime());
});

test('replacement requires confirmation, revokes old tablet, and moving a tablet frees its previous ring', async (t) => {
  const p = await fixture(t), deviceId = crypto.randomUUID();
  const first = await p.store.pair(p.input(), p.context);
  await assert.rejects(p.store.pair(p.input({ deviceId }), p.context), { statusCode: 409 });
  assert.ok(await p.store.resolve(first.credential, p.context));
  const replacement = await p.store.pair(p.input({ deviceId, replace: true }), p.context);
  assert.equal(await p.store.resolve(first.credential, p.context), null);
  assert.ok(await p.store.resolve(replacement.credential, p.context));
  const moved = await p.store.pair(p.input({ ...p.code('ring-a-2'), deviceId }), p.context);
  assert.equal(await p.store.resolve(replacement.credential, p.context), null);
  assert.equal((await p.store.resolve(moved.credential, p.context)).ringId, 'ring-a-2');
  await p.store.pair(p.input(), p.context);
});

test('tampered, cross-event, unknown-ring and invalid pairing inputs are rejected without revoking current device', async (t) => {
  const p = await fixture(t);
  const session = await p.store.pair(p.input(), p.context);
  for (const changes of [{ token: '0'.repeat(64) }, { event: 'Other Tournament' },
    { ringId: 'ring-a-2' }, { ringId: '__proto__' }, { day: '2026-11-04' },
    { deviceId: '' }, { tabletLabel: '' }, { replace: 'true' }]) {
    await assert.rejects(p.store.pair(p.input(changes), p.context));
  }
  await assert.rejects(p.store.pair(null, p.context), { statusCode: 400 });
  assert.ok(await p.store.resolve(session.credential, p.context));
  assert.equal(await p.store.resolve(session.credential, { ...p.context, event: 'Other Tournament' }), null);
  assert.equal(await p.store.resolve(session.credential, { ...p.context, rings: {} }), null);
  assert.equal(await p.store.resolve('invalid', p.context), null);
  const dbBytes = fs.readFileSync(p.file);
  assert.equal(dbBytes.includes(Buffer.from(session.credential)), false);
});

test('simultaneous scans across surface connections authorize only one tablet', async (t) => {
  const p = await fixture(t);
  const other = await createTabletStore({ file: p.file, now: () => new Date(2026, 10, 5, 12).getTime() });
  try {
    const results = await Promise.allSettled([
      p.store.pair(p.input(), p.context),
      other.pair(p.input({ deviceId: crypto.randomUUID() }), p.context)
    ]);
    assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1);
    assert.equal(results.find((entry) => entry.status === 'rejected').reason.statusCode, 409);
  } finally { await other.close(); }
});

test('real HTTPS routes enforce roles, pairing, ring scope and denial of unauthenticated/HTTP tablet calls', async (t) => {
  let accounts;
  const servers = [];
  t.after(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    if (accounts) await accounts.close();
  });
  const p = await fixture(t);
  const { configFile } = createHttpsFixture(p.root), config = loadHttpsConfig(configFile);
  accounts = await createAccountSessions({ file: path.join(p.root, 'accounts.db') });
  const password = 'TestTablet1!';
  for (const role of ['administrator', 'event-coordinator', 'tournament-operator', 'judging-coordinator', 'viewer']) {
    await accounts.createAccount({ userId: role, password, roles: [role], actor: 'test' });
  }
  const app = express();
  app.use(createAccountWeb({ store: accounts, config, surface: 'pre', tabletStore: p.store, getTabletContext: () => p.context }));
  app.use(express.json());
  app.use('/api', (_req, res) => res.json({ reachedHandler: true }));
  registerPageRoutes(app, path.resolve(__dirname, '..'), path.resolve(__dirname, '..', 'head-table'), 'pre');
  servers.push(https.createServer(config.options, app), http.createServer(app));
  await Promise.all(servers.map((server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))));
  async function request(url, { method = 'GET', body, headers = {}, plain = false } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = (plain ? http : https).request({ hostname: '127.0.0.1',
        port: servers[plain ? 1 : 0].address().port, path: url, method,
        ...(plain ? {} : { ca: fs.readFileSync(config.caFile), servername: config.hostname }),
        headers: { Host: 'tourn-svr.home.arpa:3443', ...(payload === undefined ? {} :
          { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }), ...headers }
      }, (res) => {
        let text = '';
        res.on('data', (data) => { text += data; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
          data: res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : text }));
      });
      req.on('error', reject); req.end(payload);
    });
  }
  for (const role of ['administrator', 'event-coordinator', 'tournament-operator', 'judging-coordinator', 'viewer']) {
    const login = await request('/api/account/login', { method: 'POST', body: { userId: role, password },
      headers: { Origin: 'https://tourn-svr.home.arpa:3443' } });
    const headers = { Cookie: login.headers['set-cookie'][0].split(';')[0],
      'X-CSRF-Token': login.data.csrfToken, Origin: 'https://tourn-svr.home.arpa:3443' };
    const allowed = !['judging-coordinator', 'viewer'].includes(role);
    const result = await request('/api/tablet/codes', { method: 'POST', body: { ringId: 'ring-a-1' }, headers });
    assert.equal(result.status, allowed ? 200 : 403);
    assert.equal((await request('/tablet-pairing/', { headers })).status, allowed ? 200 : 403);
    if (allowed) {
      assert.match(result.data.image, /^data:image\/png;base64,/);
      const png = Buffer.from(result.data.image.split(',')[1], 'base64');
      assert.equal(png.readUInt32BE(16), 640);
      assert.equal(png.readUInt32BE(20), 640);
      assert.equal(result.data.day, '2026-11-05');
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.equal(result.data.server, 'https://192.168.4.42:3443');
      const ipCode = await request('/api/tablet/codes', { method: 'POST',
        body: { ringId: 'ring-a-1', useIp: true }, headers });
      assert.equal(ipCode.status, 200);
      assert.equal(ipCode.data.server, 'https://192.168.4.42:3443');
      const dnsCode = await request('/api/tablet/codes', { method: 'POST',
        body: { ringId: 'ring-a-1', useIp: false }, headers });
      assert.equal(dnsCode.status, 200);
      assert.equal(dnsCode.data.server, 'https://tourn-svr.home.arpa:3443');
    }
    assert.equal((await request('/api/tablet/codes', { method: 'POST', body: { ringId: 'ring-a-1' },
      headers: { ...headers, 'X-CSRF-Token': '' } })).status, 403);
  }
  const paired = await request('/api/tablet/pair', { method: 'POST', body: p.input() });
  assert.equal(paired.status, 200);
  const auth = { Authorization: `Bearer ${paired.data.credential}` };
  for (const [method, endpoint] of [
    ['GET', '/api/tablet/session'], ['GET', '/api/rings/config'], ['GET', '/api/events/active'],
    ['GET', '/api/version'], ['GET', '/api/rings/ring-a-1/current'],
    ...['request-group', 'heartbeat', 'complete', 'assistance', 'assistance/clear'].map((suffix) => ['POST', `/api/rings/ring-a-1/${suffix}`])
  ]) {
    assert.equal((await request(endpoint, { method, headers: auth, ...(method === 'POST' ? { body: {} } : {}) })).status, 200, endpoint);
  }
  for (const endpoint of ['/api/rings/ring-a-2/current', '/api/events/list', '/api/account/users', '/backend/tabletAuthorization.js']) {
    assert.equal((await request(endpoint, { headers: auth })).status, endpoint === '/api/account/users' ? 401 : 403);
  }
  assert.equal((await request('/api/rings/config', { headers: { 'User-Agent': 'Dalvik/2.1.0' } })).status, 401);
  assert.equal((await request('/api/rings/config', { headers: auth, plain: true })).status, 426);
  assert.equal((await request('/api/tablet/pair', { method: 'POST', body: p.input(), plain: true })).status, 426);
  assert.equal((await request('/api/tablet/pair', { method: 'POST', body: p.input(), headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await request('/api/rings/config', { headers: { ...auth, Origin: 'https://evil.test' } })).status, 403);
  const replacement = await request('/api/tablet/pair', { method: 'POST', body: p.input({ deviceId: crypto.randomUUID(), replace: true }) });
  assert.equal(replacement.status, 200);
  assert.equal((await request('/api/rings/config', { headers: auth })).status, 401);
});
