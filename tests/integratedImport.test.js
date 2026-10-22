const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const initializeDatabase = require('../db/init');
const importCSV = require('../db/import-csv');
const { createCompetitorStore } = require('../backend/competitorStore');

const html = fs.readFileSync(path.join(__dirname, '..', 'tournament-management', 'index.html'), 'utf8');
const winter = 'Winter Tournament 2027';
const spring = 'Spring Tournament 2027';
const draftKey = 'tournamentSetup.groupReviewDraft';
const savedCompetitor = { id: 1, firstName: 'Saved', lastName: 'Competitor', rank: 'G1', gender: 'Male', dob: '01/01/2010' };
const newCompetitor = { ...savedCompetitor, id: 2, firstName: 'New' };
const settle = () => new Promise(setImmediate);

function element(text = '') {
  const classes = new Set();
  let value = '';
  return {
    textContent: text,
    innerHTML: '',
    children: [],
    files: [],
    hidden: false,
    disabled: false,
    handlers: {},
    get value() { return value; },
    set value(next) {
      value = next;
      if (next === '') this.files = [];
    },
    classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      contains: (name) => classes.has(name)
    },
    addEventListener(name, handler) { this.handlers[name] = handler; },
    appendChild(child) { this.children.push(child); },
    insertRow() { const row = element(); this.children.push(row); return row; },
    insertCell() { const cell = element(); this.children.push(cell); return cell; },
    setAttribute(name, next) { this[name] = next; },
    getAttribute(name) { return this[name]; },
    querySelectorAll() { return []; },
    focus() {}
  };
}

