const crypto = require('node:crypto');
const express = require('express');

function isLocalRequest(req) {
  const address = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return false;
  const host = req.get('host') || '';
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) return false;
  const origin = req.get('origin');
  if (origin && origin !== `${req.protocol}://${host}`) return false;
  const site = req.get('sec-fetch-site');
  return !site || site === 'same-origin' || site === 'none';
}

function createServerControl({ enabled, requestRestart, instanceId = crypto.randomUUID() }) {
  const router = express.Router();
  const token = crypto.randomBytes(32).toString('hex');
  let restarting = false;

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use((req, res, next) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: 'Server controls are available only on the server computer using localhost.' });
    next();
  });
  router.get('/status', (_req, res) => {
    res.json({ instanceId, restartAvailable: enabled, restarting, token,
      message: enabled ? 'Managed launcher connected.' : 'Restart unavailable. Start the server using server-launcher.js.' });
  });
  router.post('/restart', (req, res) => {
    if (!enabled) return res.status(409).json({ error: 'Restart requires server-launcher.js. The current server was not started with the managed launcher.' });
    if (req.get('x-server-control-token') !== token || req.body?.confirmation !== 'RESTART') {
      return res.status(403).json({ error: 'Restart confirmation is invalid. Refresh this page and try again.' });
    }
    if (restarting) return res.status(409).json({ error: 'A restart is already in progress.' });
    restarting = true;
    res.once('finish', requestRestart);
    return res.status(202).json({ instanceId, restarting: true });
  });
  return router;
}

module.exports = { createServerControl, isLocalRequest };
