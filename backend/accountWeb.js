const express = require('express');
const path = require('node:path');
const { createAccountRouter } = require('./accountRoutes');
const { httpsOrigins } = require('./httpsConfig');

function createAccountWeb({ store, config, surface, rootDir = path.resolve(__dirname, '..') }) {
  const router = express.Router();
  const origins = config ? httpsOrigins(config, surface) : [];
  router.get('/api/https-status', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({
      enabled: Boolean(config), origin: origins[0] || null,
      legacyHttpEnabled: true, tournamentAuthorizationEnforced: false
    });
  });
  router.use(['/account', '/api/account'], (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    if (!config) return res.status(503).json({ error: 'HTTPS account access is not configured. Run setup-https.ps1 and start with TOURNAMENT_HTTPS_CONFIG.' });
    if (!req.socket.encrypted) {
      if (req.originalUrl.startsWith('/account') && ['GET', 'HEAD'].includes(req.method)) {
        const view = req.originalUrl.split('?')[0] === '/account/settings' ? 'user-account-settings' : 'users';
        return res.status(426).type('html').send(
          `<!doctype html><html lang="en"><meta charset="utf-8"><title>HTTPS required</title><h1>Account administration requires HTTPS</h1><p>The temporary HTTP service remains unsecured for tablet compatibility.</p><p><a target="_top" href="${origins[0]}/tournament-management/?view=${view}">Open secure Tournament Management</a></p><p>First install trust for the public Root CA certificate. Do not bypass certificate warnings.</p></html>`
        );
      }
      return res.status(403).json({ error: 'Account access requires HTTPS. Do not send passwords over HTTP.' });
    }
    if (!origins.includes(`https://${req.get('host')}`)) {
      return res.status(403).json({ error: 'Use the configured HTTPS server name or IP address.' });
    }
    next();
  });
  if (config) {
    router.use('/api/account', createAccountRouter({ store, allowedOrigins: origins, sourceLimit: config.sourceLimit }));
    router.get(['/account', '/account/', '/account/login', '/account/users', '/account/settings'], (_req, res) => {
      res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'; form-action 'self'; base-uri 'none'");
      res.sendFile(path.join(rootDir, 'account', 'index.html'));
    });
    router.use('/account', express.static(path.join(rootDir, 'account'), { index: false, redirect: false }));
    router.use('/account', (_req, res) => res.status(404).json({ error: 'Account page not found.' }));
  }
  return router;
}

module.exports = { createAccountWeb };
