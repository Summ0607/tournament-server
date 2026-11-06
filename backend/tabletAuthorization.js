const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const express = require('express');
const QRCode = require('qrcode');
const { isTabletEndpoint, hasRole, apiRoles } = require('./browserPermissions');

const TOKEN = /^[a-f0-9]{64}$/;
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
function fail(message, statusCode = 400) {
  throw Object.assign(new Error(message), { statusCode });
}
function localDay(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function nextMidnight(timestamp) {
  const date = new Date(timestamp);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

async function createTabletStore({ file, now = Date.now }) {
  if (!path.isAbsolute(file)) throw new Error('An absolute private tablet database path is required.');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const root = fs.realpathSync(path.resolve(__dirname, '..'));
  const candidate = fs.existsSync(file) ? fs.realpathSync(file) : path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
  const relative = path.relative(root, candidate);
  if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
    throw new Error('Tablet database must be outside the web-served repository.');
  }
  const db = await new Promise((resolve, reject) => {
    const database = new sqlite3.Database(file, (error) => error ? reject(error) : resolve(database));
  });
  db.configure('busyTimeout', 5000);
  const run = (sql, params = []) => new Promise((resolve, reject) =>
    db.run(sql, params, (error) => error ? reject(error) : resolve()));
  const get = (sql, params = []) => new Promise((resolve, reject) =>
    db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
  const close = () => new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  try {
    await run('CREATE TABLE IF NOT EXISTS pairing_secret (id INTEGER PRIMARY KEY CHECK(id=1), secret TEXT NOT NULL)');
    await run('INSERT OR IGNORE INTO pairing_secret VALUES (1, ?)', [crypto.randomBytes(32).toString('hex')]);
    await run(`CREATE TABLE IF NOT EXISTS tablet_credentials (
      event TEXT NOT NULL, day TEXT NOT NULL, ring TEXT NOT NULL, device TEXT NOT NULL,
      label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires INTEGER NOT NULL,
      PRIMARY KEY(event, day, ring), UNIQUE(event, day, device)
    )`);
    fs.chmodSync(file, 0o600);
  } catch (error) { await close(); throw error; }
  const { secret } = await get('SELECT secret FROM pairing_secret WHERE id=1');
  let queue = Promise.resolve();
  function transaction(callback) {
    const result = queue.then(async () => {
      await run('BEGIN IMMEDIATE');
      try {
        const value = await callback();
        await run('COMMIT');
        return value;
      } catch (error) {
        try { await run('ROLLBACK'); }
        catch (rollbackError) { console.error('Unable to roll back tablet authorization:', rollbackError); }
        throw error;
      }
    });
    queue = result.then(() => undefined, () => undefined);
    return result;
  }
  function dailyToken(event, ring, day) {
    return crypto.createHmac('sha256', secret).update(JSON.stringify([event, ring, day])).digest('hex');
  }
  function code({ event, ring, ringLabel, server }) {
    const timestamp = now(), day = localDay(timestamp);
    return { type: 'tournament-ring', version: 1, server, event, ringId: ring, ringLabel,
      day, expiresAt: nextMidnight(timestamp), token: dailyToken(event, ring, day) };
  }
  function pair(input, context) {
    return transaction(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Invalid tablet pairing details.');
      const { event, ringId: ring, day, token, deviceId: device, tabletLabel: label, replace } = input;
      const timestamp = now();
      if (event !== context.event || !Object.hasOwn(context.rings, ring) || !event ||
          day !== localDay(timestamp) || !TOKEN.test(token || '')) fail('This ring QR code is expired or is not for the active tournament.', 401);
      if (!crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(dailyToken(event, ring, day), 'hex'))) {
        fail('Invalid ring QR code. Scan the code displayed by the server.', 401);
      }
      if (typeof device !== 'string' || !/^[a-f0-9-]{36}$/.test(device) ||
          typeof label !== 'string' || !label.trim() || label.length > 100 ||
          replace !== undefined && typeof replace !== 'boolean') fail('Invalid tablet pairing details.');
      const previous = await get('SELECT device, label FROM tablet_credentials WHERE event=? AND day=? AND ring=?', [event, day, ring]);
      if (previous && previous.device !== device && replace !== true) {
        fail(`Ring ${context.rings[ring].ringLabel || ring} is authorized to ${previous.label}. Replace that tablet?`, 409);
      }
      const credential = crypto.randomBytes(32).toString('hex'), expiresAt = nextMidnight(timestamp);
      await run('DELETE FROM tablet_credentials WHERE expires<=? OR (event=? AND day=? AND (ring=? OR device=?))',
        [timestamp, event, day, ring, device]);
      await run('INSERT INTO tablet_credentials VALUES (?, ?, ?, ?, ?, ?, ?)',
        [event, day, ring, device, label.trim(), digest(credential), expiresAt]);
      return { credential, ringId: ring, ringLabel: context.rings[ring].ringLabel || ring, event, day, expiresAt };
    });
  }
  async function resolve(token, context) {
    if (!TOKEN.test(token || '')) return null;
    await queue;
    const row = await get('SELECT * FROM tablet_credentials WHERE token_hash=?', [digest(token)]);
    if (!row || row.expires <= now() || row.day !== localDay(now()) ||
        row.event !== context.event || !Object.hasOwn(context.rings, row.ring)) return null;
    return { ringId: row.ring, ringLabel: context.rings[row.ring].ringLabel || row.ring,
      event: row.event, day: row.day, expiresAt: row.expires };
  }
  return { code, pair, resolve, async close() { await queue; await close(); } };
}

