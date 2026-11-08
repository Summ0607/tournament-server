const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const rules = require('../assets/visual-definitions');
const { createVisualDefinitionRouter } = require('../backend/visualDefinitionRoutes');
const { create } = require('../tournament-management/visual-definitions');

test('visual definitions validate exact fields, colors, font choices and numeric thresholds', () => {
  const defaults = rules.defaults();
  assert.equal(defaults.sidebarWidth, 220);
  assert.deepEqual(rules.validate(defaults), defaults);
  for (const field of rules.fields.filter((field) => field.type === 'number')) {
    assert.equal(rules.validate({ ...defaults, [field.key]: field.min })[field.key], field.min);
    assert.equal(rules.validate({ ...defaults, [field.key]: field.max })[field.key], field.max);
    for (const invalid of [field.min - 1, field.max + 1, '12', 12.5, null]) {
      assert.throws(() => rules.validate({ ...defaults, [field.key]: invalid }));
    }
  }
  for (const invalid of [{ ...defaults, text: 'red' }, { ...defaults, text: '#fff' },
    { ...defaults, fontFamily: '</style><script>' }, { ...defaults, layout: 'other' },
    { ...defaults, extra: true }, {}, null]) assert.throws(() => rules.validate(invalid));
  const preview = rules.preview(defaults);
  assert.match(preview, /Sample only/);
  assert.match(preview, /min-height:28px/);
  assert.doesNotMatch(preview, /<script/);
});

