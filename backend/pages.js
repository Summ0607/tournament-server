const express = require('express');
const path = require('path');

function registerPageRoutes(app, rootDir, controlBoardDir, activeSurface) {
  const normalizedSurface = String(activeSurface || '').trim().toLowerCase();
  const isMonitoringSurface = normalizedSurface === 'monitoring';
  const isAdminProgressSurface = normalizedSurface === 'adminprogress';
  const progressPagePath = path.join(rootDir, 'head-table', 'index.html');
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

  if (!(isMonitoringSurface || isAdminProgressSurface)) {
    app.use('/head-table', express.static(controlBoardDir, { index: false }));
    app.use('/dashboard', express.static(controlBoardDir));
  }
  app.use('/ring-progress', express.static(path.join(rootDir, 'ring-progress')));
  app.use('/ring-assignment', express.static(path.join(rootDir, 'ring-assignment')));
  app.use('/event-administration', express.static(path.join(rootDir, 'event-administration')));
  app.use('/rings', express.static(path.join(rootDir, 'ring-progress')));
  app.use('/ring-status', express.static(path.join(rootDir, 'ring-progress')));
  app.use('/group-builder', express.static(path.join(rootDir, 'group-builder')));
  app.use(express.static(rootDir));
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
    redirectToCanonicalProgress(res);
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

  app.get('/group-builder', (req, res) => {
    res.redirect('/group-builder/');
  });

  app.get('/group-builder/', (req, res) => {
    res.sendFile(path.join(rootDir, 'group-builder', 'index.html'));
  });

  app.get('/group-builder.html', (req, res) => {
    res.sendFile(path.join(rootDir, 'group-builder', 'index.html'));
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

  app.get('/', (req, res) => {
    res.sendFile(path.join(rootDir, 'tournament-mgmt', 'index.html'));
  });

  app.get('/tournament-mgmt', (req, res) => {
    res.redirect('/tournament-mgmt/');
  });

  app.get('/tournament-mgmt/', (req, res) => {
    res.sendFile(path.join(rootDir, 'tournament-mgmt', 'index.html'));
  });

  app.get('/setup', (req, res) => {
    res.redirect('/event-administration/');
  });

  app.get('/setup/', (req, res) => {
    res.redirect('/event-administration/');
  });

  app.get('/setup.html', (req, res) => {
    res.redirect('/event-administration/');
  });

  app.get('/setup/index.html', (req, res) => {
    res.redirect('/event-administration/');
  });

  app.get('/event-administration', (req, res) => {
    res.redirect('/event-administration/');
  });

  app.get('/event-administration/', (req, res) => {
    res.sendFile(path.join(rootDir, 'event-administration', 'index.html'));
  });

  app.get('/event-administration.html', (req, res) => {
    res.sendFile(path.join(rootDir, 'event-administration', 'index.html'));
  });
}

module.exports = {
  registerPageRoutes
};