function createTabletRouter({ store, security, getContext, serverOrigins, allowedOrigins }) {
  const router = express.Router();
  router.use('/api/tablet', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!req.socket.encrypted) return res.status(426).json({ error: 'Tablet authorization requires HTTPS.' });
    if (!allowedOrigins.includes(`https://${req.get('host')}`)) return res.status(403).json({ error: 'Use the configured HTTPS server address.' });
    next();
  });
  router.post('/api/tablet/codes', express.json({ limit: '2kb' }), async (req, res, next) => {
    try {
      security.verifyRequest(req);
      const session = await security.authenticate(req, res);
      if (!hasRole(session.account.roles, apiRoles('POST', '/api/tablet/codes'))) fail('Ring Assignment permission required.', 403);
      const context = getContext(), ring = req.body.ringId;
      if (req.body.useIp !== undefined && typeof req.body.useIp !== 'boolean') fail('Select DNS or IP for the QR address.');
      if (!context.event) fail('Activate a tournament before displaying ring QR codes.');
      if (typeof ring !== 'string' || !Object.hasOwn(context.rings, ring)) fail('Select a configured ring.');
      const payload = store.code({ event: context.event, ring, ringLabel: context.rings[ring].ringLabel || ring,
        server: serverOrigins[req.body.useIp === false ? 0 : 1] });
      res.json({ ringId: ring, ringLabel: payload.ringLabel, event: payload.event, day: payload.day,
        server: payload.server, expiresAt: payload.expiresAt,
        image: await QRCode.toDataURL(JSON.stringify(payload), { width: 640, margin: 4, errorCorrectionLevel: 'M' }) });
    } catch (error) { next(error); }
  });
  router.post('/api/tablet/pair', express.json({ limit: '2kb' }), async (req, res, next) => {
    try {
      if (req.get('origin') || req.get('cookie') || req.get('sec-fetch-site')) fail('Use the tablet app to scan the ring QR code.', 403);
      res.json(await store.pair(req.body, getContext()));
    } catch (error) { next(error); }
  });
  router.use(async (req, res, next) => {
    if (!req.get('authorization')) return next();
    try {
      if (!req.socket.encrypted) fail('Tablet authorization requires HTTPS.', 426);
      if (req.get('origin') || req.get('cookie') || req.get('sec-fetch-site')) fail('Tablet credentials cannot be used as a browser session.', 403);
      if (!allowedOrigins.includes(`https://${req.get('host')}`)) fail('Use the configured HTTPS server address.', 403);
      const token = /^Bearer ([a-f0-9]{64})$/.exec(req.get('authorization'))?.[1];
      const session = await store.resolve(token, getContext());
      if (!session) fail('Tablet authorization expired or was replaced. Scan today\'s ring QR code.', 401);
      if (req.path === '/api/tablet/session' && req.method === 'GET') return res.json(session);
      if (!isTabletEndpoint(req.method, req.path)) fail('Tablet credentials do not permit this operation.', 403);
      const ring = /^\/api\/rings\/([^/]+)\//.exec(req.path)?.[1];
      if (ring && decodeURIComponent(ring) !== session.ringId) fail('This tablet is authorized for a different ring.', 403);
      res.locals.tabletSession = session;
      next();
    } catch (error) { next(error); }
  });
  router.use((error, _req, res, _next) => {
    if (!error.statusCode && !error.status) console.error('Tablet authorization failed:', error);
    const status = error.statusCode || error.status || 500;
    res.status(status).json({ error: status < 500 ? error.message : 'Unable to authorize tablet. Check the server log.' });
  });
  return router;
}
module.exports = { createTabletStore, createTabletRouter, localDay, nextMidnight };
