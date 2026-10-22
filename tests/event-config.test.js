const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
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

test('administration sends numeric dimensions, displays zero, and blocks invalid input', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'tournament-setup', 'event-definition', 'index.html'), 'utf8');
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        value: '',
        classList: { toggle() {} },
        addEventListener() {},
        checkValidity() { return true; },
        reportValidity() {},
        appendChild() {}
      });
    }
    return elements.get(id);
  }
  const requests = [];
  const context = vm.createContext({
    setTimeout: () => 0,
    clearTimeout: () => {},
    window: { location: { protocol: 'http:', origin: 'http://localhost:3000' } },
    document: { getElementById: element, querySelector: element, createElement: () => ({}) },
    fetch: async (url, options) => {
      if (options) requests.push({ url, body: JSON.parse(options.body) });
      return {
        ok: true,
        json: async () => ({
          events: ['Test Event'],
          activeEvent: '',
          eventConfig: { name: 'Test Event', ringConfigX: 2, ringConfigY: 3 }
        })
      };
    }
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  await vm.runInContext('refreshAll()', context);
  assert.equal(vm.runInContext('normalizeNumberInput(0)', context), '0');
  assert.equal(vm.runInContext('metaFromConfig({}, "").ringConfigX', context), '');
  for (const mode of ['create', 'modify']) {
    vm.runInContext(`state.metadataMode = '${mode}'; state.metadataOpen = true;`, context);
    element('eventNameInput').value = 'Test Event';
    element('ringConfigXInput').value = '2';
    element('ringConfigYInput').value = '3';
    await vm.runInContext('saveMetadata()', context);
    const request = requests.at(-1);
    assert.equal(request.url, `http://localhost:3000/api/events/${mode}`);
    assert.equal(request.body.ringConfigX, 2);
    assert.equal(request.body.ringConfigY, 3);
    assert.equal(element('metadataPanel').hidden, true);
    assert.equal(vm.runInContext('state.metadataOpen', context), false);
    assert.equal(element('ringConfigXInput').value, '');
    assert.equal(vm.runInContext('state.selectedEventMeta.ringConfigX', context), '2');
  }
  vm.runInContext(`state.metadataMode = 'modify'; state.metadataOpen = true;`, context);
  element('metadataPanel').hidden = false;
  const count = requests.length;
  element('ringConfigXInput').checkValidity = () => false;
  await vm.runInContext('saveMetadata()', context);
  assert.equal(requests.length, count);
  assert.match(element('notice').textContent, /whole numbers/);
});
