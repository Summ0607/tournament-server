const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const rules = require('../assets/competition-settings');
const { createCompetitionSettingRouter } = require('../backend/competitionSettingRoutes');

test('competition defaults reproduce medals, correct team flags and code-based age/rank categories', () => {
  assert.deepEqual(rules.defaults('medal-points').map((r) => r.points), [10, 8, 5, 5]);
  const types = rules.defaults('competition-types');
  assert.deepEqual(types.filter((r) => r.isTeam).map((r) => r.code), ['TS', 'TH']);
  const categories = rules.defaults('grand-champion-categories');
  assert.equal(categories.length, 12);
  assert.ok(categories.filter((r) => r.name.includes('Gup')).every((r) => r.minRank === 'G10' && r.maxRank === 'CDB'));
  assert.ok(categories.filter((r) => r.name.includes('Black')).every((r) => r.minRank === 'D1' && r.maxRank === 'D3'));
  for (const [kind, changes] of [
    ['medal-points', [{ points: -1 }, { points: 1.5 }, { name: '' }]],
    ['grand-champion-categories', [{ minAge: 50, maxAge: 20 }, { minRank: 'D3', maxRank: 'G1' }, { gender: 'X' }]],
    ['competition-types', [{ isTeam: 'true' }, { code: 'bad-code' }]]
  ]) for (const change of changes) assert.throws(() => rules.validate(kind, { ...rules.defaults(kind)[0], ...change }));
});
test('settings APIs isolate tournaments, persist CRUD, reject stale writes and lock operational events', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'competition-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['A', 'B']) { fs.mkdirSync(path.join(root, name)); fs.writeFileSync(path.join(root, name, 'tournament.db'), ''); }
  let locked = false;
  const app = express(); app.use(express.json());
  app.use('/api', createCompetitionSettingRouter({ eventsRoot: root, configurationStatus: () => ({ configurationLocked: locked }) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/competition-settings`;
  const get = async (kind, name = 'A') => (await (await fetch(`${base}/${kind}?eventName=${name}`)).json());
  const write = (kind, suffix, body, method = 'POST') => fetch(`${base}/${kind}${suffix}?eventName=A`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await fetch(`${base}/medal-points`)).status, 400);
  assert.equal((await fetch(`${base}/medal-points?eventName=..`)).status, 400);
  assert.equal((await fetch(`${base}/medal-points?eventName=missing`)).status, 404);
  for (const kind of Object.keys(rules.schemas)) {
    const initial = await get(kind);
    const row = { ...initial.rows[0], name: 'Custom entry' };
    if (kind === 'competition-types') row.code = 'CUSTOM';
    const response = await write(kind, '', { revision: initial.revision, row });
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.equal(saved.rows.length, initial.rows.length + 1);
    assert.deepEqual((await get(kind, 'B')).rows, initial.rows);
    assert.equal((await write(kind, '', { revision: null, row })).status, 409);
    const added = saved.rows.at(-1);
    const edited = await (await write(kind, `/${added.id}`, { revision: saved.revision, row: { ...row, name: 'Edited' } }, 'PUT')).json();
    const deleted = await write(kind, '/delete', { revision: edited.revision, ids: [added.id] });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).rows.length, initial.rows.length);
    assert.ok(fs.existsSync(path.join(root, 'A', `${kind}.json`)));
  }
  locked = true;
  const current = await get('medal-points');
  assert.equal(current.configurationLocked, true);
  assert.equal((await write('medal-points', '', { revision: current.revision, row: current.rows[0] })).status, 409);
  assert.equal((await write('medal-points', '/delete', { revision: current.revision, ids: [current.rows[0].id] })).status, 409);
});
