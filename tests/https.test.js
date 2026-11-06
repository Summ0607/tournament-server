const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const express = require('express');
const { HTTPS_PORTS, requirePrivateFile, loadHttpsConfig, httpsOrigins } = require('../backend/httpsConfig');
const { createAccountWeb } = require('../backend/accountWeb');
const { createAccountSessions } = require('../backend/accountSessions');
const { ROLE_LABELS, allowedViews, apiRoles, hasRole, isTabletEndpoint } = require('../backend/browserPermissions');
const { registerPageRoutes } = require('../backend/pages');
const { createHttpsFixture } = require('./helpers/httpsFixture');

let root, configFile, config;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tournament-https-'));
  ({ config, configFile } = createHttpsFixture(root));
});
after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

test('HTTPS config loads external CA-signed DNS/IP certificates and stable surface ports', () => {
  const loaded = loadHttpsConfig(configFile);
  assert.equal(loaded.options.minVersion, 'TLSv1.2');
  assert.equal(HTTPS_PORTS.pre, 3443);
  assert.equal(HTTPS_PORTS.monitoring, 3445);
  assert.equal(HTTPS_PORTS.adminProgress, 3447);
  assert.deepEqual(httpsOrigins(loaded, 'pre'), ['https://tourn-svr.home.arpa:3443', 'https://192.168.4.42:3443']);
  assert.equal(loadHttpsConfig(undefined), null);
});

test('HTTPS config rejects repository files, missing files, bad SANs, keys, CA and source limit', () => {
  assert.throws(() => requirePrivateFile(path.join(__dirname, '..', 'package.json')), /outside/);
  assert.throws(() => requirePrivateFile('relative.pem'), /absolute/);
  assert.throws(() => loadHttpsConfig(path.join(root, 'missing.json')), /ENOENT/);
  const badFile = path.join(root, 'bad.json');
  for (const [changes, expected] of [
    [{ hostname: 'other.home.arpa' }, /cover/],
    [{ ipAddress: '192.168.4.43' }, /cover/],
    [{ sourceLimit: { maxAttempts: 0, windowMs: 900000 } }, /rate limit/],
    [{ keyFile: path.join(root, 'ca-key.pem') }, /key values mismatch/],
    [{ caFile: config.certFile }, /signed by/],
    [{ hostname: 'bad"host' }, /DNS/],
    [{ unknown: true }, /unknown/]
  ]) {
    fs.writeFileSync(badFile, JSON.stringify({ ...config, ...changes }));
    assert.throws(() => loadHttpsConfig(badFile), expected);
  }
});

