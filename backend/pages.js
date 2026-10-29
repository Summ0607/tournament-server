const express = require('express');
const path = require('path');

function registerPageRoutes(app, rootDir, controlBoardDir, activeSurface) {
  const normalizedSurface = String(activeSurface || '').trim().toLowerCase();
  const isMonitoringSurface = normalizedSurface === 'monitoring';
  const isAdminProgressSurface = normalizedSurface === 'adminprogress';
  const progressPagePath = path.join(rootDir, 'head-table', 'index.html');
  app.get(['/simulator', '/simulator/'], (_req, res) => {
    res.sendFile(path.join(rootDir, 'simulator', 'index.html'));
  });
  app.get(['/admin', '/admin/'], (_req, res) => {
    res.sendFile(path.join(rootDir, 'admin', 'index.html'));
  });
  const canonicalProgressPath = isAdminProgressSurface ? '/administration-progress/' : '/event-progress/';
  const canonicalProgressHtml = isAdminProgressSurface ? '/administration-progress.html' : '/event-progress.html';
  const alternateProgressPath = isAdminProgressSurface ? '/event-progress/' : '/administration-progress/';
  const alternateProgressHtml = isAdminProgressSurface ? '/event-progress.html' : '/administration-progress.html';

  function sendProgressPage(res) {
    res.sendFile(progressPagePath);
  }

  function redirectToCanonicalProgress(res) {
    res.redirect(canonicalProgressPath);
  }

  function redirectToCanonicalHtml(res) {
    res.redirect(canonicalProgressHtml);
  }

  function exactRoute(pathname) {
    return new RegExp(`^${pathname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  }

  app.get(exactRoute('/audience-monitor'), (_req, res) => res.redirect('/audience-monitor/'));
  app.get([exactRoute('/audience-monitor/'), exactRoute('/audience-monitor.html')], (_req, res) => {
    res.sendFile(path.join(rootDir, 'audience-monitor', 'index.html'));
  });

  const legacyWorkflows = [
    { paths: ['/tournament-setup', '/tournament-mgmt', '/setup', '/event-administration', '/tournament-setup/event-definition'], view: 'event-setup' },
    { paths: ['/tournament-setup/import'], view: 'import' },
    { paths: ['/group-builder', '/tournament-setup/build-groups', '/tournament-setup/review-save'], view: 'groups' }
  ];
  legacyWorkflows.forEach(({ paths, view }) => {
    const routes = paths.flatMap((prefix) =>
      [prefix, `${prefix}/`, `${prefix}.html`, `${prefix}/index.html`].map(exactRoute));
    app.get(routes, (req, res) => {
      const source = view === 'groups' && req.query.source === 'saved' ? '&source=saved' : '';
      res.redirect(`/tournament-management/?view=${view}${source}`);
    });
  });

  if (!(isMonitoringSurface || isAdminProgressSurface)) {
    app.use('/head-table', express.static(controlBoardDir, { index: false }));
    app.use('/dashboard', express.static(controlBoardDir));
  }
  app.use('/ring-progress', express.static(path.join(rootDir, 'ring-progress'), { index: false, redirect: false }));
  app.use('/ring-assignment', express.static(path.join(rootDir, 'ring-assignment'), { index: false, redirect: false }));
  app.use('/rings', express.static(path.join(rootDir, 'ring-progress'), { redirect: false }));
  app.use('/ring-status', express.static(path.join(rootDir, 'ring-progress'), { redirect: false }));
  app.use(express.static(rootDir, { index: false, redirect: false }));
  app.use('/control-board-assets', express.static(controlBoardDir));

  if (isMonitoringSurface || isAdminProgressSurface) {
    app.get([exactRoute('/control-board'), exactRoute('/dashboard'), exactRoute('/head-table')], (req, res) => {
      res.redirect(canonicalProgressPath);
    });

    app.get([exactRoute('/control-board/'), exactRoute('/dashboard/'), exactRoute('/head-table/')], (req, res) => {
      res.redirect(canonicalProgressPath);
    });

    app.get([exactRoute('/control-board.html'), exactRoute('/dashboard.html'), exactRoute('/head-table.html')], (req, res) => {
      res.redirect(canonicalProgressHtml);
    });
  }

  app.get('/control-board', (req, res) => {
    res.sendFile(path.join(controlBoardDir, 'index.html'));
  });

  app.get('/status', (req, res) => {
    res.redirect('/api/rings');
  });

  app.get('/', (req, res) => {
    if (isMonitoringSurface || isAdminProgressSurface) {
      redirectToCanonicalProgress(res);
      return;
    }

    res.redirect('/tournament-management/');
  });

  app.get(exactRoute(canonicalProgressPath.slice(0, -1)), (req, res) => {
    redirectToCanonicalProgress(res);
  });

  app.get(exactRoute(canonicalProgressPath), (req, res) => {
    sendProgressPage(res);
  });

  app.get(exactRoute(canonicalProgressHtml), (req, res) => {
    sendProgressPage(res);
  });

  app.get(exactRoute(alternateProgressPath.slice(0, -1)), (req, res) => {
    redirectToCanonicalProgress(res);
  });

  app.get(exactRoute(alternateProgressPath), (req, res) => {
    redirectToCanonicalProgress(res);
  });

  app.get(exactRoute(alternateProgressHtml), (req, res) => {
    redirectToCanonicalHtml(res);
  });

  app.get('/dashboard', (req, res) => {
    res.redirect('/dashboard/');
  });

  app.get('/dashboard/', (req, res) => {
    res.sendFile(path.join(rootDir, 'head-table', 'index.html'));
  });

  app.get('/dashboard.html', (req, res) => {
    res.sendFile(path.join(rootDir, 'head-table', 'index.html'));
  });

  app.get('/head-table', (req, res) => {
    res.redirect('/head-table/');
  });

  app.get('/head-table/', (req, res) => {
    res.sendFile(path.join(rootDir, 'head-table', 'index.html'));
  });

  app.get('/rings', (req, res) => {
    res.redirect('/ring-progress/');
  });

  app.get('/rings/', (req, res) => {
    res.sendFile(path.join(rootDir, 'ring-progress', 'index.html'));
  });

  app.get('/ring-status', (req, res) => {
    res.redirect('/ring-progress/');
  });

  app.get('/ring-status/', (req, res) => {
    res.sendFile(path.join(rootDir, 'ring-progress', 'index.html'));
  });

  app.get('/ring-assignment', (req, res) => {
    res.redirect('/ring-assignment/');
  });

  app.get('/ring-assignment/', (req, res) => {
    res.sendFile(path.join(rootDir, 'ring-assignment', 'index.html'));
  });

  app.get('/ring-progress', (req, res) => {
    res.redirect('/ring-progress/');
  });

  app.get('/ring-progress/', (req, res) => {
    res.sendFile(path.join(rootDir, 'ring-progress', 'index.html'));
  });

  app.get(exactRoute('/tournament-management'), (req, res) => {
    res.redirect('/tournament-management/');
  });

  app.get(exactRoute('/tournament-management/'), (req, res) => {
    res.sendFile(path.join(rootDir, 'tournament-management', 'index.html'));
  });

  app.get(exactRoute('/tournament-management.html'), (req, res) => {
    res.sendFile(path.join(rootDir, 'tournament-management', 'index.html'));
  });

}

module.exports = {
  registerPageRoutes
};
