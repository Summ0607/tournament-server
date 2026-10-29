const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { writeJsonAtomicSync } = require('../backend/atomicJsonFile');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-json-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'state.json');
  fs.writeFileSync(target, '{"old":true}');
  return { directory, target };
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`retries a transient ${code} replacement without rewriting or removing the original`, (t) => {
    const { directory, target } = fixture(t);
    const rename = fs.renameSync;
    const delays = [];
    const temporaryPaths = [];
    t.mock.method(Atomics, 'wait', (_buffer, _index, _value, delay) => delays.push(delay));
    t.mock.method(fs, 'renameSync', (source, destination) => {
      temporaryPaths.push(source);
      if (temporaryPaths.length <= 2) {
        assert.equal(fs.readFileSync(target, 'utf8'), '{"old":true}');
        throw Object.assign(new Error('File is temporarily locked'), { code });
      }
      return rename(source, destination);
    });

    writeJsonAtomicSync(target, { saved: true });

    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { saved: true });
    assert.deepEqual(delays, [20, 40]);
    assert.equal(new Set(temporaryPaths).size, 1);
    assert.deepEqual(fs.readdirSync(directory), ['state.json']);
  });
}

test('bounds lock retries to six attempts and 620ms, preserves the target, and removes its temporary file', (t) => {
  const { directory, target } = fixture(t);
  const delays = [];
  const failure = Object.assign(new Error('File remains locked'), { code: 'EPERM' });
  t.mock.method(Atomics, 'wait', (_buffer, _index, _value, delay) => delays.push(delay));
  const rename = t.mock.method(fs, 'renameSync', () => { throw failure; });

  assert.throws(() => writeJsonAtomicSync(target, { saved: true }), (error) => error === failure);

  assert.equal(rename.mock.callCount(), 6);
  assert.deepEqual(delays, [20, 40, 80, 160, 320]);
  assert.equal(delays.reduce((sum, delay) => sum + delay, 0), 620);
  assert.equal(fs.readFileSync(target, 'utf8'), '{"old":true}');
  assert.deepEqual(fs.readdirSync(directory), ['state.json']);
});

test('does not retry unrelated rename failures or delete other temporary files', (t) => {
  const { directory, target } = fixture(t);
  fs.writeFileSync(path.join(directory, 'someone-else.tmp'), 'untouched');
  const failure = Object.assign(new Error('Disk is full'), { code: 'ENOSPC' });
  const wait = t.mock.method(Atomics, 'wait');
  const rename = t.mock.method(fs, 'renameSync', () => { throw failure; });

  assert.throws(() => writeJsonAtomicSync(target, {}), (error) => error === failure);

  assert.equal(rename.mock.callCount(), 1);
  assert.equal(wait.mock.callCount(), 0);
  assert.equal(fs.readFileSync(target, 'utf8'), '{"old":true}');
  assert.deepEqual(fs.readdirSync(directory).sort(), ['someone-else.tmp', 'state.json']);
});

test('cleans up a partially written temporary file without replacing the original', (t) => {
  const { directory, target } = fixture(t);
  const write = fs.writeFileSync;
  const failure = Object.assign(new Error('Disk is full'), { code: 'ENOSPC' });
  t.mock.method(fs, 'writeFileSync', (descriptor) => {
    write(descriptor, 'partial');
    throw failure;
  });

  assert.throws(() => writeJsonAtomicSync(target, {}), (error) => error === failure);

  assert.equal(fs.readFileSync(target, 'utf8'), '{"old":true}');
  assert.deepEqual(fs.readdirSync(directory), ['state.json']);
});

test('reports cleanup failures while preserving the original write error', (t) => {
  const { directory, target } = fixture(t);
  const failure = Object.assign(new Error('Rename failed'), { code: 'ENOENT' });
  const cleanupFailure = Object.assign(new Error('Cleanup denied'), { code: 'EPERM' });
  t.mock.method(fs, 'renameSync', () => { throw failure; });
  const remove = t.mock.method(fs, 'rmSync', () => { throw cleanupFailure; });
  const log = t.mock.method(console, 'error', () => {});

  assert.throws(() => writeJsonAtomicSync(target, {}), (error) => error === failure);

  assert.equal(log.mock.callCount(), 1);
  assert.equal(log.mock.calls[0].arguments[1], cleanupFailure);
  remove.mock.restore();
  const remaining = fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'));
  assert.equal(remaining.length, 1);
});
