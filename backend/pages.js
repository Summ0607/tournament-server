const express = require('express');
const path = require('path');

function registerPageRoutes(app, rootDir, controlBoardDir) {
  app.use('/head-table', express.static(controlBoardDir));
  app.use('/dashboard', express.static(controlBoardDir));
  app.use('/ring-progress', express.static(path.join(rootDir, 'ring-progress')));
  app.use('/ring-assignment', express.static(path.join(rootDir, 'ring-assignment')));
  app.use('/setup', express.static(path.join(rootDir, 'setup')));
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

  app.get('/setup', (req, res) => {
    res.redirect('/setup/');
  });

  app.get('/setup/', (req, res) => {
    res.sendFile(path.join(rootDir, 'setup', 'index.html'));
  });

  app.get('/setup.html', (req, res) => {
    res.sendFile(path.join(rootDir, 'setup', 'index.html'));
  });
}

module.exports = {
  registerPageRoutes
};
