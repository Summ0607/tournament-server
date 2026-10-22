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

test('pre-tournament root opens the integrated interface', async () => {
  const rootPage = await requestPath('pre', '/');
  assert.ok([301, 302].includes(rootPage.statusCode));
  assert.equal(rootPage.headers.location, '/tournament-management/');
});

test('retired workflow pages and legacy aliases redirect to matching integrated views', async () => {
  const workflows = [
    { prefixes: ['/tournament-setup', '/tournament-mgmt', '/setup', '/event-administration', '/tournament-setup/event-definition'], view: 'event-setup' },
    { prefixes: ['/tournament-setup/import'], view: 'import' },
    { prefixes: ['/group-builder', '/tournament-setup/build-groups', '/tournament-setup/review-save'], view: 'groups' }
  ];
  for (const { prefixes, view } of workflows) {
    for (const prefix of prefixes) {
      for (const suffix of ['', '/', '.html', '/index.html']) {
        const pathname = prefix + suffix;
        const response = await requestPath('pre', pathname);
        assert.equal(response.statusCode, 302, pathname);
        assert.equal(response.headers.location, `/tournament-management/?view=${view}`, pathname);
      }
    }
  }
  const saved = await requestPath('pre', '/tournament-setup/review-save/?source=saved');
  assert.equal(saved.headers.location, '/tournament-management/?view=groups&source=saved');
  const retiredScript = await requestPath('pre', '/tournament-setup/build-groups/app.js');
  assert.equal(retiredScript.statusCode, 404);
});

test('integrated tournament management is available directly and through workflow URLs', async () => {
  const shellRoot = await requestPath('pre', '/tournament-management');
  assert.ok([301, 302].includes(shellRoot.statusCode));
  assert.equal(shellRoot.headers.location, '/tournament-management/');

  const shellPage = await requestPath('pre', '/tournament-management/');
  assert.equal(shellPage.statusCode, 200);
  assert.match(shellPage.body, /Tournament Management System/);
  assert.match(shellPage.body, /Under Development/);
  assert.match(shellPage.body, /Event Setup/);
  assert.match(shellPage.body, /Selected event metadata/);
  assert.match(shellPage.body, /No event selected/);
  assert.doesNotMatch(shellPage.body, /<strong>Winter Tournament<\/strong>/);

  const shellHtml = await requestPath('pre', '/tournament-management.html');
  assert.equal(shellHtml.statusCode, 200);
  assert.match(shellHtml.body, /Tournament Management System/);
  const directFile = await requestPath('pre', '/tournament-management/index.html');
  assert.equal(directFile.statusCode, 200);
  for (const view of ['event-setup', 'import', 'groups']) {
    const response = await requestPath('pre', `/tournament-management/?view=${view}`);
    assert.equal(response.statusCode, 200);
  }
});

test('day-of pages still serve their existing interfaces and link to integrated setup', async () => {
  const ringAssignment = await requestPath('ringOps', '/ring-assignment/index.html');
  assert.equal(ringAssignment.statusCode, 200);
  assert.match(ringAssignment.body, /href="\/tournament-management\/\?view=event-setup"/);
  for (const pathname of ['/head-table/index.html', '/competitors/index.html']) {
    const response = await requestPath('pre', pathname);
    assert.equal(response.statusCode, 200);
  }
});
