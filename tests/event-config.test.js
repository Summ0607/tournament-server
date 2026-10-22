const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createEventConfigStore, normalizeEventRingConfig } = require('../backend/eventConfig');

test('event dimensions persist as numbers and survive modification and reload', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tournament-event-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const eventName = 'Test Event';
  fs.mkdirSync(path.join(root, eventName));
  const file = path.join(root, eventName, 'event-config.json');
  const store = createEventConfigStore(root);
  const created = store.writeEventConfig(eventName, {
    location: 'Test Venue',
    date: '2027-01-16',
    ringConfigX: 2,
    ringConfigY: 3
  });
  assert.equal(created.ringConfigX, 2);
  assert.equal(created.ringConfigY, 3);
  assert.equal(Object.hasOwn(created, 'ringConfig'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), created);
  assert.deepEqual(store.readEventConfig(eventName), created);

  const modified = store.writeEventConfig(eventName, {
    ...created,
    ringConfigX: '4',
    ringConfigY: '5'
  });
  assert.equal(modified.createdAt, created.createdAt);
  assert.equal(modified.location, created.location);
  assert.equal(modified.date, created.date);
  assert.equal(modified.ringConfigX, 4);
  assert.equal(modified.ringConfigY, 5);
  assert.deepEqual(createEventConfigStore(root).readEventConfig(eventName), modified);
  const beforeInvalidSave = fs.readFileSync(file, 'utf8');
  assert.throws(() => store.writeEventConfig(eventName, { ...modified, ringConfigX: 1.5 }), /whole number/);
  assert.equal(fs.readFileSync(file, 'utf8'), beforeInvalidSave);

  for (const ringConfig of ['2 x 3', '2 \u00d7 3']) {
    fs.writeFileSync(file, JSON.stringify({ ...created, ringConfigX: undefined, ringConfigY: undefined, ringConfig }));
    const legacy = store.readEventConfig(eventName);
    assert.equal(legacy.ringConfigX, 2);
    assert.equal(legacy.ringConfigY, 3);
    assert.equal(Object.hasOwn(legacy, 'ringConfig'), false);
    store.writeEventConfig(eventName, legacy);
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file, 'utf8')), 'ringConfig'), false);
  }

  fs.writeFileSync(file, JSON.stringify({ ringConfigX: 0, ringConfigY: 0, ringConfig: '2 x 3' }));
  assert.equal(store.readEventConfig(eventName).ringConfigX, 0);
  assert.equal(store.readEventConfig(eventName).ringConfigY, 0);
  fs.writeFileSync(file, '{ invalid JSON');
  assert.throws(() => store.readEventConfig(eventName), SyntaxError);
});

test('dimensions default to zero and reject invalid input instead of truncating', () => {
  assert.deepEqual(normalizeEventRingConfig({}), { ringConfigX: 0, ringConfigY: 0 });
  assert.deepEqual(normalizeEventRingConfig({ ringConfigX: '', ringConfigY: 0 }), { ringConfigX: 0, ringConfigY: 0 });
  for (const field of ['ringConfigX', 'ringConfigY']) {
    for (const value of [-1, 1.5, '1.5', '2 rings', true, [], {}, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => normalizeEventRingConfig({ [field]: value }), (error) => {
        assert.equal(error.statusCode, 400);
        assert.match(error.message, new RegExp(field));
        return true;
      });
    }
  }
});