function request(server, { secure = true, pathname = '/', method = 'GET', body,
  host = 'tourn-svr.home.arpa:3443', headers = {}, trust = true, servername = 'tourn-svr.home.arpa' } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = (secure ? https : http).request({
      hostname: '127.0.0.1', port: server.address().port, path: pathname, method,
      ...(secure ? { servername, ...(trust ? { ca: fs.readFileSync(config.caFile) } : {}) } : {}),
      headers: { Host: host, ...(payload === undefined ? {} :
        { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Origin: `https://${host}` }),
      ...headers }
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (data) => { raw += data; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw,
        json: res.headers['content-type']?.includes('application/json') ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function setup(t, enabled = true) {
  const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'https-web-'));
  const store = await createAccountSessions({ file: path.join(privateRoot, 'accounts.db') });
  await store.createAccount({ userId: 'admin', password: 'A long administrator test phrase1!', roles: ['administrator'], actor: 'test' });
  const app = express();
  let accountWeb = createAccountWeb({ store, config: enabled ? config : null, surface: 'pre' });
  app.use((req, res, next) => accountWeb(req, res, next));
  app.use(express.json({ limit: '50mb' }));
  app.use((req, res, next) => {
    if (!req.socket.encrypted) res.set('Access-Control-Allow-Origin', '*');
    next();
  });
  app.post('/api/rings/ring-a-1/heartbeat', (req, res) => res.json({ ok: true, value: req.body.value }));
  app.post('/api/events/create', (req, res) => res.json({ ok: true }));
  app.get('/api/rings/monitor', (_req, res) => res.json({ audience: true }));
  app.get('/api/groups', (_req, res) => res.json({ groups: [] }));
  app.get('/api/events/list', (_req, res) => res.json({ events: [] }));
  app.get('/api/rings/config', (_req, res) => res.json({ allowedRings: [] }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', (_req, res) => res.json({ reachedHandler: true }));
  registerPageRoutes(app, path.resolve(__dirname, '..'), path.resolve(__dirname, '..', 'head-table'), 'pre');
  const tlsServer = https.createServer(loadHttpsConfig(configFile).options, app).listen(0, '127.0.0.1');
  const httpServer = http.createServer(app).listen(0, '127.0.0.1');
  await Promise.all([tlsServer, httpServer].map((server) => new Promise((resolve) => server.once('listening', resolve))));
  t.after(async () => {
    await Promise.all([tlsServer, httpServer].map((server) => new Promise((resolve) => server.close(resolve))));
    await store.close();
    fs.rmSync(privateRoot, { recursive: true, force: true });
  });
  return { tlsServer, httpServer, store, restartAuthorization: () => {
    accountWeb = createAccountWeb({ store, config: enabled ? config : null, surface: 'pre' });
  } };
}

test('staged listeners require trusted CA/name, serve account UI, and preserve legacy HTTP without exposing login', async (t) => {
  const { tlsServer, httpServer } = await setup(t);
  for (const pathname of ['/account/users', '/account/settings']) {
    assert.equal((await request(tlsServer, { pathname })).status, 302);
  }
  assert.equal((await request(tlsServer, { pathname: '/account/index.html' })).status, 404);
  const headers = await roleLogin(tlsServer, 'admin');
  for (const pathname of ['/account/users', '/account/settings', '/account/login']) {
    const response = await request(tlsServer, { pathname, headers });
    assert.equal(response.status, 200);
    assert.match(response.raw, /Account Administration/);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  assert.equal((await request(tlsServer, { pathname: '/account/users', host: 'evil.example:3443' })).status, 403);
  await assert.rejects(request(tlsServer, { pathname: '/account/users', trust: false }), /certificate|issuer/i);
  await assert.rejects(request(tlsServer, { pathname: '/account/users', servername: 'other.home.arpa' }), /Hostname|IP does not match/i);
  const blocked = await request(httpServer, { secure: false, pathname: '/account/users' });
  assert.equal(blocked.status, 426);
  assert.match(blocked.raw, /https:\/\/tourn-svr.home.arpa:3443/);
  const settings = await request(httpServer, { secure: false, pathname: '/account/settings?embedded=1' });
  assert.equal(settings.status, 426);
  assert.match(settings.raw, /view=user-account-settings/);
  const login = await request(httpServer, { secure: false, pathname: '/api/account/login', method: 'POST',
    body: { userId: 'admin', password: 'A long administrator test phrase1!' } });
  assert.equal(login.status, 403);
  assert.equal(login.headers['set-cookie'], undefined);
  const legacy = await request(httpServer, { secure: false, pathname: '/api/rings/ring-a-1/heartbeat',
    method: 'POST', body: { value: 42 }, headers: { Origin: '', 'User-Agent': 'Dalvik/2.1.0 (Android)' } });
  assert.equal(legacy.status, 200);
  assert.deepEqual(legacy.json, { ok: true, value: 42 });
  assert.equal(legacy.headers['access-control-allow-origin'], '*');
  const status = await request(httpServer, { secure: false, pathname: '/api/https-status' });
  assert.equal(status.json.legacyHttpEnabled, true);
  assert.equal(status.json.browserAuthorizationEnforced, true);
  assert.equal(status.json.tournamentAuthorizationEnforced, false);
});

async function roleLogin(server, userId) {
  const response = await request(server, { pathname: '/api/account/login', method: 'POST',
    body: { userId, password: 'A long administrator test phrase1!' } });
  assert.equal(response.status, 200);
  return { Cookie: response.headers['set-cookie'][0].split(';')[0], 'X-CSRF-Token': response.json.csrfToken };
}

test('browser page aliases require sign-in and deny disallowed roles; raw repository files cannot bypass authorization', async (t) => {
  const { tlsServer, httpServer, store } = await setup(t);
  await store.createAccount({ userId: 'viewer', password: 'A long administrator test phrase1!', roles: ['viewer'], actor: 'test' });
  const paths = ['/tournament-management/', '/tournament-management/index.html', '/head-table/',
    '/head-table/index.html', '/head-table.html', '/dashboard/', '/control-board',
    '/event-progress/', '/administration-progress.html', '/audience-monitor/', '/audience-monitor/index.html',
    '/ring-assignment/', '/competitors/', '/simulator/', '/admin/'];
  for (const pathname of paths) {
    const unsigned = await request(tlsServer, { pathname });
    assert.equal(unsigned.status, 302, pathname);
    assert.match(unsigned.headers.location, /^\/account\/login\?returnTo=/);
    assert.equal((await request(httpServer, { secure: false, pathname })).status, 426);
  }
  const headers = await roleLogin(tlsServer, 'viewer');
  assert.equal((await request(tlsServer, { pathname: '/account/users', headers })).status, 403);
  assert.equal((await request(tlsServer, { pathname: '/account/settings', headers })).status, 403);
  assert.equal((await request(tlsServer, { pathname: '/account/profile', headers })).status, 200);
  for (const pathname of paths) {
    const result = await request(tlsServer, { pathname, headers });
    assert.equal(result.status, pathname.includes('audience-monitor') ? 200 :
      pathname.includes('tournament-management') ? 302 : 403, pathname);
  }
  for (const pathname of ['/db/tournament.db', '/events/active.json', '/backend/accountSessions.js',
    '/Results/result.json', '/app-releases/current.json', '/package.json', '/README.md', '/app-debug.apk',
    '/node_modules/express/package.json', '/group-server.js', '/assets/../backend/accountSessions.js']) {
    assert.equal((await request(tlsServer, { pathname, headers })).status, pathname.includes('/../') ? 400 : 404, pathname);
  }
});

test('all five roles have enforced API permissions, including union of roles and read-only Viewer', async (t) => {
  const { tlsServer, store } = await setup(t);
  const roleHeaders = {};
  for (const [index, role] of Object.keys(ROLE_LABELS).entries()) {
    const userId = `role-${index}`;
    await store.createAccount({ userId, password: 'A long administrator test phrase1!', roles: [role], actor: 'test' });
    roleHeaders[role] = await roleLogin(tlsServer, userId);
  }
  const cases = [
    ['GET', '/api/events/list', ['administrator', 'event-coordinator', 'judging-coordinator', 'tournament-operator']],
    ['GET', '/api/version', ['administrator', 'event-coordinator', 'judging-coordinator', 'tournament-operator']],
    ['POST', '/api/events/create', ['administrator', 'event-coordinator']],
    ['GET', '/api/groups', ['administrator', 'event-coordinator', 'tournament-operator']],
    ['GET', '/api/rings/monitor', ['administrator', 'event-coordinator', 'tournament-operator', 'viewer']],
    ['GET', '/api/ring-judges', ['administrator', 'event-coordinator', 'judging-coordinator']],
    ['POST', '/api/volunteers/import', ['administrator', 'event-coordinator', 'judging-coordinator']],
    ['POST', '/api/rings/ring-a-1/queue', ['administrator', 'event-coordinator', 'tournament-operator']],
    ['POST', '/api/rings/ring-a-1/heartbeat', ['administrator', 'event-coordinator', 'tournament-operator']],
    ['PUT', '/api/visual-definitions', ['administrator']],
    ['GET', '/api/simulator/runs', ['administrator', 'event-coordinator', 'tournament-operator', 'viewer']],
    ['GET', '/api/simulator/runs/rehearsal/log', ['administrator']],
    ['GET', '/api/simulator/runs/rehearsal/audience', ['administrator', 'event-coordinator', 'tournament-operator', 'viewer']],
    ['POST', '/api/simulator/runs/rehearsal/start', ['administrator']],
    ['GET', '/api/tournament-results', ['administrator', 'event-coordinator']],
    ['POST', '/api/reset', ['administrator']]
  ];
  for (const [role, headers] of Object.entries(roleHeaders)) {
    for (const [method, pathname, permitted] of cases) {
      const response = await request(tlsServer, { pathname, method, headers,
        ...(method === 'GET' ? {} : { body: {} }) });
      assert.equal(response.status, permitted.includes(role) ? 200 : 403, `${role}: ${method} ${pathname}`);
    }
    const response = await request(tlsServer, { pathname: '/api/account/session', headers });
    assert.deepEqual(response.json.allowedViews, allowedViews([role]));
    assert.equal(response.json.roleLabels.viewer, 'Viewer');
    if (role !== 'viewer') {
      for (const view of ['head-table', 'ring-judges', 'users', 'clinic-management', 'judge-management', 'server-maintenance']) {
        assert.equal((await request(tlsServer, { pathname: `/tournament-management/?view=${view}`, headers })).status,
          allowedViews([role]).includes(view) ? 200 : 403, `${role}: workspace ${view}`);
      }
    }
  }
  await store.createAccount({ userId: 'combined', password: 'A long administrator test phrase1!',
    roles: ['viewer', 'judging-coordinator'], actor: 'test' });
  const combined = await roleLogin(tlsServer, 'combined');
  assert.equal((await request(tlsServer, { pathname: '/api/ring-judges', headers: combined })).status, 200);
  assert.equal((await request(tlsServer, { pathname: '/api/rings/monitor', headers: combined })).status, 200);
  assert.equal((await request(tlsServer, { pathname: '/api/groups', headers: combined })).status, 403);
});

test('browser API mutations require same-origin JSON and shared session CSRF before parsers/handlers', async (t) => {
  const { tlsServer } = await setup(t);
  const headers = await roleLogin(tlsServer, 'admin');
  const pathname = '/api/events/create';
  assert.equal((await request(tlsServer, { pathname })).status, 401);
  for (const changes of [{ Origin: '' }, { Origin: 'https://evil.example' },
    { 'Sec-Fetch-Site': 'cross-site' }, { Host: 'evil.example:3443' },
    { 'X-CSRF-Token': '' }, { 'X-CSRF-Token': '0'.repeat(64) }]) {
    assert.equal((await request(tlsServer, { pathname, method: 'POST', body: {}, headers: { ...headers, ...changes } })).status, 403);
  }
  assert.equal((await request(tlsServer, { pathname, method: 'POST', body: {},
    headers: { ...headers, 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request(tlsServer, { pathname: '/api/new-unclassified-endpoint', headers })).status, 404);
  assert.equal((await request(tlsServer, { pathname: '/api/rings/ring-a-1/bootstrap', headers })).status, 404);
  assert.equal((await request(tlsServer, { pathname: '/api/events/create', method: 'POST', body: {}, headers })).status, 200);
});

test('role changes, disabling, policy revocation and logout revoke live browser API access', async (t) => {
  const { tlsServer, store } = await setup(t);
  let user = await store.createAccount({ userId: 'event-user', password: 'A long administrator test phrase1!',
    roles: ['event-coordinator'], actor: 'test' });
  let headers = await roleLogin(tlsServer, 'event-user');
  assert.equal((await request(tlsServer, { pathname: '/api/events/create', method: 'POST', body: {}, headers })).status, 200);
  user = await store.changeAccount({ userId: user.userId, revision: user.revision, roles: ['viewer'], actor: 'test' });
  assert.equal((await request(tlsServer, { pathname: '/api/groups', headers })).status, 401);
  headers = await roleLogin(tlsServer, 'event-user');
  assert.equal((await request(tlsServer, { pathname: '/api/groups', headers })).status, 403);
  await store.changeAccount({ userId: user.userId, revision: user.revision, enabled: false, actor: 'test' });
  assert.equal((await request(tlsServer, { pathname: '/api/rings/monitor', headers })).status, 401);
  const admin = await roleLogin(tlsServer, 'admin');
  assert.equal((await request(tlsServer, { pathname: '/api/account/logout', method: 'POST', body: {}, headers: admin })).status, 204);
  assert.equal((await request(tlsServer, { pathname: '/api/events/list', headers: admin })).status, 401);
});

test('current roles apply when role-change revocation is disabled, and restarting authorization rotates CSRF without losing sessions', async (t) => {
  const { tlsServer, store, restartAuthorization } = await setup(t);
  const saved = await store.getPolicy();
  await store.changePolicy({ revision: saved.revision, policy: { ...saved.policy, revokeOnRoleChange: false }, actor: 'test' });
  let user = await store.createAccount({ userId: 'changing-role', password: 'A long administrator test phrase1!',
    roles: ['event-coordinator'], actor: 'test' });
  const headers = await roleLogin(tlsServer, user.userId);
  user = await store.changeAccount({ userId: user.userId, revision: user.revision, roles: ['viewer'], actor: 'test' });
  assert.equal((await request(tlsServer, { pathname: '/api/events/create', method: 'POST', body: {}, headers })).status, 403);
  assert.equal((await request(tlsServer, { pathname: '/api/rings/monitor', headers })).status, 200);
  const admin = await roleLogin(tlsServer, 'admin');
  restartAuthorization();
  assert.equal((await request(tlsServer, { pathname: '/api/events/create', method: 'POST', body: {}, headers: admin })).status, 403);
  const session = await request(tlsServer, { pathname: '/api/account/session', headers: admin });
  assert.equal(session.status, 200);
  assert.notEqual(session.json.csrfToken, admin['X-CSRF-Token']);
  admin['X-CSRF-Token'] = session.json.csrfToken;
  assert.equal((await request(tlsServer, { pathname: '/api/events/create', method: 'POST', body: {}, headers: admin })).status, 200);
});

test('only exact Dalvik native-tablet calls bypass browser login, never browser traffic or unclassified endpoints', async (t) => {
  const { tlsServer, httpServer } = await setup(t);
  const native = { 'User-Agent': 'Dalvik/2.1.0 (Linux; Android)', Origin: '' };
  for (const [method, pathname] of [
    ['GET', '/api/rings/config'], ['GET', '/api/rings/ring-a-1/current'],
    ['POST', '/api/rings/ring-a-1/request-group'], ['POST', '/api/rings/ring-a-1/heartbeat'],
    ['POST', '/api/rings/ring-a-1/complete'], ['POST', '/api/rings/ring-a-1/assistance'],
    ['POST', '/api/rings/ring-a-1/assistance/clear']
  ]) {
    for (const secure of [true, false]) {
      assert.equal((await request(secure ? tlsServer : httpServer, {
        secure, method, pathname, headers: native, ...(method === 'POST' ? { body: {} } : {})
      })).status, 200, pathname);
    }
  }
  for (const headers of [{ 'User-Agent': 'Mozilla/5.0' },
    { ...native, Origin: 'https://tourn-svr.home.arpa:3443' },
    { ...native, 'Sec-Fetch-Site': 'none' }, { ...native, Cookie: 'unrelated=1' }]) {
    assert.equal((await request(tlsServer, { pathname: '/api/rings/config', headers })).status, 401);
  }
  assert.equal((await request(tlsServer, { pathname: '/api/events/list', headers: native })).status, 401);
  assert.equal((await request(tlsServer, { pathname: '/api/rings/ring-a-1/queue', method: 'POST', body: {}, headers: native })).status, 403);
  assert.equal(isTabletEndpoint('GET', '/api/rings/ring-a-1/bootstrap'), false);
  assert.equal(apiRoles('DELETE', '/api/events/list'), null);
  assert.equal(hasRole(['viewer'], apiRoles('GET', '/api/rings/monitor')), true);
});

test('mounted account API applies its size/origin/CSRF checks before legacy parsers and CORS', async (t) => {
  const { tlsServer } = await setup(t);
  assert.equal((await request(tlsServer, { pathname: '/api/account/users' })).status, 401);
  const login = await request(tlsServer, { pathname: '/api/account/login', method: 'POST',
    body: { userId: 'admin', password: 'A long administrator test phrase1!' } });
  assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie'][0], /Secure/);
  const headers = { Cookie: login.headers['set-cookie'][0].split(';')[0], 'X-CSRF-Token': login.json.csrfToken };
  const users = await request(tlsServer, { pathname: '/api/account/users', headers });
  assert.equal(users.status, 200);
  assert.equal(users.json.users[0].userId, 'admin');
  const oversized = await request(tlsServer, { pathname: '/api/account/login', method: 'POST', body: { password: 'x'.repeat(9000) } });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.headers['access-control-allow-origin'], undefined);
  assert.equal((await request(tlsServer, { pathname: '/api/account/policy', method: 'PUT',
    headers: { ...headers, Origin: 'https://evil.example' }, body: {} })).status, 403);
  assert.equal((await request(tlsServer, { pathname: '/api/account/logout', method: 'POST',
    headers: { Cookie: headers.Cookie }, body: {} })).status, 403);
});

test('unconfigured HTTP installations block all account routes rather than web-serving the UI', async (t) => {
  const { httpServer } = await setup(t, false);
  for (const pathname of ['/account/users', '/account/account.js', '/api/account/login']) {
    assert.equal((await request(httpServer, { secure: false, pathname })).status, 503);
  }
});
