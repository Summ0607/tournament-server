const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { test } = require('node:test');
const express = require('express');
const { registerPageRoutes } = require('../backend/pages');

function requestPath(activeSurface, requestPathname) {
  return new Promise((resolve, reject) => {
    const app = express();
    const rootDir = path.join(__dirname, '..');
    const controlBoardDir = path.join(rootDir, 'head-table');
    registerPageRoutes(app, rootDir, controlBoardDir, activeSurface);

    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const req = http.get({
        host: '127.0.0.1',
        port,
        path: requestPathname
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          server.close(() => resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body
          }));
        });
      });

      req.on('error', (error) => {
        server.close(() => reject(error));
      });
    });
  });
}

test('progress surfaces redirect legacy aliases to the canonical entry point', async () => {
  const monitoringAlias = await requestPath('monitoring', '/control-board');
  assert.ok([301, 302].includes(monitoringAlias.statusCode));
  assert.equal(monitoringAlias.headers.location, '/event-progress/');

  const adminAlias = await requestPath('adminProgress', '/dashboard');
  assert.ok([301, 302].includes(adminAlias.statusCode));
  assert.equal(adminAlias.headers.location, '/administration-progress/');
});

test('canonical progress routes still serve the page directly', async () => {
  const monitoringPage = await requestPath('monitoring', '/event-progress/');
  assert.equal(monitoringPage.statusCode, 200);
  assert.match(monitoringPage.body, /<!DOCTYPE html>/);

  const adminPage = await requestPath('adminProgress', '/administration-progress/');
  assert.equal(adminPage.statusCode, 200);
  assert.match(adminPage.body, /<!DOCTYPE html>/);
});

test('tournament setup routes serve the new canonical hierarchy', async () => {
  const rootPage = await requestPath('pre', '/');
  assert.ok([301, 302].includes(rootPage.statusCode));
  assert.equal(rootPage.headers.location, '/tournament-setup/');

  const hubPage = await requestPath('pre', '/tournament-setup/');
  assert.equal(hubPage.statusCode, 200);
  assert.match(hubPage.body, /Tournament Setup/);

  const importPage = await requestPath('pre', '/tournament-setup/import/');
  assert.equal(importPage.statusCode, 200);
  assert.match(importPage.body, /Import Registration/);
  assert.match(importPage.body, /Import CSV/);

  const eventDefinitionPage = await requestPath('pre', '/tournament-setup/event-definition/');
  assert.equal(eventDefinitionPage.statusCode, 200);
  assert.match(eventDefinitionPage.body, /Event Definition/);

  const buildGroupsPage = await requestPath('pre', '/tournament-setup/build-groups/');
  assert.equal(buildGroupsPage.statusCode, 200);
  assert.match(buildGroupsPage.body, /Build Groups/);

  const reviewSavePage = await requestPath('pre', '/tournament-setup/review-save/');
  assert.equal(reviewSavePage.statusCode, 200);
  assert.match(reviewSavePage.body, /Final Review &amp; Save/);

  const buildGroupsScript = await requestPath('pre', '/tournament-setup/build-groups/app.js');
  assert.equal(buildGroupsScript.statusCode, 200);
  assert.match(buildGroupsScript.body, /window\.buildDivisions/);
});

test('legacy pre-tournament routes redirect to the new canonical paths', async () => {
  const setupAlias = await requestPath('pre', '/setup/');
  assert.ok([301, 302].includes(setupAlias.statusCode));
  assert.equal(setupAlias.headers.location, '/tournament-setup/event-definition/');

  const eventAdminAlias = await requestPath('pre', '/event-administration/');
  assert.ok([301, 302].includes(eventAdminAlias.statusCode));
  assert.equal(eventAdminAlias.headers.location, '/tournament-setup/event-definition/');

  const launchpadAlias = await requestPath('pre', '/tournament-mgmt/');
  assert.ok([301, 302].includes(launchpadAlias.statusCode));
  assert.equal(launchpadAlias.headers.location, '/tournament-setup/');

  const oldLaunchpadFile = await requestPath('pre', '/tournament-mgmt/index.html');
  assert.ok([301, 302].includes(oldLaunchpadFile.statusCode));
  assert.equal(oldLaunchpadFile.headers.location, '/tournament-setup/');

  const buildGroupsAlias = await requestPath('pre', '/group-builder/');
  assert.ok([301, 302].includes(buildGroupsAlias.statusCode));
  assert.equal(buildGroupsAlias.headers.location, '/tournament-setup/build-groups/');

  const oldBuildGroupsFile = await requestPath('pre', '/group-builder/index.html');
  assert.ok([301, 302].includes(oldBuildGroupsFile.statusCode));
  assert.equal(oldBuildGroupsFile.headers.location, '/tournament-setup/build-groups/');

  const oldEventDefinitionFile = await requestPath('pre', '/event-administration/index.html');
  assert.ok([301, 302].includes(oldEventDefinitionFile.statusCode));
  assert.equal(oldEventDefinitionFile.headers.location, '/tournament-setup/event-definition/');

  const oldSetupFile = await requestPath('pre', '/setup/index.html');
  assert.ok([301, 302].includes(oldSetupFile.statusCode));
  assert.equal(oldSetupFile.headers.location, '/tournament-setup/event-definition/');
});
