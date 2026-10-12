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