async function loadPage(options = {}) {
  const elements = new Map();
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    elements.set(match[1], element(html.slice(match.index + match[0].length).split('<')[0]));
  }
  const nav = ['Event Setup', 'Import', 'Group Builder'].map(element);
  const storage = new Map([['eventAdmin.lastSelectedEvent', winter]]);
  if (options.draft) storage.set(draftKey, JSON.stringify(options.draft));
  const rosters = new Map([[winter, options.competitors || []], [spring, []]]);
  let groups = options.groups || [];
  let dbExists = options.dbExists !== false;
  let failSnapshot = Boolean(options.failSnapshot);
  const requests = [];
  const confirmations = [];
  const errors = [];
  const context = vm.createContext({
    setTimeout: () => 0,
    clearTimeout() {},
    console: { warn: (...args) => errors.push(args), error: (...args) => errors.push(args) },
    window: {
      location: { protocol: 'http:', origin: 'http://localhost:3000' },
      localStorage: {
        getItem: (key) => storage.get(key) || null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: (key) => storage.delete(key)
      },
      confirm: (message) => { confirmations.push(message); return options.confirm === true; }
    },
    document: {
      getElementById: (id) => {
        assert.ok(elements.has(id), `Missing element ${id}`);
        return elements.get(id);
      },
      querySelector: () => element(),
      querySelectorAll: () => nav,
      createElement: () => element()
    },
    fetch: async (url, init) => {
      const request = new URL(url);
      const name = request.searchParams.get('eventName');
      requests.push({ path: request.pathname, name, init });
      let data;
      switch (request.pathname) {
        case '/api/events/list': data = { events: [winter, spring] }; break;
        case '/api/events/active': data = { activeEvent: '' }; break;
        case '/api/events/config':
          data = { eventConfig: { name }, dbExists: name === winter ? dbExists : false };
          break;
        case '/api/competitors':
          if (options.waitForRoster) await options.waitForRoster;
          if (failSnapshot) return { ok: false, json: async () => ({ error: 'Database unavailable' }) };
          data = rosters.get(name);
          break;
        case '/api/groups': data = { groups }; break;
        case '/api/divisions/save':
          if (options.failSave) return { ok: false, json: async () => ({ error: 'Save failed' }) };
          groups = JSON.parse(init.body).groups;
          data = { saved: groups.length, groups };
          break;
        case '/api/events/import-csv':
          if (options.waitForImport) await options.waitForImport;
          if (options.failImport) return { ok: false, json: async () => ({ error: 'Import failed' }) };
          rosters.set(winter, [newCompetitor]);
          groups = [];
          dbExists = true;
          data = { normalizedCompetitors: [newCompetitor], rankWarnings: [], eventName: winter };
          break;
        default: throw new Error(`Unexpected request ${url}`);
      }
      return { ok: true, json: async () => data };
    }
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  await settle();
  const dispatch = async (target, name = 'click') => {
    await target.handlers[name]();
    await settle();
  };
  return {
    element: (id) => elements.get(id),
    click: (id) => dispatch(elements.get(id)),
    input: (id, name) => dispatch(elements.get(id), name),
    openImport: () => dispatch(nav[1]),
    openGroups: () => dispatch(nav[2]),
    select: async (name) => {
      elements.get('eventSelect').value = name;
      await dispatch(elements.get('eventSelect'), 'change');
    },
    failSnapshot: () => { failSnapshot = true; },
    requests, confirmations, storage, errors
  };
}

function assertNextDefault(page) {
  assert.equal(page.element('importNextBtn').disabled, false);
  assert.equal(page.element('importNextBtn').classList.contains('next-action'), true);
  assert.equal(page.element('importBtn').classList.contains('primary'), false);
}

function assertImportDefault(page) {
  assert.equal(page.element('importBtn').disabled, false);
  assert.equal(page.element('importBtn').classList.contains('primary'), true);
  assert.equal(page.element('importNextBtn').disabled, true);
  assert.equal(page.element('importNextBtn').classList.contains('next-action'), false);
}

test('integrated Import resumes saved competitors and feeds saved groups without importing', async () => {
  const page = await loadPage({
    competitors: [savedCompetitor],
    groups: [{ id: '20', groupDivisionNumber: 20, competitors: [savedCompetitor] }]
  });
  await page.openImport();
  assertNextDefault(page);
  assert.equal(page.element('importedCount').textContent, 1);
  assert.equal(page.element('warningCount').textContent, 'Not available');
  assert.equal(page.element('importDetailTime').textContent, 'Loaded from saved database');
  await page.click('importNextBtn');
  assert.equal(page.element('groupsView').hidden, false);
  assert.match(page.element('gbStats').innerHTML, /Competitors: <strong>1/);
  assert.match(page.element('gbStats').innerHTML, /Groups: <strong>1/);
  assert.equal(page.requests.some((request) => request.init), false);
  assert.deepEqual(page.errors, []);
});

test('file or pasted input selects Import CSV; Clear or removing input restores Next', async () => {
  const page = await loadPage({ competitors: [savedCompetitor] });
  await page.openImport();
  page.element('csvTextInput').value = 'First Name\nNew';
  await page.input('csvTextInput', 'input');
  assertImportDefault(page);
  page.element('csvTextInput').value = '';
  await page.input('csvTextInput', 'input');
  assertNextDefault(page);
  page.element('csvFileInput').files = [{ name: 'same-file.csv', text: async () => 'First Name\nNew' }];
  await page.input('csvFileInput', 'change');
  assertImportDefault(page);
  await page.click('clearImportBtn');
  assertNextDefault(page);
  assert.equal(page.element('importedCount').textContent, 1);
  assert.equal(page.requests.some((request) => request.init), false);
});

test('missing database or an empty saved roster defaults to Import CSV', async () => {
  for (const dbExists of [false, true]) {
    const page = await loadPage({ dbExists });
    await page.openImport();
    assertImportDefault(page);
    assert.equal(page.element('importedCount').textContent, 0);
    assert.match(page.element('importSummary').textContent, dbExists ? /no competitors/ : /No saved database/);
    page.element('csvTextInput').value = 'First Name\nNew';
    await page.click('importBtn');
    assertNextDefault(page);
    assert.equal(page.confirmations.length, 0);
  }
});

test('canceling replacement preserves saved groups, draft and pending input', async () => {
  const draft = { eventName: winter, groups: [{ id: 'old', competitors: [savedCompetitor] }] };
  const page = await loadPage({ competitors: [savedCompetitor], draft });
  await page.openImport();
  page.element('csvTextInput').value = 'First Name\nNew';
  await page.input('csvTextInput', 'input');
  await page.click('importBtn');
  assert.equal(page.confirmations.length, 1);
  assert.match(page.confirmations[0], /replaces all 1 saved competitors/);
  assert.match(page.confirmations[0], /Ring assignments and results are NOT cleared/);
  assertImportDefault(page);
  assert.equal(page.storage.get(draftKey), JSON.stringify(draft));
  assert.equal(page.requests.some((request) => request.init), false);
});

test('replacement resets cached groups and same-event draft before Next loads the new roster', async () => {
  const draft = { eventName: winter, groups: [{ id: 'old', competitors: [savedCompetitor] }] };
  const page = await loadPage({ competitors: [savedCompetitor], draft, confirm: true });
  await page.openGroups();
  assert.match(page.element('gbStats').innerHTML, /Groups: <strong>1/);
  await page.openImport();
  page.element('csvTextInput').value = 'First Name\nNew';
  await page.input('csvTextInput', 'input');
  await page.click('importBtn');
  assertNextDefault(page);
  assert.equal(page.element('csvTextInput').value, '');
  assert.equal(page.storage.has(draftKey), false);
  assert.equal(page.element('warningCount').textContent, 0);
  await page.click('importNextBtn');
  assert.match(page.element('gbStats').innerHTML, /Competitors: <strong>1/);
  assert.match(page.element('gbStats').innerHTML, /Groups: <strong>0/);
  assert.equal(page.element('gbSaveBtn').disabled, true);
  assert.equal(page.element('gbBuildBtn').disabled, false);
  const posts = page.requests.filter((request) => request.init);
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].init.body).eventName, winter);
  assert.deepEqual(page.errors, []);
});