test('audience palette maps validated colors only and permits read-only viewer access', () => {
  const { apiRoles } = require('../backend/browserPermissions');
  const tokens = rules.colorPresentation({ ...rules.defaults(), primary: '#123456', bodySize: 20 });
  assert.equal(tokens['--audience-primary'], '#123456');
  assert.ok(Object.values(tokens).every((value) => /^#[0-9a-f]{6}$/.test(value)));
  assert.throws(() => rules.colorPresentation({ ...rules.defaults(), text: 'invalid' }));
  assert.ok(apiRoles('GET', '/api/visual-definitions').includes('viewer'));
  assert.deepEqual(apiRoles('PUT', '/api/visual-definitions'), ['administrator']);
  assert.equal(apiRoles('GET', '/api/schools').includes('viewer'), false);
});

test('server-wide definition API persists atomically, rejects stale saves and reports corrupt files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-definitions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'visual-definitions.json');
  const app = express();
  app.use(express.json());
  app.use('/api', createVisualDefinitionRouter(file));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/visual-definitions`;
  const initial = await (await fetch(url)).json();
  assert.deepEqual(initial, { revision: null, values: rules.defaults() });
  assert.equal(fs.existsSync(file), false);
  const put = (body) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await put({ revision: null, values: { ...initial.values, bodySize: 40 } })).status, 400);
  assert.equal(fs.existsSync(file), false);
  const values = { ...initial.values, primary: '#123456', bodySize: 13 };
  const saved = await (await put({ revision: null, values })).json();
  assert.equal(typeof saved.revision, 'string');
  assert.deepEqual(saved.values, values);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), saved);
  assert.deepEqual(await (await fetch(url)).json(), saved);
  assert.equal((await put({ revision: null, values: initial.values })).status, 409);
  assert.deepEqual(await (await fetch(url)).json(), saved);
  assert.deepEqual(fs.readdirSync(root), ['visual-definitions.json']);
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  fs.writeFileSync(file, '{invalid');
  assert.equal((await fetch(url)).status, 500);
  assert.equal((await put(saved)).status, 500);
  assert.equal(fs.readFileSync(file, 'utf8'), '{invalid');
  assert.equal(logs.length, 2);
});

function frontend({ failure = '', saveFailure = '', confirm = true } = {}) {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', handlers: {}, disabled: false,
      addEventListener(name, callback) { this.handlers[name] = callback; }, setAttribute() {} });
    return nodes.get(id);
  };
  let stored = { revision: null, values: rules.defaults() };
  const requests = [];
  const workspace = create({ document: { getElementById: get }, confirm: () => confirm,
    request: async (url, options) => {
      requests.push({ url, options });
      if (failure) throw new Error(failure);
      if (options && saveFailure) throw new Error(saveFailure);
      if (options) stored = { revision: 'saved', values: JSON.parse(options.body).values };
      return stored;
    } });
  return { get, workspace, requests };
}

test('editor saves server-wide values, previews draft changes, tracks dirty state and restores saved values', async () => {
  const page = frontend();
  await page.workspace.load();
  assert.equal(page.workspace.dirty(), false);
  page.get('vd-bodySize').value = '13';
  page.get('vd-bodySize').handlers.input();
  assert.match(page.get('vdPreview').srcdoc, /font:13px/);
  assert.equal(page.workspace.dirty(), true);
  await page.get('vdForm').handlers.submit({ preventDefault() {} });
  assert.equal(page.requests.at(-1).url, '/api/visual-definitions');
  assert.equal(JSON.parse(page.requests.at(-1).options.body).values.bodySize, 13);
  assert.equal(page.workspace.dirty(), false);
  assert.match(page.get('vdNotice').textContent, /Refresh Tournament Management/);
  page.get('vdDefaults').handlers.click();
  assert.equal(Number(page.get('vd-bodySize').value), 12);
  assert.equal(page.workspace.dirty(), true);
  await page.get('vdReload').handlers.click();
  assert.equal(Number(page.get('vd-bodySize').value), 13);
  assert.equal(page.workspace.dirty(), false);
  page.get('vd-primary-picker').value = '#abcdef';
  page.get('vd-primary-picker').handlers.input();
  assert.equal(page.get('vd-primary').value, '#abcdef');
});

test('invalid drafts hide stale preview, canceled reload preserves edits and loading errors disable save', async () => {
  const page = frontend({ confirm: false });
  await page.workspace.load();
  page.get('vd-primary').value = 'invalid';
  page.get('vd-primary').handlers.input();
  assert.equal(page.get('vdPreview').hidden, true);
  assert.match(page.get('vdPreviewError').textContent, /Invalid/);
  await page.get('vdForm').handlers.submit({ preventDefault() {} });
  assert.equal(page.requests.length, 1);
  await page.get('vdReload').handlers.click();
  assert.equal(page.get('vd-primary').value, 'invalid');
  const failed = frontend({ failure: 'Saved definitions unavailable' });
  await failed.workspace.load();
  assert.equal(failed.get('vdSave').disabled, true);
  assert.match(failed.get('vdNotice').textContent, /unavailable/);
  const failedSave = frontend({ saveFailure: 'Definitions changed in another session' });
  await failedSave.workspace.load();
  failedSave.get('vd-bodySize').value = '13';
  await failedSave.get('vdForm').handlers.submit({ preventDefault() {} });
  assert.equal(failedSave.workspace.dirty(), true);
  assert.equal(failedSave.get('vdSave').disabled, false);
  assert.match(failedSave.get('vdNotice').textContent, /another session/);
});

test('preview is sandboxed and the definition page does not inject global theme values', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'tournament-management', 'index.html'), 'utf8');
  assert.match(html, /data-nav-id="visual-definitions"[^>]+data-nav-parents="administration"/);
  assert.match(html, /<iframe id="vdPreview"[^>]+sandbox=""/);
  const editor = fs.readFileSync(path.join(__dirname, '..', 'tournament-management', 'visual-definitions.js'), 'utf8');
  assert.doesNotMatch(editor, /documentElement|setProperty|<style>/);
});

test('adopted presentation maps only typography and dimensions, never colors', () => {
  const definitions = rules.defaults();
  const tokens = rules.presentation({ ...definitions, fontFamily: 'arial', bodySize: 13, controlHeight: 32 });
  assert.equal(tokens['--vd-font'], 'Arial, sans-serif');
  assert.equal(tokens['--vd-body-size'], '13px');
  assert.equal(tokens['--vd-control-height'], '32px');
  assert.equal(tokens['--vd-line-height'], '1.4');
  assert.ok(Object.values(tokens).every((value) => !value.includes('#')));
  const css = fs.readFileSync(path.join(__dirname, '..', 'assets', 'tournament-presentation.css'), 'utf8');
  assert.match(css, /grid-template-columns: var\(--vd-sidebar-width\) minmax\(0, 1fr\)/);
  assert.match(css, /min-height: 100dvh/);
  assert.match(css, /max-width: var\(--vd-content-width\)/);
  assert.match(css, /max-width: 960px/);
});

test('simulator adopts compact presentation and retains coarse-pointer targets', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'simulator', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'assets', 'simulator-presentation.css'), 'utf8');
  assert.match(html, /src="\/assets\/tournament-presentation.js"/);
  assert.match(html, /class="step-ring-control"/);
  assert.doesNotMatch(html, /style="min-width:180px"/);
  assert.match(css, /\.metric strong \{ font-size: var\(--vd-body-size\)/);
  assert.match(css, /align-items: flex-end/);
  assert.match(css, /min-height: max\(44px, var\(--vd-control-height\)\)/);
});

test('presentation loading applies scoped saved tokens and reports failures without changing the shell', async (t) => {
  const { load } = require('../assets/tournament-presentation');
  const tokens = new Map();
  const classes = new Set();
  const attrs = new Map();
  const status = { hidden: true, textContent: '' };
  const shell = { style: { setProperty: (key, value) => tokens.set(key, value) },
    classList: { add: (name) => classes.add(name) }, setAttribute: (key, value) => attrs.set(key, value) };
  const document = { getElementById: () => status, querySelector: () => shell };
  await load({ document, rules, request: async () => ({ values: { ...rules.defaults(), sidebarWidth: 180 } }) });
  assert.equal(tokens.get('--vd-sidebar-width'), '180px');
  assert.equal(attrs.get('data-visual-layout'), 'full-window');
  assert.equal(classes.has('defined-presentation'), true);
  assert.equal(status.hidden, true);
  t.mock.method(console, 'error', () => {});
  const before = [...tokens];
  await load({ document, rules, request: async () => { throw new Error('Definitions unavailable'); } });
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /Definitions unavailable.*Existing presentation retained/);
  assert.deepEqual([...tokens], before);
});
