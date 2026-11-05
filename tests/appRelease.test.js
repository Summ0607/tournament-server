const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const {
  APPLICATION_ID, extractApkVersion, publishAppRelease, readAppRelease, createAppReleaseRouter
} = require('../backend/appRelease');
const { parseArguments } = require('../backend/publishApp');
const { registerPageRoutes } = require('../backend/pages');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-release-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const apkFile = path.join(root, 'input.apk');
  const aapt2 = path.join(root, 'aapt2.exe');
  const directory = path.join(root, 'published');
  fs.writeFileSync(apkFile, 'APK fixture version 46');
  fs.writeFileSync(aapt2, '');
  const execute = (_tool, args, options) => {
    assert.deepEqual(args.slice(0, 2), ['dump', 'badging']);
    assert.equal(fs.readFileSync(args[2], 'utf8'), fs.readFileSync(apkFile, 'utf8'));
    assert.equal(options.windowsHide, true);
    return `package: name='${APPLICATION_ID}' versionCode='46' versionName='1.45' platformBuildVersionCode='37'\n`;
  };
  return { root, apkFile, aapt2, directory, execute };
}

test('publication extracts version from the staged APK and publishes matching bytes/manifest', async (t) => {
  const p = fixture(t);
  const result = publishAppRelease(p);
  assert.equal(result.versionCode, 46);
  assert.equal(result.versionName, '1.45');
  assert.equal(result.filename, 'tournament-scoring.apk');
  const published = await readAppRelease(p.directory);
  assert.deepEqual(published.manifest, result);
  assert.deepEqual(published.bytes, fs.readFileSync(p.apkFile));
  assert.equal(result.sha256, crypto.createHash('sha256').update(published.bytes).digest('hex'));
  assert.equal(result.sizeBytes, published.bytes.length);
  assert.deepEqual(fs.readdirSync(p.directory).sort(), [result.sha256, 'current.json'].sort());
  assert.deepEqual(publishAppRelease(p), result);
});

test('failed publication leaves active release intact and removes temporary material', async (t) => {
  const p = fixture(t);
  const first = publishAppRelease(p);
  for (const output of [
    `package: name='wrong.app' versionCode='47' versionName='1.46'`,
    `package: name='${APPLICATION_ID}' versionCode='0' versionName='1.46'`,
    `package: name='${APPLICATION_ID}' versionCode='47' versionName=''`,
    'malformed metadata'
  ]) {
    assert.throws(() => publishAppRelease({ ...p, execute: () => output }), /APK must contain/);
    assert.deepEqual((await readAppRelease(p.directory)).manifest, first);
  }
  assert.throws(() => publishAppRelease({ ...p, execute: () => { throw new Error('aapt2 failed'); } }), /aapt2 failed/);
  assert.equal(fs.readdirSync(p.directory).some((name) => name.startsWith('.publish-')), false);
  assert.deepEqual((await readAppRelease(p.directory)).manifest, first);
});

test('new publication switches active manifest while retaining previous immutable APK', async (t) => {
  const p = fixture(t);
  const first = publishAppRelease(p);
  fs.writeFileSync(p.apkFile, 'Different APK fixture version 47');
  const second = publishAppRelease({ ...p, execute: () =>
    `package: name='${APPLICATION_ID}' versionCode='47' versionName='1.46'` });
  assert.notEqual(first.sha256, second.sha256);
  assert.equal((await readAppRelease(p.directory)).manifest.versionCode, 47);
  assert.equal(fs.existsSync(path.join(p.directory, first.sha256, first.filename)), true);
});

test('publication fails on missing paths or corrupted existing immutable artifact', async (t) => {
  const p = fixture(t);
  assert.throws(() => publishAppRelease({ ...p, apkFile: 'relative.apk' }), /absolute/);
  assert.throws(() => extractApkVersion(p.apkFile, 'aapt2'), /absolute/);
  const first = publishAppRelease(p);
  fs.writeFileSync(path.join(p.directory, first.sha256, first.filename), 'corrupt');
  assert.throws(() => publishAppRelease(p), /corrupted/);
  await assert.rejects(readAppRelease(p.directory), /checksum/);
});

async function serverFixture(t, directory) {
  const errors = [];
  const app = express();
  app.use(createAppReleaseRouter({ directory, logger: { error: (...args) => errors.push(args) } }));
  // Production mounts the release router before the broad static page router.
  registerPageRoutes(app, path.resolve(__dirname, '..'), path.resolve(__dirname, '..', 'head-table'), 'pre');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const request = (route) => fetch(`http://127.0.0.1:${server.address().port}${route}`);
  return { request, errors };
}

test('version/download endpoints resolve the same verified release without source repositories', async (t) => {
  const p = fixture(t);
  const manifest = publishAppRelease(p);
  fs.rmSync(p.apkFile);
  const { request } = await serverFixture(t, p.directory);
  const version = await request('/api/version');
  assert.equal(version.status, 200);
  assert.equal(version.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await version.json(), manifest);
  const download = await request('/download-app');
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('x-app-version-code'), '46');
  assert.equal(download.headers.get('x-app-sha256'), manifest.sha256);
  assert.equal(download.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.equal(Number(download.headers.get('content-length')), manifest.sizeBytes);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), manifest.sha256);
});

test('missing, corrupt and unsafe manifests/APKs fail closed on both HTTP routes', async (t) => {
  const p = fixture(t);
  const { request, errors } = await serverFixture(t, p.directory);
  async function unavailable() {
    for (const route of ['/api/version', '/download-app']) {
      const response = await request(route);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json();
      assert.match(body.error, /Publish a valid APK/);
      assert.equal(body.versionCode, undefined);
      assert.equal(body.error.includes(p.directory), false);
    }
  }
  await unavailable();
  const manifest = publishAppRelease(p);
  const current = path.join(p.directory, 'current.json');
  const artifact = path.join(p.directory, manifest.sha256, manifest.filename);
  const original = fs.readFileSync(artifact);
  for (const changed of [
    { ...manifest, sha256: '..\\outside' },
    { ...manifest, filename: '..\\outside.apk' },
    { ...manifest, versionCode: 0 },
    { ...manifest, sizeBytes: manifest.sizeBytes + 1 }
  ]) {
    fs.writeFileSync(current, JSON.stringify(changed));
    await unavailable();
  }
  fs.writeFileSync(current, '{');
  await unavailable();
  fs.writeFileSync(current, JSON.stringify(manifest));
  fs.writeFileSync(artifact, Buffer.alloc(original.length));
  await unavailable();
  fs.rmSync(artifact);
  await unavailable();
  assert.equal(errors.length, 16);
});

test('publisher CLI requires explicit unambiguous arguments', () => {
  assert.deepEqual(parseArguments(['--apk', 'C:\\app.apk', '--aapt2', 'C:\\aapt2.exe']), {
    apkFile: 'C:\\app.apk', aapt2: 'C:\\aapt2.exe'
  });
  for (const args of [[], ['--apk', 'x'], ['--apk'], ['--unknown', 'x'],
    ['--apk', 'x', '--apk', 'y'], ['--apk', '--aapt2']]) {
    assert.throws(() => parseArguments(args));
  }
});
