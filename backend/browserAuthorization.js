const {
  apiRoles, hasRole, VIEW_ROLES, homePath, pageView
} = require('./browserPermissions');

function createBrowserAuthorization({ config, security }) {
  return async (req, res, next) => {
    let pathname;
    try { pathname = decodeURIComponent(req.path); }
    catch { return res.status(400).json({ error: 'Invalid request path.' }); }
    if (/[\\\x00]/.test(pathname) || pathname.split('/').some((part) => part === '.' || part === '..')) {
      return res.status(400).json({ error: 'Invalid request path.' });
    }
    if (pathname === '/api/health' && ['GET', 'HEAD'].includes(req.method)) return next();
    if (res.locals.tabletSession) return next();
    if (['GET', 'HEAD'].includes(req.method) &&
        /^(?:\/assets\/|\/tournament-management\/|\/audience-monitor\/|\/control-board-assets\/)[a-zA-Z0-9._/-]+\.(?:js|css|png|svg|jpg|ico|woff2?)$/.test(pathname) &&
        !pathname.includes('/.')) return next();
    const isApi = pathname.startsWith('/api/') || ['/search', '/status', '/download-app'].includes(pathname);
    const view = pageView(pathname);
    if (!isApi && !view) return res.status(404).json({ error: 'Resource not available through this server.' });
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    if (!config || !req.socket.encrypted) {
      return res.status(426).type('html').send('<!doctype html><html lang="en"><meta charset="utf-8"><title>HTTPS required</title><h1>Browser access requires HTTPS</h1><p>Open the configured HTTPS Tournament Management address. This installation supports HTTPS only.</p></html>');
    }
    try {
      security.verifyRequest(req);
      const session = await security.authenticate(req, res);
      const roles = session.account.roles;
      if (isApi) {
        const allowed = apiRoles(req.method, pathname);
        if (!allowed) return res.status(404).json({ error: 'Endpoint not available.' });
        if (!hasRole(roles, allowed)) return res.status(403).json({ error: 'Your role does not permit this operation.' });
      } else {
        if (view === 'shell') {
          if (roles.length === 1 && roles[0] === 'viewer') return res.redirect('/audience-monitor/');
          const requested = req.query.view;
          if (requested && (!Object.hasOwn(VIEW_ROLES, requested) || !hasRole(roles, VIEW_ROLES[requested]))) {
            return res.status(403).type('html').send('<h1>Permission required</h1><p>This account cannot open that workspace.</p><a href="/">Return to your permitted home page</a>');
          }
          if (pathname === '/') return res.redirect(homePath(roles));
        } else if (!hasRole(roles, VIEW_ROLES[view])) {
          return res.status(403).type('html').send('<h1>Permission required</h1><p>This account cannot open that page.</p><a href="/">Return to your permitted home page</a>');
        }
      }
      return next();
    } catch (error) {
      if (error.statusCode === 401 && !isApi && ['GET', 'HEAD'].includes(req.method)) {
        return res.redirect(`/account/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
      }
      if (!error.statusCode) console.error('Browser authorization failed:', error);
      return res.status(error.statusCode || 500).json({
        error: error.statusCode ? error.message : 'Unable to verify browser access. Check the server log.'
      });
    }
  };
}
module.exports = { createBrowserAuthorization };
