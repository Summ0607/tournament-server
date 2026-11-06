const crypto = require('node:crypto');
const express = require('express');
const os = require('node:os');

function isLocalRequest(req, allowedHosts = []) {
  const address = req.socket.remoteAddress;
  const localAddresses = ['127.0.0.1', '::1', ...Object.values(os.networkInterfaces()).flat().map((entry) => entry.address)];
  if (!localAddresses.includes(String(address || '').replace(/^::ffff:/, ''))) return false;
  const host = req.get('host') || '';
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host) &&
      !allowedHosts.includes(host)) return false;
  const origin = req.get('origin');
  if (origin && origin !== `${req.protocol}://${host}`) return false;
  const site = req.get('sec-fetch-site');
  return !site || site === 'same-origin' || site === 'none';
}

function createServerControl({ enabled, requestRestart, instanceId = crypto.randomUUID(), allowedHosts = [], getGroupState }) {
  const router = express.Router();
  const token = crypto.randomBytes(32).toString('hex');
  let restarting = false;

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use((req, res, next) => {
    if (!isLocalRequest(req, allowedHosts)) return res.status(403).json({ error: 'Server controls are available only on the server computer using its configured HTTPS address.' });
    next();
  });
  router.get('/status', (_req, res) => {
    const group = getGroupState?.();
    res.json({ instanceId, restartAvailable: enabled && (group ? group.restartAvailable : true),
      restarting: group ? group.restarting : restarting, token, restartScope: group ? 'all-services' : 'single-service',
      services: group?.services,
      message: group ? group.message : enabled ? 'Single-service launcher only. Start all three with launch-surfaces.ps1 for coordinated restart.'
        : 'Restart unavailable. Start the server using launch-surfaces.ps1.' });
  });
  router.post('/restart', (req, res) => {
    if (!enabled) return res.status(409).json({ error: 'Restart requires server-launcher.js. The current server was not started with the managed launcher.' });
    if (req.get('x-server-control-token') !== token || req.body?.confirmation !== 'RESTART') {
      return res.status(403).json({ error: 'Restart confirmation is invalid. Refresh this page and try again.' });
    }
    if (restarting) return res.status(409).json({ error: 'A restart is already in progress.' });
    if (getGroupState && !getGroupState().restartAvailable) {
      return res.status(409).json({ error: getGroupState().message });
    }
    if (!getGroupState) restarting = true;
    res.once('finish', requestRestart);
    return res.status(202).json({ instanceId, restarting: true });
  });
  return router;
}

module.exports = { createServerControl, isLocalRequest };