test('selecting a file supersedes previously pasted text and preserves another event draft', async () => {
  const draft = { eventName: spring, groups: [] };
  const page = await loadPage({ competitors: [savedCompetitor], draft, confirm: true });
  await page.openImport();
  page.element('csvTextInput').value = 'old text';
  page.element('csvFileInput').files = [{ name: 'replacement.csv', text: async () => 'First Name\nFromFile' }];
  await page.input('csvFileInput', 'change');
  await page.click('importBtn');
  const post = page.requests.find((request) => request.init);
  assert.equal(JSON.parse(post.init.body).csvText, 'First Name\nFromFile');
  assert.equal(page.storage.get(draftKey), JSON.stringify(draft));
  await page.click('clearImportBtn');
  assert.equal(page.element('warningCount').textContent, 0);
});

test('snapshot failures and failed replacement block continuation instead of displaying an empty event', async () => {
  for (const options of [{ failSnapshot: true }, { failImport: true, confirm: true }]) {
    const page = await loadPage({ competitors: [savedCompetitor], ...options });
    await page.openImport();
    if (options.failImport) {
      page.element('csvTextInput').value = 'First Name\nNew';
      await page.click('importBtn');
    }
    assert.equal(page.element('importBtn').disabled, true);
    assert.equal(page.element('importNextBtn').disabled, true);
    assert.equal(page.element('importedCount').textContent, 'Unavailable');
    assert.match(page.element('importNotice').textContent, /Reopen Import/);
  }
});

test('event switching does not retain a different event roster or pending CSV', async () => {
  const page = await loadPage({ competitors: [savedCompetitor] });
  await page.openImport();
  page.element('csvTextInput').value = 'old input';
  await page.select(spring);
  await page.openImport();
  assertImportDefault(page);
  assert.equal(page.element('importEventChip').textContent, spring);
  assert.equal(page.element('importedCount').textContent, 0);
  assert.equal(page.element('csvTextInput').value, '');
  await page.select(winter);
  await page.openImport();
  assertNextDefault(page);
});

