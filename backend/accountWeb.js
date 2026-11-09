const express = require('express');
const path = require('node:path');
const { createAccountRouter } = require('./accountRoutes');
const { httpsOrigins } = require('./httpsConfig');
const { createBrowserSecurity } = require('./browserSecurity');
const { createBrowserAuthorization } = require('./browserAuthorization');
const { createTabletRouter } = require('./tabletAuthorization');

function createAccountWeb({ store, config, surface, tabletStore, getTabletContext, rootDir = path.resolve(__dirname, '..') }) {
  const router = express.Router();
  const origins = config ? httpsOrigins(config, surface) : [];
  const security = config ? createBrowserSecurity({ store, allowedOrigins: origins }) : null;
  router.get('/api/https-status', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({
      enabled: Boolean(config), origin: origins[0] || null,
      legacyHttpEnabled: false, browserAuthorizationEnforced: true,
      tabletAuthorizationEnforced: Boolean(tabletStore), tournamentAuthorizationEnforced: Boolean(tabletStore)
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
          `<!doctype html><html lang="en"><meta charset="utf-8"><title>HTTPS required</title><h1>Account administration requires HTTPS</h1><p>This installation supports HTTPS only.</p><p><a target="_top" href="${origins[0]}/tournament-management/?view=${view}">Open secure Tournament Management</a></p><p>First install trust for the public Root CA certificate. Do not bypass certificate warnings.</p></html>`
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
    router.use('/api/account', createAccountRouter({ store, allowedOrigins: origins, sourceLimit: config.sourceLimit, security }));
    router.get(['/account', '/account/', '/account/login', '/account/profile', '/account/users', '/account/settings'], async (req, res) => {
      try {
        security.verifyRequest(req);
        if (req.path !== '/account/login') {
          const session = await security.authenticate(req, res);
          if (req.path !== '/account/profile' && !session.account.roles.includes('administrator')) {
            return res.status(403).type('html').send('<h1>Administrator permission required</h1><a href="/">Home</a>');
          }
        }
      } catch (error) {
        if (error.statusCode === 401) return res.redirect('/account/login');
        if (!error.statusCode) console.error('Account page authorization failed:', error);
        return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Unable to verify account page access. Check the server log.' });
      }
      res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'; form-action 'self'; base-uri 'none'");
      res.sendFile(path.join(rootDir, 'account', 'index.html'));
    });
    router.get(['/account/account.js', '/account/style.css'], (req, res) => {
      res.sendFile(path.join(rootDir, 'account', path.basename(req.path)));
    });
    router.use('/account', (_req, res) => res.status(404).json({ error: 'Account page not found.' }));
  }
  if (config && tabletStore) {
    router.use(createTabletRouter({ store: tabletStore, security, getContext: getTabletContext,
      serverOrigins: httpsOrigins(config, 'pre'), allowedOrigins: origins }));
  }
  router.use(createBrowserAuthorization({ config, security }));
  return router;
}

module.exports = { createAccountWeb };
