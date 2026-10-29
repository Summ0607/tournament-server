const crypto = require('node:crypto');
const fs = require('node:fs');

const RETRY_DELAYS_MS = [20, 40, 80, 160, 320];
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

function writeJsonAtomicSync(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let temporaryCreated = false;
  try {
    const contents = JSON.stringify(value, null, 2);
    const descriptor = fs.openSync(temporaryPath, 'wx');
    temporaryCreated = true;
    try {
      fs.writeFileSync(descriptor, contents, { encoding: 'utf8' });
    } finally {
      fs.closeSync(descriptor);
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(temporaryPath, filePath);
        return;
      } catch (error) {
        if (!RETRYABLE_RENAME_CODES.has(error.code) || attempt >= RETRY_DELAYS_MS.length) {
          throw error;
        }
        // Keep synchronous writers serialized while a short-lived Windows file lock clears.
        Atomics.wait(waitBuffer, 0, 0, RETRY_DELAYS_MS[attempt]);
      }
    }
  } catch (error) {
    if (temporaryCreated) {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch (cleanupError) {
        console.error(`Failed to remove temporary JSON file ${temporaryPath}:`, cleanupError);
      }
    }
    throw error;
  }
}

module.exports = { writeJsonAtomicSync };