test('a late snapshot response cannot overwrite the newly selected event', async () => {
  let release;
  const waitForRoster = new Promise((resolve) => { release = resolve; });
  const page = await loadPage({ competitors: [savedCompetitor], waitForRoster });
  await page.openImport();
  assert.equal(page.element('importNextBtn').disabled, true);
  await page.select(spring);
  await page.openImport();
  release();
  await settle();
  assert.equal(page.element('importEventChip').textContent, spring);
  assert.equal(page.element('importedCount').textContent, 0);
  assertImportDefault(page);
});

test('imports cannot be double-submitted and navigation waits until completion', async () => {
  let release;
  const waitForImport = new Promise((resolve) => { release = resolve; });
  const page = await loadPage({ waitForImport });
  await page.openImport();
  page.element('csvTextInput').value = 'First Name\nNew';
  const importing = page.click('importBtn');
  await settle();
  await page.click('importBtn');
  await page.openGroups();
  assert.equal(page.element('groupsView').hidden, true);
  assert.equal(page.requests.filter((request) => request.init).length, 1);
  release();
  await importing;
  assertNextDefault(page);
});

test('a missing database can be initialized, imported and used to persist group assignments', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'integrated-import-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, 'tournament.db');
  const csvPath = path.join(directory, 'registration.csv');
  fs.writeFileSync(csvPath, 'First Name,Last Name,DOB,Gender,Current Rank\nNew,Competitor,01/01/2010,Male,G1\n');
  assert.equal(fs.existsSync(dbPath), false);
  await initializeDatabase(dbPath);
  await importCSV(csvPath, dbPath, { clearExisting: true });
  const store = createCompetitorStore(dbPath);
  const competitors = await store.loadCompetitors();
  assert.equal(competitors.length, 1);
  assert.equal(competitors[0].firstName, 'New');
  await store.saveDivisionAssignments([{ groupId: 'new-group', competitors }]);
  const restored = await createCompetitorStore(dbPath).loadCompetitors();
  assert.equal(restored[0].groupDivisionNumber, 20);
});

test('saved groups emphasize activation; drag reorder emphasizes save until successfully saved again', async () => {
  const page = await loadPage({
    competitors: [savedCompetitor, newCompetitor],
    groups: [
      { id: '20', competitors: [savedCompetitor] },
      { id: '22', competitors: [newCompetitor] }
    ]
  });
  await page.openGroups();
  assert.equal(page.element('gbSaveBtn').classList.contains('primary'), false);
  assert.equal(page.element('gbDoneBtn').hidden, false);
  const banners = page.element('gbBanners');
  const banner = (id) => ({
    dataset: { id },
    closest: (selector) => selector === '.gb-banner' ? { dataset: { id } } : {}
  });
  banners.handlers.dragstart({
    target: banner('20'),
    dataTransfer: { setData() {}, setDragImage() {} }
  });
  banners.handlers.drop({ target: banner('22'), preventDefault() {} });
  assert.equal(page.element('gbSaveBtn').classList.contains('primary'), true);
  assert.equal(page.element('gbDoneBtn').hidden, true);
  await page.click('gbSaveBtn');
  assert.equal(page.element('gbSaveBtn').classList.contains('primary'), false);
  assert.equal(page.element('gbDoneBtn').hidden, false);
  page.element('gbMaxSize').value = '8';
  await page.input('gbMaxSize', 'change');
  assert.equal(page.element('gbSaveBtn').classList.contains('primary'), true);
  assert.equal(page.element('gbDoneBtn').hidden, true);
});

test('unsaved browser drafts and failed saves do not offer activation', async () => {
  const page = await loadPage({
    competitors: [savedCompetitor],
    draft: { eventName: winter, groups: [{ id: '20', competitors: [savedCompetitor] }] },
    failSave: true
  });
  await page.openGroups();
  assert.equal(page.element('gbSaveBtn').classList.contains('primary'), true);
  assert.equal(page.element('gbDoneBtn').hidden, true);
  await page.click('gbSaveBtn');
  assert.equal(page.element('gbSaveBtn').classList.contains('primary'), true);
  assert.equal(page.element('gbDoneBtn').hidden, true);
});
