const crypto = require('node:crypto');
const COOKIE_NAME = '__Host-tournament-session';
const COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: 'strict', path: '/' };
function createBrowserSecurity({ store, allowedOrigins }) {
  const key = crypto.randomBytes(32);
  const fail = (message, statusCode) => { throw Object.assign(new Error(message), { statusCode }); };
  const csrf = (token) => crypto.createHmac('sha256', key).update(token).digest('hex');
  function sessionToken(req) {
    const cookies = (req.get('cookie') || '').split(';').map((cookie) => cookie.trim())
      .filter((cookie) => cookie.startsWith(`${COOKIE_NAME}=`));
    if (cookies.length !== 1) return '';
    const token = cookies[0].slice(COOKIE_NAME.length + 1);
    return /^[a-f0-9]{64}$/.test(token) ? token : '';
  }
  function verifyRequest(req) {
    if (!req.socket.encrypted) fail('Browser access requires HTTPS.', 403);
    const origin = `https://${req.get('host')}`;
    if (!allowedOrigins.includes(origin)) fail('Unrecognized browser server address.', 403);
    if (req.get('origin') && req.get('origin') !== origin ||
        req.get('sec-fetch-site') && !['same-origin', 'none'].includes(req.get('sec-fetch-site'))) {
      fail('Browser requests must be same-origin.', 403);
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.get('origin') !== origin) fail('A same-origin request is required.', 403);
      if (!req.is('application/json')) fail('Browser requests require JSON.', 415);
    }
  }
  async function authenticate(req, res) {
    const token = sessionToken(req);
    const session = await store.resolveSession(token);
    if (!session) {
      res.clearCookie(COOKIE_NAME, COOKIE_OPTIONS);
      fail('Sign in to continue.', 401);
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      const supplied = req.get('x-csrf-token') || '';
      if (!/^[a-f0-9]{64}$/.test(supplied) ||
          !crypto.timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(csrf(token), 'hex'))) {
        fail('Request verification failed. Refresh session details and try again.', 403);
      }
    }
    res.locals.accountToken = token;
    res.locals.accountSession = session;
    return session;
  }
  return { csrf, verifyRequest, authenticate };
}
module.exports = { createBrowserSecurity, COOKIE_NAME, COOKIE_OPTIONS };
