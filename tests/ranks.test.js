const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createRankRouter, initialRanks, validateRank } = require('../backend/rankRoutes');
const { create } = require('../tournament-management/ranks');

test('reference seed preserves requested young-rank weights, Gup and Dan codes and title variants', () => {
  assert.deepEqual(initialRanks.slice(0, 4).map((rank) => rank.code), ['TTLD', 'SD', 'TT', 'LD']);
  assert.deepEqual([...initialRanks].sort((a, b) => b.sortWeight - a.sortWeight).slice(0, 4)
    .map((rank) => [rank.code, rank.sortWeight]), [['TTLD', 120], ['TT', 118], ['LD', 117], ['SD', 113]]);
  for (let n = 1; n <= 10; n++) assert.equal(initialRanks.filter((rank) => rank.code === `G${n}`).length, 1);
  for (let n = 1; n <= 9; n++) assert.ok(initialRanks.some((rank) => rank.code === `D${n}`));
  assert.equal(initialRanks.filter((rank) => rank.code === 'D4').length, 2);
  assert.equal(initialRanks.find((rank) => rank.name === 'Grandmaster').code, '');
  assert.equal(validateRank({ ...initialRanks[0], code: 'd10' }).code, 'D10');
});
test('rank API seeds once, persists edits and bulk deletion, allows shared codes and rejects invalid requests', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rank-directory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'ranks.json');
  const app = express();
  app.use(express.json());
  app.use('/api', createRankRouter(file));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/ranks`;
  const get = async () => (await (await fetch(url)).json()).ranks;
  const write = (suffix, body, method = 'POST') => fetch(url + suffix, { method,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.deepEqual((await get()).slice(0, 4).map((rank) => rank.code), ['TTLD', 'TT', 'LD', 'SD']);
  const input = { code: 'D10', name: '10th Dan', belt: 'Black', alternateNames: '', sortWeight: 5 };
  assert.equal((await write('', input)).status, 201);
  const added = (await get()).find((rank) => rank.name === input.name);
  assert.equal((await write('', { ...input, name: '10th Dan Variant' })).status, 201);
  assert.equal((await write('', { ...input, name: '10TH DAN' })).status, 409);
  for (const change of [{ name: '' }, { code: 'G0' }, { sortWeight: '3' }, { sortWeight: -1 }, { sortWeight: 1.5 }]) {
    assert.equal((await write('', { ...input, ...change })).status, 400);
  }
  assert.equal((await write(`/${added.id}`, { ...input, sortWeight: 130 }, 'PUT')).status, 200);
  assert.equal((await get())[0].id, added.id);
  assert.equal((await write('/missing', input, 'PUT')).status, 404);
  assert.equal((await write('/delete', { ids: ['missing'] })).status, 409);
  assert.equal((await write('/delete', { ids: [] })).status, 400);
  assert.equal((await write('/delete', { ids: [added.id] })).status, 200);
  assert.ok(!(await get()).some((rank) => rank.id === added.id));
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).ranks.every((rank) => rank.id !== added.id));
  t.mock.method(console, 'error', () => {});
  fs.writeFileSync(file, '{bad');
  assert.equal((await fetch(url)).status, 500);
  assert.equal(fs.readFileSync(file, 'utf8'), '{bad');
});
test('rank editor selects, cancels dirty drafts, retains failed saves, and confirms reference deletion', async () => {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, handlers: {},
      addEventListener(k, fn) { this.handlers[k] = fn; }, setAttribute() {},
      showModal() { this.open = true; }, close() { this.open = false; }, focus() {} });
    return nodes.get(id);
  };
  let confirm = false, failure = false;
  let ranks = initialRanks.map((rank) => ({ ...rank }));
  const workspace = create({ document: { getElementById: get }, confirm: () => confirm,
    request: async (url, options) => {
      if (options) {
        if (failure) throw new Error('Save failed');
        const body = JSON.parse(options.body);
        if (url.endsWith('/delete')) ranks = ranks.filter((rank) => !body.ids.includes(rank.id));
        else ranks.push({ id: 'new', ...body });
      }
      return { ranks };
    } });
  await workspace.load();
  assert.match(get('ranksBody').innerHTML, /Tiny Tigers \/ Little Dragons.*Special Dragons/);
  get('addRank').handlers.click();
  get('rank-name').value = '<New Rank>';
  assert.equal(workspace.canLeave(), false);
  assert.equal(get('rankDialog').open, true);
  failure = true;
  await get('rankForm').handlers.submit({ preventDefault() {} });
  assert.match(get('rankError').textContent, /Save failed/);
  assert.equal(workspace.dirty(), true);
  failure = false;
  await get('rankForm').handlers.submit({ preventDefault() {} });
  assert.match(get('ranksBody').innerHTML, /&lt;New Rank&gt;/);
  assert.equal(get('rankDialog').open, false);
  get('ranksSelectAll').checked = true;
  get('ranksSelectAll').handlers.change();
  assert.equal(get('deleteRanks').disabled, false);
  get('deleteRanks').handlers.click();
  assert.equal(ranks.length, initialRanks.length + 1);
  confirm = true;
  await get('deleteRanks').handlers.click();
  assert.equal(ranks.length, 0);
  assert.equal(get('deleteRanks').disabled, true);
});
