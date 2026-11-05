const crypto = require('node:crypto');
const express = require('express');

const COOKIE_NAME = '__Host-tournament-session';
const COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: 'strict', path: '/' };

function createAccountRouter({ store, allowedOrigins, sourceLimit, now = Date.now }) {
  if (!Array.isArray(allowedOrigins) || !allowedOrigins.length ||
      allowedOrigins.some((origin) => {
        try { return new URL(origin).protocol !== 'https:' || new URL(origin).origin !== origin; }
        catch { return true; }
      })) throw new Error('Explicit HTTPS origins are required for account routes.');
  if (!sourceLimit || !Number.isSafeInteger(sourceLimit.maxAttempts) || sourceLimit.maxAttempts < 1 ||
      !Number.isSafeInteger(sourceLimit.windowMs) || sourceLimit.windowMs < 1000) {
    throw new Error('An explicit source login rate limit is required.');
  }
  const router = express.Router();
  const csrfKey = crypto.randomBytes(32);
  const attempts = new Map();
  const csrf = (token) => crypto.createHmac('sha256', csrfKey).update(token).digest('hex');
  const fail = (message, statusCode) => { throw Object.assign(new Error(message), { statusCode }); };
  function sessionToken(req) {
    const cookies = (req.get('cookie') || '').split(';').map((cookie) => cookie.trim())
      .filter((cookie) => cookie.startsWith(`${COOKIE_NAME}=`));
    if (cookies.length !== 1) return '';
    const token = cookies[0].slice(COOKIE_NAME.length + 1);
    return /^[a-f0-9]{64}$/.test(token) ? token : '';
  }
  function body(req, keys) {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
        Object.keys(req.body).some((key) => !keys.includes(key))) fail('Invalid account request fields.', 400);
    return req.body;
  }
  function handle(callback) {
    return async (req, res, next) => {
      try { await callback(req, res, next); }
      catch (error) { next(error); }
    };
  }
  router.use(handle(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.removeHeader('Access-Control-Allow-Origin');
    res.removeHeader('Access-Control-Allow-Credentials');
    if (!req.socket.encrypted) fail('Account access requires HTTPS.', 403);
    const origin = `https://${req.get('host')}`;
    if (!allowedOrigins.includes(origin)) fail('Unrecognized account server address.', 403);
    if (req.get('origin') && req.get('origin') !== origin ||
        req.get('sec-fetch-site') && !['same-origin', 'none'].includes(req.get('sec-fetch-site'))) {
      fail('Account requests must be same-origin.', 403);
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.get('origin') !== origin) fail('A same-origin request is required.', 403);
      if (!req.is('application/json')) fail('Account requests require JSON.', 415);
    }
    next();
  }));
  router.use('/login', (req, res, next) => {
    if (req.method !== 'POST') return next();
    const timestamp = now();
    for (const [source, entry] of attempts) {
      if (timestamp >= entry.expiresAt) attempts.delete(source);
    }
    const source = req.socket.remoteAddress;
    if (!source) return res.status(403).json({ error: 'Unable to identify login source.' });
    let entry = attempts.get(source);
    if (!entry) {
      if (attempts.size >= 10000) {
        return res.status(429).set('Retry-After', String(Math.ceil(sourceLimit.windowMs / 1000)))
          .json({ error: 'Login service is busy. Try again shortly.' });
      }
      entry = { count: 0, expiresAt: timestamp + sourceLimit.windowMs };
      attempts.set(source, entry);
    }
    if (entry.count >= sourceLimit.maxAttempts) {
      return res.status(429).set('Retry-After', String(Math.ceil((entry.expiresAt - timestamp) / 1000)))
        .json({ error: 'Too many login attempts. Try again shortly.' });
    }
    entry.count++;
    next();
  });
  router.use(express.json({ limit: '8kb' }));
  router.post('/login', handle(async (req, res) => {
    const { userId, password } = body(req, ['userId', 'password']);
    const login = await store.login({ userId, password });
    res.cookie(COOKIE_NAME, login.token, { ...COOKIE_OPTIONS, maxAge: Math.max(0, login.expiresAt - now()) });
    res.json({ account: login.account, expiresAt: login.expiresAt, csrfToken: csrf(login.token) });
  }));
  router.use(handle(async (req, res, next) => {
    const token = sessionToken(req);
    const session = await store.resolveSession(token);
    if (!session) {
      res.clearCookie(COOKIE_NAME, COOKIE_OPTIONS);
      fail('Sign in to continue.', 401);
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      const supplied = req.get('x-csrf-token') || '';
      const expected = csrf(token);
      if (!/^[a-f0-9]{64}$/.test(supplied) ||
          !crypto.timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'))) {
        fail('Request verification failed. Refresh session details and try again.', 403);
      }
    }
    res.locals.accountToken = token;
    res.locals.accountSession = session;
    next();
  }));
  router.get('/session', (_req, res) => {
    res.json({ ...res.locals.accountSession, csrfToken: csrf(res.locals.accountToken) });
  });
  router.post('/activity', handle(async (req, res) => {
    body(req, []);
    const session = await store.resolveSession(res.locals.accountToken, { activity: true });
    if (!session) fail('Sign in to continue.', 401);
    res.json(session);
  }));
  router.post('/logout', handle(async (req, res) => {
    body(req, []);
    await store.logout(res.locals.accountToken);
    res.clearCookie(COOKIE_NAME, COOKIE_OPTIONS);
    res.status(204).end();
  }));
  router.use((_req, res, next) => {
    if (!res.locals.accountSession.account.roles.includes('administrator')) {
      return res.status(403).json({ error: 'Administrator permission is required.' });
    }
    next();
  });
  router.get('/users', handle(async (_req, res) => {
    res.json({ users: await store.listAccounts(res.locals.accountToken) });
  }));
  router.post('/users', handle(async (req, res) => {
    const fields = body(req, ['userId', 'password', 'roles']);
    const account = await store.createAccount({ ...fields, authorizationToken: res.locals.accountToken });
    res.status(201).json({ account });
  }));
  router.put('/users/:userId', handle(async (req, res) => {
    const fields = body(req, ['revision', 'roles', 'enabled', 'password']);
    const account = await store.changeAccount({
      ...fields, userId: req.params.userId, authorizationToken: res.locals.accountToken
    });
    res.json({ account });
  }));
  router.get('/policy', handle(async (_req, res) => {
    res.json(await store.getPolicy(res.locals.accountToken));
  }));
  router.put('/policy', handle(async (req, res) => {
    const fields = body(req, ['revision', 'policy']);
    res.json(await store.changePolicy({ ...fields, authorizationToken: res.locals.accountToken }));
  }));
  router.use((_req, res) => res.status(404).json({ error: 'Account endpoint not found.' }));
  router.use((error, _req, res, _next) => {
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed account JSON.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Account request is too large.' });
    if (!error.statusCode) console.error('Unable to process account request:', error);
    if (error.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds));
    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : 'Unable to process account request. Check the server log before retrying.'
    });
  });
  return router;
}

module.exports = { createAccountRouter, COOKIE_NAME };
