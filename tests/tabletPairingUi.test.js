const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function harness({ failRing = '', changeEvent = false, noRings = false, failImage = false } = {}) {
  const nodes = new Map(), requests = [], prints = [], events = {}, classes = new Set();
  class Node {
    constructor(tag = '') { this.tag = tag; this.children = []; this.handlers = {}; this.value = ''; this.disabled = false; this.hidden = false; }
    get options() { return this.children; }
    append(...items) {
      this.children.push(...items);
      if (this.tag === 'select' && !this.value && items.length) this.value = items[0].value;
    }
    replaceChildren() { this.children = []; }
    addEventListener(name, callback) { this.handlers[name] = callback; }
    async decode() { if (failImage) throw new Error('QR image could not load.'); }
  }
  for (const id of ['ring', 'status', 'display', 'code', 'print', 'printAll', 'address', 'printPages', 'title', 'details', 'qr']) {
    nodes.set(id, new Node(['ring', 'address'].includes(id) ? 'select' : id === 'qr' ? 'img' : ''));
  }
  nodes.get('address').value = 'ip';
  const context = vm.createContext({
    URLSearchParams,
    document: {
      getElementById: (id) => nodes.get(id), createElement: (tag) => new Node(tag),
      body: { classList: { add: (value) => classes.add(value), remove: (value) => classes.delete(value) } }
    },
    window: { location: { search: '?ring=ring-a-2' },
      addEventListener: (name, callback) => { events[name] = callback; },
      print() {
        prints.push({ all: classes.has('printing-all'),
          sheets: nodes.get('printPages').children.map((sheet) => ({
            title: sheet.children[0].textContent, details: sheet.children[1].textContent,
            image: sheet.children[2].src, help: sheet.children[3].textContent
          })) });
        events.afterprint?.();
      }
    },
    fetch: async (url, options) => {
      const body = options ? JSON.parse(options.body) : null;
      requests.push({ url, body });
      if (url === '/api/rings/config') return { ok: true, json: async () => ({
        allowedRings: noRings ? [] : [{ ringId: 'ring-a-1', ringLabel: 'A1' }, { ringId: 'ring-a-2', ringLabel: 'A2' }]
      }) };
      return { ok: body.ringId !== failRing, status: 500, json: async () => ({
        error: 'QR generation failed', ringLabel: body.ringId === 'ring-a-1' ? 'A1' : 'A2',
        event: changeEvent && body.ringId === 'ring-a-2' ? 'Changed Tournament' : 'Test Tournament',
        day: '2026-11-05', server: body.useIp ? 'https://192.168.4.42:3443' : 'https://tourn-svr.home.arpa:3443',
        image: 'data:image/png;base64,test'
      }) };
    }
  });
  const ready = vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'assets', 'tablet-pairing.js'), 'utf8'), context);
  await ready;
  return { nodes, requests, prints, classes,
    click: (id) => nodes.get(id).handlers.click(),
    change(id, value) { nodes.get(id).value = value; nodes.get(id).handlers.change(); } };
}

test('selected ring display and printing use QR details and invalidate on address/ring changes', async () => {
  const h = await harness();
  assert.equal(h.nodes.get('ring').value, 'ring-a-2');
  assert.equal(h.nodes.get('title').textContent, 'Ring A2');
  assert.equal(h.nodes.get('print').disabled, false);
  assert.match(h.nodes.get('details').textContent, /192\.168\.4\.42:3443/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'tablet-pairing', 'index.html'), 'utf8'),
    /id="address"><option value="ip">/);
  await h.click('print');
  assert.equal(h.prints.length, 1);
  assert.equal(h.prints[0].all, false);
  h.change('address', 'dns');
  assert.equal(h.nodes.get('code').hidden, true);
  assert.equal(h.nodes.get('print').disabled, true);
  await h.click('display');
  assert.match(h.nodes.get('details').textContent, /tourn-svr\.home\.arpa:3443/);
  h.change('ring', 'ring-a-1');
  assert.equal(h.nodes.get('print').disabled, true);
});

test('print all generates one labeled sheet per ring and clears print mode afterward', async () => {
  const h = await harness();
  await h.click('printAll');
  assert.equal(h.prints.length, 1);
  assert.equal(h.prints[0].all, true);
  assert.deepEqual(h.prints[0].sheets.map((sheet) => sheet.title), ['Ring A1', 'Ring A2']);
  for (const sheet of h.prints[0].sheets) {
    assert.match(sheet.details, /Test Tournament - 2026-11-05/);
    assert.match(sheet.image, /^data:image\/png/);
    assert.match(sheet.help, /expires at midnight/);
  }
  assert.equal(h.classes.has('printing-all'), false);
  assert.equal(h.nodes.get('printPages').children.length, 0);
  assert.equal(h.nodes.get('printAll').disabled, false);
});

test('failed generation, changed tournament or undecodable image never prints a partial batch', async () => {
  for (const options of [{ failRing: 'ring-a-2' }, { changeEvent: true }, { failImage: true }]) {
    const h = await harness(options);
    await h.click('printAll');
    assert.equal(h.prints.length, 0);
    assert.ok(h.nodes.get('status').textContent);
    assert.equal(h.nodes.get('printPages').children.length, 0);
    assert.equal(h.nodes.get('printAll').disabled, false);
  }
});

test('empty configuration disables QR generation and print actions explicitly', async () => {
  const h = await harness({ noRings: true });
  assert.match(h.nodes.get('status').textContent, /No rings configured/);
  for (const id of ['print', 'printAll', 'display']) assert.equal(h.nodes.get(id).disabled, true);
});
