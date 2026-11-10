const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function harness({ oversizeDivision = false, noDivisions = false, noEvent = false, failImage = false } = {}) {
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
  for (const id of ['division', 'status', 'display', 'code', 'print', 'printAll', 'printPages', 'title', 'details', 'qr']) {
    nodes.set(id, new Node(id === 'division' ? 'select' : id === 'qr' ? 'img' : ''));
  }
  const divisions = noDivisions ? [] : [
    { groupId: 'group-20', groupDivisionNumber: 20, name: 'Youth Gup A', competitors: Array.from({ length: 4 }) },
    { groupId: 'group-21', groupDivisionNumber: 21, name: 'Youth Gup B', competitors: Array.from({ length: 13 }) }
  ];
  function codeEntry(requested) {
    const group = divisions.find((division) => String(division.groupDivisionNumber) === String(requested));
    const entry = { groupId: group.groupId, groupDivisionNumber: group.groupDivisionNumber,
      name: group.name, competitorCount: group.competitors.length };
    if (oversizeDivision && group.groupDivisionNumber === 21) entry.error = 'Division 21 has 13 competitors; tablet divisions allow at most 12.';
    else entry.image = `data:image/png;base64,division-${group.groupDivisionNumber}`;
    return entry;
  }
  const context = vm.createContext({
    URLSearchParams,
    document: {
      getElementById: (id) => nodes.get(id), createElement: (tag) => new Node(tag),
      body: { classList: { add: (value) => classes.add(value), remove: (value) => classes.delete(value) } }
    },
    window: { location: { search: '?division=21' },
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
      if (url === '/api/events/active') return { ok: true, json: async () => ({ activeEvent: noEvent ? '' : 'Test Tournament' }) };
      if (url.startsWith('/api/groups')) return { ok: true, json: async () => ({ groups: divisions }) };
      return { ok: true, json: async () => ({ eventName: 'Test Tournament',
        codes: (body.groupIds || divisions.map((division) => division.groupDivisionNumber)).map(codeEntry) }) };
    }
  });
  const ready = vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'assets', 'division-qr.js'), 'utf8'), context);
  await ready;
  return { nodes, requests, prints, classes,
    click: (id) => nodes.get(id).handlers.click(),
    change(id, value) { nodes.get(id).value = value; nodes.get(id).handlers.change(); } };
}

test('requested division is selected, displayed with details, and printable', async () => {
  const h = await harness();
  assert.equal(h.nodes.get('division').value, '21');
  assert.equal(h.nodes.get('title').textContent, 'Division 21');
  assert.match(h.nodes.get('details').textContent, /Test Tournament - Youth Gup B - 13 competitors/);
  assert.equal(h.nodes.get('print').disabled, false);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'division-qr', 'index.html'), 'utf8'),
    /data-auth-workspace="division-qr"/);
  await h.click('print');
  assert.equal(h.prints.length, 1);
  assert.equal(h.prints[0].all, false);
  h.change('division', '20');
  assert.equal(h.nodes.get('code').hidden, true);
  assert.equal(h.nodes.get('print').disabled, true);
});

test('print all generates one labeled sheet per division and clears print mode afterward', async () => {
  const h = await harness();
  await h.click('printAll');
  assert.equal(h.prints.length, 1);
  assert.equal(h.prints[0].all, true);
  assert.deepEqual(h.prints[0].sheets.map((sheet) => sheet.title), ['Division 20', 'Division 21']);
  for (const sheet of h.prints[0].sheets) {
    assert.match(sheet.details, /Test Tournament - Youth Gup/);
    assert.match(sheet.image, /^data:image\/png/);
    assert.match(sheet.help, /self-contained/);
  }
  assert.equal(h.classes.has('printing-all'), false);
  assert.equal(h.nodes.get('printPages').children.length, 0);
  assert.equal(h.nodes.get('printAll').disabled, false);
});

test('an oversize division or undecodable image never prints a partial batch', async () => {
  for (const options of [{ oversizeDivision: true }, { failImage: true }]) {
    const h = await harness(options);
    await h.click('printAll');
    assert.equal(h.prints.length, 0);
    assert.ok(h.nodes.get('status').textContent);
    assert.equal(h.nodes.get('printPages').children.length, 0);
    assert.equal(h.nodes.get('printAll').disabled, false);
  }
});

test('oversize division errors are shown when displayed individually', async () => {
  const h = await harness({ oversizeDivision: true });
  assert.match(h.nodes.get('status').textContent, /13 competitors/);
  assert.equal(h.nodes.get('code').hidden, true);
  assert.equal(h.nodes.get('print').disabled, true);
});

test('missing event or divisions disables QR generation with an explicit message', async () => {
  const noEvent = await harness({ noEvent: true });
  assert.match(noEvent.nodes.get('status').textContent, /Activate a tournament/);
  const noDivisions = await harness({ noDivisions: true });
  assert.match(noDivisions.nodes.get('status').textContent, /No saved divisions/);
  for (const id of ['print', 'printAll', 'display']) assert.equal(noDivisions.nodes.get(id).disabled, true);
});
