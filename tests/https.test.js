const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const express = require('express');
const { HTTPS_PORTS, requirePrivateFile, loadHttpsConfig, httpsOrigins } = require('../backend/httpsConfig');
const { createAccountWeb } = require('../backend/accountWeb');
const { createAccountSessions } = require('../backend/accountSessions');

let root, configFile, config;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tournament-https-'));
  const openssl = process.env.OPENSSL_PATH || (process.platform === 'win32'
    ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl');
  const run = (args) => execFileSync(openssl, args, { stdio: 'pipe' });
  const file = (name) => path.join(root, name);
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=Test Root CA', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-keyout', file('ca-key.pem'), '-out', file('ca.pem')]);
  run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=tourn-svr.home.arpa',
    '-addext', 'subjectAltName=DNS:tourn-svr.home.arpa,IP:192.168.4.42',
    '-addext', 'basicConstraints=critical,CA:FALSE', '-addext', 'extendedKeyUsage=serverAuth',
    '-keyout', file('key.pem'), '-out', file('server.csr')]);
  run(['x509', '-req', '-in', file('server.csr'), '-CA', file('ca.pem'), '-CAkey', file('ca-key.pem'),
    '-CAcreateserial', '-days', '1', '-copy_extensions', 'copy', '-out', file('cert.pem')]);
  config = { hostname: 'tourn-svr.home.arpa', ipAddress: '192.168.4.42',
    keyFile: file('key.pem'), certFile: file('cert.pem'), caFile: file('ca.pem'),
    accountDatabase: file('accounts.db'), sourceLimit: { maxAttempts: 50, windowMs: 900000 } };
  configFile = file('server.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
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
  await store.createAccount({ userId: 'admin', password: 'a long administrator test phrase', roles: ['administrator'], actor: 'test' });
  const app = express();
  app.use(createAccountWeb({ store, config: enabled ? config : null, surface: 'pre' }));
  app.use(express.json({ limit: '50mb' }));
  app.use((req, res, next) => {
    if (!req.socket.encrypted) res.set('Access-Control-Allow-Origin', '*');
    next();
  });
  app.post('/api/legacy-tablet', (req, res) => res.json({ ok: true, value: req.body.value }));
  const tlsServer = https.createServer(loadHttpsConfig(configFile).options, app).listen(0, '127.0.0.1');
  const httpServer = http.createServer(app).listen(0, '127.0.0.1');
  await Promise.all([tlsServer, httpServer].map((server) => new Promise((resolve) => server.once('listening', resolve))));
  t.after(async () => {
    await Promise.all([tlsServer, httpServer].map((server) => new Promise((resolve) => server.close(resolve))));
    await store.close();
    fs.rmSync(privateRoot, { recursive: true, force: true });
  });
  return { tlsServer, httpServer, store };
}

test('staged listeners require trusted CA/name, serve account UI, and preserve legacy HTTP without exposing login', async (t) => {
  const { tlsServer, httpServer } = await setup(t);
  for (const pathname of ['/account/users', '/account/settings', '/account/index.html']) {
    const response = await request(tlsServer, { pathname });
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
    body: { userId: 'admin', password: 'a long administrator test phrase' } });
  assert.equal(login.status, 403);
  assert.equal(login.headers['set-cookie'], undefined);
  const legacy = await request(httpServer, { secure: false, pathname: '/api/legacy-tablet', method: 'POST', body: { value: 42 } });
  assert.equal(legacy.status, 200);
  assert.deepEqual(legacy.json, { ok: true, value: 42 });
  assert.equal(legacy.headers['access-control-allow-origin'], '*');
  const status = await request(httpServer, { secure: false, pathname: '/api/https-status' });
  assert.equal(status.json.legacyHttpEnabled, true);
  assert.equal(status.json.tournamentAuthorizationEnforced, false);
});

test('mounted account API applies its size/origin/CSRF checks before legacy parsers and CORS', async (t) => {
  const { tlsServer } = await setup(t);
  assert.equal((await request(tlsServer, { pathname: '/api/account/users' })).status, 401);
  const login = await request(tlsServer, { pathname: '/api/account/login', method: 'POST',
    body: { userId: 'admin', password: 'a long administrator test phrase' } });
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
