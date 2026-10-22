const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const express = require('express');
const { createDivisionRouter } = require('../backend/divisionRoutes');
const { createGroupStore } = require('../backend/groupStore');

const html = fs.readFileSync(path.join(__dirname, '..', 'tournament-setup', 'import', 'index.html'), 'utf8');
const eventName = 'Winter Tournament 2027';
const draftKey = 'tournamentSetup.groupReviewDraft';

async function loadPage(options = {}) {
  let competitors = options.competitors || [];
  let groups = options.groups || [];
  const elements = new Map();
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    elements.set(match[1], {
      value: '',
      textContent: html.slice(match.index + match[0].length).split('<')[0],
      innerHTML: '',
      hidden: /\bhidden\b/.test(match[0]),
      disabled: /\bdisabled\b/.test(match[0]),
      classList: { toggle() {} },
      handlers: {},
      addEventListener(name, handler) { this.handlers[name] = handler; }
    });
  }
  const storage = new Map([
    ['eventAdmin.lastSelectedEvent', eventName],
    [draftKey, JSON.stringify({ eventName: options.draftEvent || eventName, groups: [{ id: 'old' }] })]
  ]);
  if (options.noSelection) storage.delete('eventAdmin.lastSelectedEvent');
  const requests = [];
  const destinations = [];
  const confirmations = [];
  const context = vm.createContext({
    console: { error() {} },
    window: {
      location: {
        protocol: 'http:',
        origin: 'http://localhost:3000',
        assign: (url) => destinations.push(url)
      },
      localStorage: {
        getItem: (key) => storage.get(key) || null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: (key) => storage.delete(key)
      },
      confirm: (message) => {
        confirmations.push(message);
        return options.confirm === true;
      }
    },
    document: { getElementById: (id) => {
      assert.ok(elements.has(id), `Missing element ${id}`);
      return elements.get(id);
    } },
    fetch: async (url, init) => {
      const request = new URL(url);
      requests.push({ path: request.pathname, event: request.searchParams.get('eventName'), init });
      let data;
      let ok = true;
      switch (request.pathname) {
        case '/api/events/active': data = { activeEvent: '' }; break;
        case '/api/events/list': data = { events: [] }; break;
        case '/api/events/config': data = { dbExists: options.dbExists !== false }; break;
        case '/api/competitors':
          data = options.failSnapshot ? { error: 'Database unavailable' } : competitors;
          ok = !options.failSnapshot;
          break;
        case '/api/groups': data = { groups }; break;
        case '/api/events/import-csv':
          competitors = [{ firstName: 'New', lastName: 'Competitor', rank: 'G1' }];
          groups = [];
          data = { normalizedCompetitors: competitors, rankWarnings: [], eventName };
          break;
        default: throw new Error(`Unexpected request ${url}`);
      }
      return { ok, json: async () => data };
    }
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  await new Promise(setImmediate);
  return {
    element: (id) => elements.get(id),
    click: async (id) => elements.get(id).handlers.click(),
    requests, destinations, confirmations, storage
  };
}

test('a new event offers import and cannot continue without a saved roster', async () => {
  const page = await loadPage();
  assert.equal(page.element('importForm').hidden, false);
  assert.equal(page.element('importBtn').disabled, false);
  assert.equal(page.element('continueBtn').disabled, true);
  assert.equal(page.element('reimportBtn').hidden, true);
  assert.equal(page.element('importedCountValue').textContent, 0);
  assert.equal(page.element('warningCountValue').textContent, 'Not available');
  assert.equal(page.requests.some((request) => request.init), false);
});

test('saved roster resumes without reimport, and clearing CSV inputs preserves it', async () => {
  const page = await loadPage({ competitors: [{ firstName: 'Saved', rank: 'G1' }] });
  assert.equal(page.element('importedCountValue').textContent, 1);
  assert.equal(page.element('savedDivisionCountValue').textContent, 0);
  assert.equal(page.element('importForm').hidden, true);
  assert.equal(page.element('continueBtn').disabled, false);
  assert.equal(page.element('continueBtn').textContent, 'Continue to Build Groups');
  await page.click('continueBtn');
  assert.deepEqual(page.destinations, ['/tournament-setup/build-groups/']);
  await page.click('reimportBtn');
  assert.equal(page.element('importForm').hidden, false);
  page.element('csvTextInput').value = 'temporary input';
  await page.click('clearBtn');
  assert.equal(page.element('csvTextInput').value, '');
  assert.equal(page.element('importedCountValue').textContent, 1);
  assert.equal(page.element('continueBtn').disabled, false);
  await page.click('reimportBtn');
  assert.equal(page.element('importForm').hidden, true);
  assert.equal(page.requests.some((request) => request.init), false);
  for (const request of page.requests) assert.equal(request.event, eventName);
});

test('saved divisions default to database review, with Build Groups as a secondary action', async () => {
  const page = await loadPage({
    competitors: [{ firstName: 'Saved' }],
    groups: [{ groupDivisionNumber: 20 }, { groupDivisionNumber: 21 }]
  });
  assert.equal(page.element('savedDivisionCountValue').textContent, 2);
  assert.equal(page.element('continueBtn').textContent, 'Review Saved Divisions');
  assert.equal(page.element('buildGroupsBtn').hidden, false);
  await page.click('continueBtn');
  await page.click('buildGroupsBtn');
  assert.deepEqual(page.destinations, [
    '/tournament-setup/review-save/?source=saved',
    '/tournament-setup/build-groups/'
  ]);
});

test('canceling reimport confirmation leaves roster, divisions and draft untouched', async () => {
  const page = await loadPage({ competitors: [{ firstName: 'Saved' }], groups: [{ id: '20' }] });
  await page.click('reimportBtn');
  page.element('csvTextInput').value = 'First Name,Last Name\nNew,Competitor';
  await page.click('importBtn');
  assert.equal(page.confirmations.length, 1);
  assert.match(page.confirmations[0], /replaces all 1 saved competitors/);
  assert.match(page.confirmations[0], /does not merge/);
  assert.match(page.confirmations[0], /ring assignments and results are NOT cleared/);
  assert.equal(page.requests.some((request) => request.init), false);
  assert.equal(page.storage.has(draftKey), true);
  assert.equal(page.element('savedDivisionCountValue').textContent, 1);
  assert.equal(page.element('continueBtn').disabled, false);
});

test('confirmed reimport refreshes database counts and discards only this event draft', async () => {
  for (const draftEvent of [eventName, 'Other Event']) {
    const page = await loadPage({
      competitors: [{ firstName: 'Saved' }, { firstName: 'Second' }],
      groups: [{ id: '20' }],
      confirm: true,
      draftEvent
    });
    await page.click('reimportBtn');
    page.element('csvTextInput').value = 'First Name,Last Name\nNew,Competitor';
    await page.click('importBtn');
    const posts = page.requests.filter((request) => request.init);
    assert.equal(posts.length, 1);
    assert.equal(JSON.parse(posts[0].init.body).eventName, eventName);
    assert.equal(page.element('importedCountValue').textContent, 1);
    assert.equal(page.element('savedDivisionCountValue').textContent, 0);
    assert.equal(page.element('warningCountValue').textContent, 0);
    assert.equal(page.element('continueBtn').textContent, 'Continue to Build Groups');
    assert.equal(page.element('importForm').hidden, true);
    assert.equal(page.storage.has(draftKey), draftEvent !== eventName);
    assert.match(page.element('statusBar').textContent, /Rebuild and save divisions/);
  }
});

test('missing selection, missing database and failed snapshots never enable import or resume', async () => {
  for (const options of [{ noSelection: true }, { dbExists: false }, { failSnapshot: true }]) {
    const page = await loadPage(options);
    assert.equal(page.element('continueBtn').disabled, true);
    assert.equal(page.element('importBtn').disabled, true);
    assert.equal(page.element('importForm').hidden, true);
    await page.click('importBtn');
    assert.equal(page.requests.some((request) => request.init), false);
  }
});

test('groups endpoint loads the requested saved event even with an empty runtime cache', async (t) => {
  const groupStore = createGroupStore();
  const loadedEvents = [];
  const app = express();
  app.use('/api', createDivisionRouter({
    groupStore,
    loadSavedGroups: async (name) => {
      loadedEvents.push(name);
      return [{ groupDivisionNumber: 20, competitors: [{ firstName: 'Saved' }] }];
    }
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/groups?eventName=${encodeURIComponent(eventName)}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).groups[0].groupDivisionNumber, 20);
  assert.deepEqual(loadedEvents, [eventName]);
  assert.deepEqual(groupStore.loadGroups(), []);
});

test('groups endpoint reports database failures rather than an empty saved snapshot', async (t) => {
  t.mock.method(console, 'error', () => {});
  const app = express();
  app.use('/api', createDivisionRouter({
    groupStore: createGroupStore(),
    loadSavedGroups: async () => { throw new Error('Database unavailable'); }
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/groups?eventName=${encodeURIComponent(eventName)}`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Failed to load saved divisions' });
});
