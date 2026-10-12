const express = require('express');
const path = require('path');

function registerPageRoutes(app, rootDir, controlBoardDir, activeSurface) {
  const normalizedSurface = String(activeSurface || '').trim().toLowerCase();
  const isMonitoringSurface = normalizedSurface === 'monitoring';
  const isAdminProgressSurface = normalizedSurface === 'adminprogress';
  const progressPagePath = path.join(rootDir, 'head-table', 'index.html');

  function isAdminModeRequested(req) {
    return String(req.query && req.query.mode || '').trim().toLowerCase() === 'admin';
  }

  function sendPublicProgressPage(res) {
    res.sendFile(progressPagePath);
  }

  function redirectToAdminProgress(res) {
    res.redirect('/head-table/?mode=admin');
  }

  app.use('/head-table', express.static(controlBoardDir, { index: false }));
  app.use('/dashboard', express.static(controlBoardDir));
  app.use('/ring-progress', express.static(path.join(rootDir, 'ring-progress')));
  app.use('/ring-assignment', express.static(path.join(rootDir, 'ring-assignment')));
  app.use('/event-administration', express.static(path.join(rootDir, 'event-administration')));
  app.use('/rings', express.static(path.join(rootDir, 'ring-progress')));
  app.use('/ring-status', express.static(path.join(rootDir, 'ring-progress')));
  app.use('/group-builder', express.static(path.join(rootDir, 'group-builder')));
  app.use(express.static(rootDir));
  app.use('/control-board-assets', express.static(controlBoardDir));

  app.get('/control-board', (req, res) => {
    res.sendFile(path.join(controlBoardDir, 'index.html'));
  });

  app.get('/status', (req, res) => {
    res.redirect('/api/rings');
  });

  if (isMonitoringSurface) {
    app.get('/', (req, res) => {
      if (isAdminModeRequested(req)) {
        res.redirect('/');
        return;
      }
      sendPublicProgressPage(res);
    });

    app.get('/head-table', (req, res) => {
      if (isAdminModeRequested(req)) {
        res.redirect('/head-table/');
        return;
      }
      res.redirect('/head-table/');
    });

    app.get('/head-table/', (req, res) => {
      if (isAdminModeRequested(req)) {
        res.redirect('/head-table/');
        return;
      }
      sendPublicProgressPage(res);
    });

    app.get('/head-table.html', (req, res) => {
      if (isAdminModeRequested(req)) {
        res.redirect('/head-table.html');
        return;
      }
      sendPublicProgressPage(res);
    });

    app.get('/event-progress', (req, res) => {
      if (isAdminModeRequested(req)) {
        res.redirect('/event-progress/');
        return;
      }
      res.redirect('/event-progress/');
    });

    app.get('/event-progress/', (req, res) => {
      if (isAdminModeRequested(req)) {
        res.redirect('/event-progress/');
        return;
      }
      sendPublicProgressPage(res);
    });

    app.get('/event-progress.html', (req, res) => {
      if (isAdminModeRequested(req)) {
        res.redirect('/event-progress.html');
        return;
      }
      sendPublicProgressPage(res);
    });
  } else if (isAdminProgressSurface) {
    app.get('/', (req, res) => {
      res.redirect('/head-table/?mode=admin');
    });

    app.get('/head-table', (req, res) => {
      if (!isAdminModeRequested(req)) {
        res.redirect('/head-table/?mode=admin');
        return;
      }
      sendPublicProgressPage(res);
    });

    app.get('/head-table/', (req, res) => {
      if (!isAdminModeRequested(req)) {
        res.redirect('/head-table/?mode=admin');
        return;
      }
      sendPublicProgressPage(res);
    });

    app.get('/head-table.html', (req, res) => {
      if (!isAdminModeRequested(req)) {
        res.redirect('/head-table/?mode=admin');
        return;
      }
      sendPublicProgressPage(res);
    });

    app.get('/administration-progress', (req, res) => {
      res.redirect('/administration-progress/');
    });

    app.get('/administration-progress/', (req, res) => {
      if (!isAdminModeRequested(req)) {
        res.redirect('/head-table/?mode=admin');
        return;
      }
      sendPublicProgressPage(res);
    });

    app.get('/administration-progress.html', (req, res) => {
      if (!isAdminModeRequested(req)) {
        res.redirect('/head-table/?mode=admin');
        return;
      }
      sendPublicProgressPage(res);
    });
  }

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
