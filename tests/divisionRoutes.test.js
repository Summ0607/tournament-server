const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const { createDivisionRouter } = require('../backend/divisionRoutes');
const { createGroupStore } = require('../backend/groupStore');

const eventName = 'Winter Tournament 2027';

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
