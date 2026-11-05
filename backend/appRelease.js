const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const express = require('express');
const { writeJsonAtomicSync } = require('./atomicJsonFile');

const APPLICATION_ID = 'com.summ0.tournamentscoringapp';
const DEFAULT_RELEASE_DIRECTORY = process.env.TOURNAMENT_APP_RELEASE_DIR || path.resolve(__dirname, '..', 'app-releases');

function validateManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.applicationId !== APPLICATION_ID ||
      !Number.isSafeInteger(manifest.versionCode) || manifest.versionCode < 1 ||
      typeof manifest.versionName !== 'string' || !manifest.versionName.trim() ||
      typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      !Number.isSafeInteger(manifest.sizeBytes) || manifest.sizeBytes < 1 ||
      manifest.filename !== 'tournament-scoring.apk') {
    throw new Error('Invalid published app manifest.');
  }
  return manifest;
}

function extractApkVersion(apkFile, aapt2, execute = execFileSync) {
  if (!aapt2 || !path.isAbsolute(aapt2) || !fs.statSync(aapt2).isFile()) {
    throw new Error('Provide an absolute path to the Android SDK aapt2 executable using --aapt2.');
  }
  const output = execute(aapt2, ['dump', 'badging', apkFile], {
    encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024
  });
  const firstLine = output.split(/\r?\n/).find((line) => line.startsWith('package:'));
  const applicationId = firstLine?.match(/\bname='([^']+)'/)?.[1];
  const versionCode = Number(firstLine?.match(/\bversionCode='(\d+)'/)?.[1]);
  const versionName = firstLine?.match(/\bversionName='([^']+)'/)?.[1];
  if (applicationId !== APPLICATION_ID || !Number.isSafeInteger(versionCode) || versionCode < 1 ||
      !versionName?.trim()) {
    throw new Error(`APK must contain ${APPLICATION_ID} and valid versionCode/versionName metadata.`);
  }
  return { applicationId, versionCode, versionName };
}

function publishAppRelease({ apkFile, aapt2, directory = DEFAULT_RELEASE_DIRECTORY, execute }) {
  if (!apkFile || !path.isAbsolute(apkFile) || !fs.statSync(apkFile).isFile()) {
    throw new Error('Provide an absolute path to a built APK using --apk.');
  }
  if (!path.isAbsolute(directory)) throw new Error('Release directory must be absolute.');
  fs.mkdirSync(directory, { recursive: true });
  // Extract metadata from the copied artifact, not a build output that could change during publication.
  const staging = fs.mkdtempSync(path.join(directory, '.publish-'));
  try {
    const stagedApk = path.join(staging, 'tournament-scoring.apk');
    fs.copyFileSync(apkFile, stagedApk);
    const metadata = extractApkVersion(stagedApk, aapt2, execute);
    const bytes = fs.readFileSync(stagedApk);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const manifest = validateManifest({
      schemaVersion: 1, ...metadata, filename: 'tournament-scoring.apk',
      sizeBytes: bytes.length, sha256
    });
    const releaseDirectory = path.join(directory, sha256);
    if (fs.existsSync(releaseDirectory)) {
      const existing = fs.readFileSync(path.join(releaseDirectory, manifest.filename));
      if (existing.length !== manifest.sizeBytes ||
          crypto.createHash('sha256').update(existing).digest('hex') !== sha256) {
        throw new Error('An existing release is corrupted. Publication aborted; active manifest was not changed.');
      }
    } else {
      fs.renameSync(staging, releaseDirectory);
    }
    writeJsonAtomicSync(path.join(directory, 'current.json'), manifest);
    return manifest;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function readAppRelease(directory = DEFAULT_RELEASE_DIRECTORY) {
  const manifest = validateManifest(JSON.parse(await fs.promises.readFile(path.join(directory, 'current.json'), 'utf8')));
  const bytes = await fs.promises.readFile(path.join(directory, manifest.sha256, manifest.filename));
  if (bytes.length !== manifest.sizeBytes ||
      crypto.createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) {
    throw new Error('Published APK size/checksum does not match the manifest.');
  }
  return { manifest, bytes };
}

function createAppReleaseRouter({ directory = DEFAULT_RELEASE_DIRECTORY, logger = console } = {}) {
  if (!path.isAbsolute(directory)) throw new Error('Release directory must be absolute.');
  const router = express.Router();
  async function handle(req, res, next) {
    res.set('Cache-Control', 'no-store');
    try {
      const { manifest, bytes } = await readAppRelease(directory);
      if (req.path === '/api/version') return res.json(manifest);
      res.set('Content-Type', 'application/vnd.android.package-archive');
      res.set('Content-Disposition', `attachment; filename="${manifest.filename}"`);
      res.set('X-App-Version-Code', String(manifest.versionCode));
      res.set('X-App-SHA256', manifest.sha256);
      return res.send(bytes);
    } catch (error) {
      if (res.headersSent) return next(error);
      logger.error('App release unavailable:', error);
      return res.status(503).json({
        error: 'App update unavailable. Publish a valid APK using npm run publish:app; check the server log for details.'
      });
    }
  }
  router.get(['/api/version', '/download-app'], handle);
  return router;
}

module.exports = {
  APPLICATION_ID, DEFAULT_RELEASE_DIRECTORY, validateManifest, extractApkVersion,
  publishAppRelease, readAppRelease, createAppReleaseRouter
};
