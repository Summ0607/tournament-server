const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const express = require('express');
const sqlite3 = require('sqlite3');
const { createAccountSessions, IDLE_MS } = require('../backend/accountSessions');
const { createAccountRouter, COOKIE_NAME } = require('../backend/accountRoutes');

let tlsRoot, key, cert;
before(() => {
  tlsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'account-api-tls-'));
  const openssl = process.env.OPENSSL_PATH || (process.platform === 'win32'
    ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl');
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
    '-keyout', path.join(tlsRoot, 'key.pem'), '-out', path.join(tlsRoot, 'cert.pem')], { stdio: 'pipe' });
  key = fs.readFileSync(path.join(tlsRoot, 'key.pem'));
  cert = fs.readFileSync(path.join(tlsRoot, 'cert.pem'));
});
after(() => {
  if (tlsRoot) fs.rmSync(tlsRoot, { recursive: true, force: true });
});

const password = 'A long test password phrase1!';
async function setup(t, sourceLimit = { maxAttempts: 100, windowMs: 60000 }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-api-'));
  let timestamp = Date.now();
  const file = path.join(root, 'accounts.db');
  const store = await createAccountSessions({ file, now: () => timestamp });
  for (const [userId, role] of [['admin', 'administrator'], ['coord', 'judging-coordinator'],
    ['operator', 'tournament-operator']]) {
    await store.createAccount({ userId, password, roles: [role], actor: 'test-setup' });
  }
  const app = express();
  const server = https.createServer({ key, cert }, app).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const origin = `https://localhost:${port}`;
  app.use('/api/account', createAccountRouter({ store, allowedOrigins: [origin],
    sourceLimit, now: () => timestamp }));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = (pathname, { method = 'GET', headers = {}, body, raw } = {}) => new Promise((resolve, reject) => {
    const payload = raw === undefined ? body === undefined ? undefined : JSON.stringify(body) : raw;
    const req = https.request({ hostname: '127.0.0.1', servername: 'localhost', port,
      ca: cert, path: `/api/account${pathname}`, method,
      headers: { Host: `localhost:${port}`, ...(payload === undefined ? {} : { 'Content-Length': Buffer.byteLength(payload) }),
        ...(method === 'GET' ? {} :
        { Origin: origin, 'Content-Type': 'application/json' }), ...headers } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
  async function login(userId = 'admin') {
    const response = await request('/login', { method: 'POST', body: { userId, password } });
    assert.equal(response.status, 200);
    return { response, headers: { Cookie: response.headers['set-cookie'][0].split(';')[0],
      'X-CSRF-Token': response.body.csrfToken } };
  }
  return { request, login, store, file, origin, advance: (ms) => { timestamp += ms; } };
}

test('HTTPS login issues a secure host-only cookie, no session token in JSON, and supports session/logout', async (t) => {
  const p = await setup(t);
  assert.equal((await p.request('/session')).status, 401);
  const first = await p.login();
  const cookie = first.response.headers['set-cookie'][0];
  for (const part of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(cookie.includes(part));
  assert.equal(cookie.includes('Domain='), false);
  assert.match(cookie, new RegExp(`^${COOKIE_NAME}=[a-f0-9]{64};`));
  assert.equal(first.response.body.token, undefined);
  assert.equal(first.response.headers['cache-control'], 'no-store');
  const session = await p.request('/session', { headers: first.headers });
  assert.equal(session.body.account.userId, 'admin');
  assert.equal(session.body.csrfToken, first.response.body.csrfToken);
  const second = await p.login();
  assert.equal((await p.request('/logout', { method: 'POST', headers: first.headers, body: {} })).status, 204);
  assert.equal((await p.request('/session', { headers: first.headers })).status, 401);
  assert.equal((await p.request('/session', { headers: second.headers })).status, 200);
});

test('cross-origin, forged-host, non-JSON and missing CSRF requests cannot mutate accounts', async (t) => {
  const p = await setup(t);
  const { headers } = await p.login();
  for (const extra of [{ Origin: 'https://evil.example' }, { Host: 'evil.example' },
    { 'Sec-Fetch-Site': 'cross-site' }, { Origin: '' }]) {
    assert.equal((await p.request('/users', { method: 'POST', headers: { ...headers, ...extra },
      body: { userId: 'new-user', password, roles: ['administrator'] } })).status, 403);
  }
  for (const csrf of ['', '0'.repeat(64), 'malformed']) {
    assert.equal((await p.request('/users', { method: 'POST', headers: { ...headers, 'X-CSRF-Token': csrf },
      body: { userId: 'new-user', password, roles: ['administrator'] } })).status, 403);
  }
  assert.equal((await p.request('/users', { method: 'POST',
    headers: { ...headers, 'Content-Type': 'text/plain' }, body: {} })).status, 415);
  assert.equal((await p.request('/session', { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await p.store.listAccounts()).length, 3);
  const other = await p.login();
  assert.equal((await p.request('/logout', { method: 'POST',
    headers: { ...other.headers, 'X-CSRF-Token': headers['X-CSRF-Token'] }, body: {} })).status, 403);
});

test('coordinator and operator cannot access administration reads or writes; actor spoofing is rejected', async (t) => {
  const p = await setup(t);
  for (const userId of ['coord', 'operator']) {
    const { headers } = await p.login(userId);
    for (const endpoint of ['/users', '/policy']) {
      assert.equal((await p.request(endpoint, { headers })).status, 403);
      assert.equal((await p.request(endpoint, { method: 'PUT', headers, body: {} })).status, 403);
    }
    assert.equal((await p.request('/users', { method: 'POST', headers, body: {} })).status, 403);
    assert.equal((await p.request('/users/admin', { method: 'PUT', headers, body: { revision: 1, enabled: false } })).status, 403);
  }
  const { headers } = await p.login();
  assert.equal((await p.request('/users', { method: 'POST', headers,
    body: { userId: 'spoof', password, roles: ['administrator'], actor: 'someone-else' } })).status, 400);
  assert.equal((await p.store.listAccounts()).length, 3);
});

test('administrator creates/updates users with stale guards and last-admin protection', async (t) => {
  const p = await setup(t);
  const { headers } = await p.login();
  const created = await p.request('/users', { method: 'POST', headers,
    body: { userId: 'new-user', password, roles: ['judging-coordinator'] } });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.account, { userId: 'new-user', roles: ['judging-coordinator'], enabled: true, revision: 1 });
  assert.equal(JSON.stringify(created.body).includes(password), false);
  assert.equal((await p.request('/users/admin', { method: 'PUT', headers, body: { revision: 1, enabled: false } })).status, 409);
  assert.equal((await p.request('/users/new-user', { method: 'PUT', headers, body: { revision: 0, enabled: false } })).status, 409);
  assert.equal((await p.request('/users/new-user', { method: 'PUT', headers, body: { revision: 1, enabled: false } })).status, 200);
  assert.equal((await p.request('/users/new-user', { method: 'DELETE', headers, body: {} })).status, 404);
  const users = await p.request('/users', { headers });
  assert.equal(users.body.users.length, 4);
  const db = new sqlite3.Database(p.file, sqlite3.OPEN_READONLY);
  try {
    const audits = await new Promise((resolve, reject) => db.all(
      'SELECT actor, action FROM account_audit WHERE user_id = ?', ['new-user'],
      (error, rows) => error ? reject(error) : resolve(rows)));
    assert.deepEqual(audits, [{ actor: 'admin', action: 'account-created' },
      { actor: 'admin', action: 'account-changed-sessions-revoked' }]);
  } finally {
    await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  }
});

test('changed policy revokes all sessions including the saving administrator; unchanged save does not', async (t) => {
  const p = await setup(t);
  const admin = await p.login();
  const coord = await p.login('coord');
  const saved = (await p.request('/policy', { headers: admin.headers })).body;
  assert.equal((await p.request('/policy', { method: 'PUT', headers: admin.headers, body: saved })).status, 200);
  assert.equal((await p.request('/session', { headers: admin.headers })).status, 200);
  assert.equal((await p.request('/policy', { method: 'PUT', headers: admin.headers,
    body: { ...saved, revision: 0 } })).status, 409);
  assert.equal((await p.request('/policy', { method: 'PUT', headers: admin.headers,
    body: { ...saved, policy: { ...saved.policy, idleTimeoutMinutes: 5 } } })).status, 200);
  assert.equal((await p.request('/session', { headers: admin.headers })).status, 401);
  assert.equal((await p.request('/session', { headers: coord.headers })).status, 401);
});

test('session polling does not count as activity; explicit activity is protected and extends idle time', async (t) => {
  const p = await setup(t);
  const { headers } = await p.login();
  p.advance(IDLE_MS - 1000);
  assert.equal((await p.request('/session', { headers })).status, 200);
  assert.equal((await p.request('/activity', { method: 'POST', headers, body: {} })).status, 200);
  p.advance(IDLE_MS - 1);
  assert.equal((await p.request('/session', { headers })).status, 200);
  p.advance(1);
  assert.equal((await p.request('/activity', { method: 'POST', headers, body: {} })).status, 401);
  assert.equal((await p.request('/users', { headers })).status, 401);
});

test('malformed/oversized requests, duplicate cookies, and unknown fields are rejected', async (t) => {
  const p = await setup(t);
  const { headers } = await p.login();
  assert.equal((await p.request('/users', { method: 'POST', headers, raw: '{broken' })).status, 400);
  assert.equal((await p.request('/users', { method: 'POST', headers, body: { data: 'x'.repeat(9000) } })).status, 413);
  assert.equal((await p.request('/logout', { method: 'POST', headers, body: { extra: true } })).status, 400);
  assert.equal((await p.request('/session', { headers: { Cookie: `${headers.Cookie}; ${headers.Cookie}` } })).status, 401);
  assert.equal((await p.request('/session', { headers })).status, 200);
});

test('password reset and role removal revoke browser API access, including administrator sessions', async (t) => {
  const p = await setup(t);
  const admin = await p.login();
  const coord = await p.login('coord');
  assert.equal((await p.request('/users/coord', { method: 'PUT', headers: admin.headers,
    body: { revision: 1, password: 'A replacement password phrase1!' } })).status, 200);
  assert.equal((await p.request('/session', { headers: coord.headers })).status, 401);
  assert.equal((await p.request('/login', { method: 'POST', body: { userId: 'coord', password } })).status, 401);
  const replacement = await p.request('/login', { method: 'POST',
    body: { userId: 'coord', password: 'A replacement password phrase1!' } });
  assert.equal(replacement.status, 200);
  await p.store.createAccount({ userId: 'second-admin', password, roles: ['administrator'], actor: 'test-setup' });
  const second = await p.login('second-admin');
  assert.equal((await p.request('/users/admin', { method: 'PUT', headers: second.headers,
    body: { revision: 1, roles: ['judging-coordinator'] } })).status, 200);
  assert.equal((await p.request('/users', { headers: admin.headers })).status, 401);
  assert.equal((await p.request('/users', { headers: (await p.login()).headers })).status, 403);
});

test('login rejects missing origins and issues generic failures/cooldown without account disclosure', async (t) => {
  const p = await setup(t);
  assert.equal((await p.request('/login', { method: 'POST', headers: { Origin: '' },
    body: { userId: 'admin', password } })).status, 403);
  for (const userId of ['coord', 'no-such-user']) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await p.request('/login', { method: 'POST', body: { userId, password: 'wrong' } });
      assert.equal(response.status, 401);
      assert.deepEqual(response.body, { error: 'Invalid user ID or password.' });
      assert.equal(response.headers['set-cookie'], undefined);
    }
    const response = await p.request('/login', { method: 'POST', body: { userId, password } });
    assert.equal(response.status, 429);
    assert.equal(response.headers['retry-after'], '300');
    assert.deepEqual(response.body, { error: 'Too many login attempts. Try again shortly.' });
  }
});

test('unexpected store errors are logged and do not expose internal details', async (t) => {
  const p = await setup(t);
  const { headers } = await p.login();
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args));
  t.mock.method(p.store, 'listAccounts', async () => { throw new Error('private database details'); });
  const response = await p.request('/users', { headers });
  assert.equal(response.status, 500);
  assert.equal(JSON.stringify(response.body).includes('private database details'), false);
  assert.equal(logged.length, 1);
  assert.equal(logged[0][1].message, 'private database details');
});

test('source rate limit counts across user IDs, ignores spoofed forwarding headers, and expires exactly', async (t) => {
  const p = await setup(t, { maxAttempts: 2, windowMs: 60000 });
  for (const userId of ['unknown-one', 'unknown-two']) {
    assert.equal((await p.request('/login', { method: 'POST', body: { userId, password } })).status, 401);
  }
  const options = { method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.7' }, body: { userId: 'admin', password } };
  const blocked = await p.request('/login', options);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers['retry-after'], '60');
  p.advance(59999);
  assert.equal((await p.request('/login', options)).status, 429);
  p.advance(1);
  assert.equal((await p.request('/login', options)).status, 200);
});

test('HTTP and forwarded-proto cannot enable account endpoints; explicit configuration is required', async (t) => {
  assert.throws(() => createAccountRouter({ allowedOrigins: ['http://localhost'] }), /HTTPS origins/);
  assert.throws(() => createAccountRouter({ allowedOrigins: ['https://localhost'] }), /source login rate limit/);
  const app = express();
  app.use('/api/account', createAccountRouter({ store: {}, allowedOrigins: ['https://localhost'],
    sourceLimit: { maxAttempts: 2, windowMs: 60000 } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: '/api/account/session', headers: { Host: 'localhost', 'X-Forwarded-Proto': 'https' } },
    (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('admin authorization is rechecked inside queued database mutations after role revocation', async (t) => {
  const p = await setup(t);
  await p.store.createAccount({ userId: 'second-admin', password, roles: ['administrator'], actor: 'test-setup' });
  const login = await p.store.login({ userId: 'admin', password });
  const results = await Promise.allSettled([
    p.store.changeAccount({ userId: 'admin', revision: 1, roles: ['judging-coordinator'], actor: 'second-admin' }),
    p.store.createAccount({ userId: 'must-not-exist', password, roles: ['administrator'], authorizationToken: login.token })
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.statusCode, 401);
  assert.equal((await p.store.listAccounts()).some((row) => row.userId === 'must-not-exist'), false);
});
