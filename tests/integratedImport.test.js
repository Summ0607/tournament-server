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
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains: (name) => classes.has(name)
    },
    addEventListener(name, handler) { this.handlers[name] = handler; },
    appendChild(child) { this.children.push(child); },
    insertRow() { const row = element(); this.children.push(row); return row; },
    insertCell() { const cell = element(); this.children.push(cell); return cell; },
    setAttribute(name, next) { this[name] = next; },
    getAttribute(name) { return this[name]; },
    hasAttribute(name) { return Object.hasOwn(this, name); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    checkValidity() { return true; },
    reportValidity() {},
    focus() {}
  };
}

async function loadPage(options = {}) {
  const elements = new Map();
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    elements.set(match[1], element(html.slice(match.index + match[0].length).split('<')[0]));
  }
  const nav = ['Event Setup', 'Import', 'Group Builder', 'Ring Assignment', 'Head Table', 'Competitors', 'Judges & Volunteers', 'Reports & Results'].map(element);
  let activeEvent = options.activeEvent || '';
  let activeFailure = false;
  let ringFailure = Boolean(options.failRings);
  const storage = new Map([['eventAdmin.lastSelectedEvent', options.selectedEvent ?? winter]]);
  if (options.draft) storage.set(draftKey, JSON.stringify(options.draft));
  const rosters = new Map([[winter, options.competitors || []], [spring, []]]);
  const configs = new Map([
    [winter, { name: winter, date: '2027-01-16', ringConfigX: 0, ringConfigY: 0 }],
    [spring, { name: spring, date: '2027-04-10', ringConfigX: 2, ringConfigY: 3 }]
  ]);
  const location = { protocol: 'http:', origin: 'http://localhost:3000', href: `http://localhost:3000/tournament-management/${options.search || ''}`, search: options.search || '' };
  let groups = options.groups || [];
  let rings = options.rings || [];
  let ringConfig = { letterCount: 1, numberCount: 2 };
  let dbExists = options.dbExists !== false;
  let failSnapshot = Boolean(options.failSnapshot);
  const requests = [];
  const confirmations = [];
  const errors = [];
  let pointerTarget = null;
  let clockOffset = 0;
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    Date: class extends Date {
      static now() { return Date.now() + clockOffset; }
    },
    URL,
    URLSearchParams,
    setTimeout: (callback, delay) => {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimeout(id) { timers.delete(id); },
    console: { warn: (...args) => errors.push(args), error: (...args) => errors.push(args) },
    window: {
      location,
      history: {
        replaceState: (_state, _title, url) => {
          location.href = String(url);
          location.search = new URL(url).search;
        }
      },
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
      createElement: () => element(),
      elementFromPoint: () => pointerTarget
    },
    fetch: async (url, init) => {
      const request = new URL(url);
      const name = request.searchParams.get('eventName');
      requests.push({ path: request.pathname, name, init });
      let data;
      switch (request.pathname) {
        case '/api/events/list': data = { events: Array.from(configs.keys()) }; break;
        case '/api/events/active':
          if (activeFailure) return { ok: false, json: async () => ({ error: 'Active event unavailable' }) };
          data = { activeEvent };
          break;
        case '/api/events/config':
          data = { eventConfig: configs.get(name), dbExists: name === winter ? dbExists : false };
          break;
        case '/api/events/create':
        case '/api/events/modify': {
          const body = JSON.parse(init.body);
          configs.set(body.eventName, body);
          data = { ok: true };
          break;
        }
        case '/api/competitors':
          if (options.waitForRoster) await options.waitForRoster;
          if (failSnapshot) return { ok: false, json: async () => ({ error: 'Database unavailable' }) };
          data = rosters.get(name);
          break;
        case '/api/groups':
          if (options.waitForGroups) await options.waitForGroups;
          data = { groups: options.groupsByEvent ? options.groupsByEvent[name] || [] : groups };
          break;
        case '/api/rings': {
          if (ringFailure) return { ok: false, json: async () => ({ error: 'Rings unavailable' }) };
          if (name !== activeEvent) return { ok: false, json: async () => ({ error: 'The active event changed. Refresh Ring Assignment before continuing.' }) };
          const assigned = new Set(rings.flatMap((ring) => [ring.groupDivisionNumber, ...(ring.queuedGroupDivisionNumbers || []), ...(ring.completedGroupDivisionNumbers || [])]).map(String));
          const eventGroups = options.groupsByEvent ? options.groupsByEvent[name] || [] : groups;
          data = { rings: JSON.parse(JSON.stringify(rings)), ringConfig, availableGroupDivisionNumbers: eventGroups.map((group) => String(group.groupDivisionNumber)).filter((id) => !assigned.has(id)) };
          break;
        }
        case '/api/rings/config': {
          const config = JSON.parse(init.body);
          ringConfig = config;
          rings = Array.from({ length: config.letterCount }, (_, index) =>
            Array.from({ length: config.numberCount }, (_, number) => ({
              ringId: `ring-${String.fromCharCode(97 + index)}-${number + 1}`,
              ringLabel: `${String.fromCharCode(65 + index)}${number + 1}`, queuedGroupDivisionNumbers: []
            }))).flat();
          data = { ok: true };
          break;
        }
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
        default: {
          const clear = request.pathname.match(/^\/api\/rings\/([^/]+)\/assistance\/clear$/);
          if (clear) {
            if (name !== activeEvent || options.failClear) return { ok: false, json: async () => ({ error: options.failClear ? 'Clear failed' : 'The active event changed' }) };
            const ring = rings.find((item) => item.ringId === clear[1]);
            const expected = JSON.parse(init.body).expectedAssistanceRequestedAt;
            if (expected !== (ring.assistanceRequestedAt || '')) return { ok: false, json: async () => ({ error: 'The assistance request changed' }) };
            ring.assistanceType = '';
            ring.assistanceRequestedAt = '';
            data = { ok: true };
            break;
          }
          const match = request.pathname.match(/^\/api\/rings\/([^/]+)\/(queue|reset)(?:\/([^/]+))?$/);
          if (!match) throw new Error(`Unexpected request ${url}`);
          if (name !== activeEvent || options.failRingUpdate) return { ok: false, json: async () => ({ error: options.failRingUpdate ? 'Queue failed' : 'The active event changed' }) };
          const ring = rings.find((item) => item.ringId === match[1]);
          if (match[2] === 'reset') {
            ring.groupDivisionNumber = '';
            ring.queuedGroupDivisionNumbers = [];
          } else if (init.method === 'DELETE') {
            ring.queuedGroupDivisionNumbers = (ring.queuedGroupDivisionNumbers || []).filter((id) => String(id) !== match[3]);
          } else {
            ring.queuedGroupDivisionNumbers = [...(ring.queuedGroupDivisionNumbers || []), JSON.parse(init.body).groupDivisionNumber];
          }
          data = { ok: true };
        }
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
    openDayOf: (index = 3) => dispatch(nav[index]),
    ringAction: async (id, dataset, extra = {}) => {
      const button = { ...element(), dataset, hasAttribute: (name) =>
        name === 'data-ra-reset' && Boolean(extra.reset) || name === 'data-ht-close' && Boolean(extra.close) || name === 'data-ht-clear' && Boolean(extra.clear) };
      await elements.get(id).handlers[extra.event || 'click']({
        target: { closest: () => button },
        preventDefault() {},
        dataTransfer: { getData: () => extra.divisionId || '' }
      });
      await settle();
    },
    pointerAction: async (type, { x = 0, y = 0, ringId = '', divisionId = '20' } = {}) => {
      pointerTarget = ringId ? { closest: () => ({ dataset: { raRing: ringId } }) } : null;
      const card = { ...element(), dataset: { raDivision: divisionId }, setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} };
      await elements.get('raDivisions').handlers[type]({
        target: { closest: () => card }, pointerType: 'mouse', button: 0,
        pointerId: 1, clientX: x, clientY: y, preventDefault() {}
      });
      await settle();
    },
    refreshTimer: async () => {
      const timer = [...timers.values()].find((item) => item.delay === 10000);
      if (timer) await timer.callback();
      await settle();
    },
    setActiveEvent: (name) => { activeEvent = name; },
    failActiveEvent: () => { activeFailure = true; },
    failRings: (fail = true) => { ringFailure = fail; },
    advanceTime: async (milliseconds) => {
      clockOffset += milliseconds;
      const tick = [...timers.values()].find((timer) => timer.delay === 1000);
      if (tick) tick.callback();
      await settle();
    },
    refreshDayOf: async () => {
      // An open day-of view refreshes when it is selected again.
      nav[3].setAttribute('aria-disabled', 'false');
      await dispatch(nav[3]);
    },
    location,
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
  assert.equal(page.element('bannerEventStatus').textContent, 'Not active');
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
  assert.equal(page.element('bannerEventStatus').textContent, 'Unsaved changes');
  await page.click('gbSaveBtn');
  assert.equal(page.element('gbSaveBtn').classList.contains('primary'), false);
  assert.equal(page.element('gbDoneBtn').hidden, false);
  assert.equal(page.element('bannerEventStatus').textContent, 'Not active');
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

test('workflow URLs open the requested view and navigation keeps the URL in sync', async () => {
  for (const view of ['event-setup', 'import', 'groups']) {
    const page = await loadPage({ search: `?view=${view}`, competitors: [savedCompetitor] });
    await settle();
    assert.equal(page.element(view === 'import' ? 'importView' : view === 'groups' ? 'groupsView' : 'eventSetupView').hidden, false);
    if (view === 'import') assertNextDefault(page);
    await page.openGroups();
    assert.equal(new URLSearchParams(page.location.search).get('view'), 'groups');
    await page.openImport();
    assert.equal(new URLSearchParams(page.location.search).get('view'), 'import');
  }
  const fallback = await loadPage({ search: '?view=unknown' });
  assert.equal(fallback.element('workspaceTitle').textContent, 'Event Setup');
});

test('saved-only compatibility URL bypasses browser draft without deleting it', async () => {
  const draft = { eventName: winter, groups: [{ id: 'draft', competitors: [] }] };
  const page = await loadPage({
    search: '?view=groups&source=saved',
    draft,
    competitors: [savedCompetitor],
    groups: [{ id: '20', competitors: [savedCompetitor] }]
  });
  await settle();
  assert.equal(page.element('gbSaveBtn').classList.contains('primary'), false);
  assert.equal(page.element('gbDoneBtn').hidden, false);
  assert.equal(page.storage.has(draftKey), true);
  page.element('gbMaxSize').value = '8';
  await page.input('gbMaxSize', 'change');
  assert.equal(new URLSearchParams(page.location.search).has('source'), false);
  assert.equal(page.element('bannerEventStatus').textContent, 'Unsaved changes');
  await page.openImport();
  assert.equal(new URLSearchParams(page.location.search).has('source'), false);
});

test('banner follows the selected event and its configured date, independently of active event', async () => {
  const page = await loadPage({ activeEvent: spring });
  assert.equal(page.element('bannerEventName').textContent, winter);
  assert.equal(page.element('bannerEventDate').textContent, '2027-01-16');
  assert.equal(page.element('bannerEventStatus').textContent, 'Not active');
  assert.equal(page.element('activeEventChip').textContent, spring);
  await page.select(spring);
  assert.equal(page.element('bannerEventName').textContent, spring);
  assert.equal(page.element('bannerEventDate').textContent, '2027-04-10');
  assert.equal(page.element('bannerEventStatus').textContent, 'Active');
  await page.click('resetEventBtn');
  assert.equal(page.element('bannerEventName').textContent, 'None selected');
  assert.equal(page.element('bannerEventDate').textContent, 'Not set');
  assert.equal(page.element('bannerEventStatus').textContent, 'No event selected');
});

test('day-of banner uses active event and date across all day-of sections, not selected drafts', async () => {
  const page = await loadPage({
    activeEvent: spring,
    draft: { eventName: winter, groups: [] }
  });
  assert.equal(page.element('bannerEventStatus').textContent, 'Unsaved changes');
  for (let index = 3; index < 8; index++) {
    await page.openDayOf(index);
    assert.equal(page.element('bannerEventLabel').textContent, 'Active Event:');
    assert.equal(page.element('bannerEventName').textContent, spring);
    assert.equal(page.element('bannerEventDate').textContent, '2027-04-10');
    assert.equal(page.element('bannerEventStatus').textContent, 'Active');
    assert.equal(page.element('bannerMetadata').getAttribute('aria-label'), 'Active event metadata');
  }
  await page.openImport();
  assert.equal(page.element('bannerEventLabel').textContent, 'Selected Event:');
  assert.equal(page.element('bannerEventName').textContent, winter);
  assert.equal(page.element('bannerEventDate').textContent, '2027-01-16');
  assert.equal(page.element('bannerEventStatus').textContent, 'Unsaved changes');
});

test('day-of context refreshes and never falls back to selection when active event disappears or fails', async () => {
  const page = await loadPage({ activeEvent: spring });
  await page.openDayOf();
  page.setActiveEvent('');
  await page.openDayOf();
  assert.equal(page.element('bannerEventName').textContent, 'No active event');
  assert.equal(page.element('bannerEventDate').textContent, 'Not set');
  assert.match(page.element('placeholderMessage').textContent, /No active event/);
  page.setActiveEvent(spring);
  await page.refreshDayOf();
  assert.equal(page.element('bannerEventName').textContent, spring);
  page.failActiveEvent();
  await page.openDayOf();
  assert.equal(page.element('bannerEventStatus').textContent, 'Unavailable');
  assert.equal(page.element('bannerEventDate').textContent, 'Not set');
  assert.match(page.element('placeholderMessage').textContent, /Unable to load active event/);
  const noActive = await loadPage();
  await noActive.openDayOf();
  assert.equal(noActive.element('workspaceTitle').textContent, 'Event Setup');
});

test('integrated event metadata sends numeric dimensions, displays zero and blocks invalid input', async () => {
  const page = await loadPage();
  await page.click('modifyEventBtn');
  assert.equal(page.element('ringConfigXInput').value, '0');
  page.element('ringConfigXInput').value = '2';
  page.element('ringConfigYInput').value = '3';
  await page.input('ringConfigXInput', 'input');
  assert.equal(page.element('bannerEventStatus').textContent, 'Unsaved changes');
  await page.click('saveMetadataBtn');
  let post = page.requests.filter((request) => request.init).at(-1);
  assert.equal(post.path, '/api/events/modify');
  assert.equal(JSON.parse(post.init.body).ringConfigX, 2);
  assert.equal(JSON.parse(post.init.body).ringConfigY, 3);
  assert.equal(page.element('metadataPanel').hidden, true);
  assert.equal(page.element('ringConfigXInput').value, '');
  assert.equal(page.element('bannerEventStatus').textContent, 'Not active');

  await page.select('__new__');
  page.element('eventNameInput').value = 'New Event';
  await page.input('eventNameInput', 'input');
  await page.click('createEventBtn');
  page.element('ringConfigXInput').value = '4';
  page.element('ringConfigYInput').value = '5';
  await page.click('saveMetadataBtn');
  post = page.requests.filter((request) => request.init).at(-1);
  assert.equal(post.path, '/api/events/create');
  assert.equal(JSON.parse(post.init.body).ringConfigX, 4);
  assert.equal(JSON.parse(post.init.body).ringConfigY, 5);
  assert.equal(page.element('bannerEventName').textContent, 'New Event');
  assert.equal(page.element('bannerEventDate').textContent, 'Not set');

  await page.click('modifyEventBtn');
  const beforeInvalidSave = page.requests.filter((request) => request.init).length;
  page.element('ringConfigXInput').checkValidity = () => false;
  await page.click('saveMetadataBtn');
  assert.equal(page.requests.filter((request) => request.init).length, beforeInvalidSave);
  assert.match(page.element('notice').textContent, /whole numbers/);
});

const ringA1 = { ringId: 'ring-a-1', ringLabel: 'A1', queuedGroupDivisionNumbers: [] };
const division20 = { groupDivisionNumber: 20, name: 'Active division', competitors: [savedCompetitor] };

test('ring details use plain division names and explicit competitor buttons', async () => {
  const page = await loadPage({
    activeEvent: winter,
    groups: [division20, { ...division20, groupDivisionNumber: 22, name: 'Queued division' }],
    rings: [{ ...ringA1, groupDivisionNumber: '20', queuedGroupDivisionNumbers: ['22'] }]
  });
  await page.openDayOf();
  await page.ringAction('raRings', { raRing: 'ring-a-1' });
  let markup = page.element('ringAssignmentDetails').innerHTML;
  assert.match(markup, /class="ra-division-label">Division 20 - Active division<\/div>/);
  assert.match(markup, /class="ra-division-label">Division 22 - Queued division<\/div>/);
  assert.match(markup, /data-ra-group="20" aria-expanded="false"[^>]*>Show competitors<\/button>/);
  assert.match(markup, /data-ra-group="22"[^>]*>Show competitors<\/button>/);
  assert.doesNotMatch(markup, /ra-link/);
  await page.ringAction('ringAssignmentDetails', { raGroup: '22' });
  markup = page.element('ringAssignmentDetails').innerHTML;
  assert.match(markup, /data-ra-group="22" aria-expanded="true"[^>]*>Hide competitors<\/button>/);
  assert.match(markup, /data-ra-group="20"[^>]*>Show competitors<\/button>/);
  assert.match(markup, /Saved Competitor/);
  await page.ringAction('ringAssignmentDetails', { raGroup: '22' });
  markup = page.element('ringAssignmentDetails').innerHTML;
  assert.match(markup, /data-ra-group="22" aria-expanded="false"[^>]*>Show competitors<\/button>/);
  assert.doesNotMatch(markup, /Saved Competitor|Showing competitors|class="danger"/);
  assert.match(markup, /class="ra-ring-maintenance"/);
});

test('ring tiles separate connection from assignment and retain label order across refreshes', async () => {
  const connected = { tabletLabel: 'Test tablet', lastHeartbeatAt: new Date().toISOString() };
  const rings = [
    { ...ringA1, ringId: 'ring-b-1', ringLabel: 'B1', ...connected, groupDivisionNumber: '20' },
    { ...ringA1, ringId: 'ring-a-2', ringLabel: 'A2', ...connected },
    { ...ringA1, queuedGroupDivisionNumbers: ['22'] },
    { ...ringA1, ringId: 'ring-a-3', ringLabel: 'A3', ...connected, queuedGroupDivisionNumbers: ['24'] },
    { ...ringA1, ringId: 'ring-b-2', ringLabel: 'B2', ...connected, lastHeartbeatAt: new Date(Date.now() - 91000).toISOString(), groupDivisionNumber: '26' },
    { ...ringA1, ringId: 'ring-b-3', ringLabel: 'B3', ...connected, lastHeartbeatAt: '' },
    { ...ringA1, ringId: 'ring-b-4', ringLabel: 'B4', ...connected, lastHeartbeatAt: 'invalid' }
  ];
  const page = await loadPage({ activeEvent: winter, rings });
  await page.openDayOf();
  const cards = () => page.element('raRings').innerHTML.match(/<button[\s\S]*?<\/button>/g);
  const byLabel = (label) => cards().find((card) => card.includes(`<strong>Ring ${label}</strong>`));
  const order = () => cards().map((card) => card.match(/data-ra-ring="([^"]+)"/)[1]);
  const expectedOrder = ['ring-a-1', 'ring-a-2', 'ring-a-3', 'ring-b-1', 'ring-b-2', 'ring-b-3', 'ring-b-4'];
  assert.deepEqual(order(), expectedOrder);
  assert.match(byLabel('A1'), /ra-ring no-tablet/);
  assert.match(byLabel('A1'), />No tablet<\/span>/);
  assert.match(byLabel('A1'), />Queued<\/span>/);
  assert.match(byLabel('A2'), /ra-ring connected/);
  assert.match(byLabel('A2'), />Connected<\/span>/);
  assert.match(byLabel('A2'), />Available<\/span>/);
  assert.match(byLabel('A3'), />Connected<\/span>/);
  assert.match(byLabel('A3'), />Queued<\/span>/);
  assert.match(byLabel('B1'), />Running division 20<\/span>/);
  for (const label of ['B2', 'B3', 'B4']) assert.match(byLabel(label), /ra-ring disconnected/);
  assert.match(byLabel('B2'), />Running division 26<\/span>/);
  await page.ringAction('raRings', { raRing: 'ring-a-2' });
  assert.match(page.element('ringAssignmentDetails').innerHTML, /<dt>State<\/dt><dd>Connected<\/dd>/);
  rings[1].lastHeartbeatAt = '2020-01-01';
  rings[2].lastHeartbeatAt = new Date().toISOString();
  rings[2].tabletLabel = 'New connection';
  await page.click('raRefreshBtn');
  assert.deepEqual(order(), expectedOrder);
  assert.match(byLabel('A2'), /ra-ring disconnected/);
  assert.match(byLabel('A2'), /aria-pressed="true"/);
  assert.match(byLabel('A1'), /ra-ring connected/);
});

test('available division tiles show a compact summary without repeated rank and age', async () => {
  const page = await loadPage({
    activeEvent: winter,
    groups: [{ ...division20, name: 'Male G1 - Ages 12-14' }],
    rings: [{ ...ringA1 }]
  });
  await page.openDayOf();
  const markup = page.element('raDivisions').innerHTML;
  assert.match(markup, /class="ra-card ra-division" draggable="true"/);
  assert.match(markup, /<strong>Division 20<\/strong>/);
  assert.match(markup, /<span class="ra-meta">1 competitor<\/span>/);
  assert.match(markup, /class="ra-meta ra-division-description">Male G1 - Ages 12-14<\/span>/);
  const visibleText = markup.replace(/\s(?:title|aria-label)="[^"]*"/g, '').replace(/<[^>]*>/g, '');
  assert.equal(visibleText.match(/G1/g).length, 1);
  assert.equal(visibleText.match(/Ages 12-14/g).length, 1);
  assert.doesNotMatch(markup, /1 competitors/);
});

test('mouse pointer dragging pauses refresh, queues on release and suppresses the follow-up click', async () => {
  const page = await loadPage({ activeEvent: winter, groups: [division20], rings: [{ ...ringA1 }] });
  await page.openDayOf();
  const initialLoads = page.requests.filter((request) => request.path === '/api/groups').length;
  await page.pointerAction('pointerdown');
  await page.pointerAction('pointermove', { x: 100, y: 40, ringId: 'ring-a-1' });
  await page.refreshTimer();
  await page.click('raRefreshBtn');
  assert.equal(page.requests.filter((request) => request.path === '/api/groups').length, initialLoads);
  await page.pointerAction('pointerup', { x: 100, y: 40, ringId: 'ring-a-1' });
  assert.equal(page.requests.filter((request) => request.path.endsWith('/queue')).length, 1);
  await page.ringAction('raDivisions', { raDivision: '20' });
  assert.equal(page.requests.filter((request) => request.path.endsWith('/queue')).length, 1);
  assert.match(page.element('ringAssignmentDetails').innerHTML, /Saved Competitor/);
});

test('cancelled or off-ring mouse drag does not assign and refresh resumes', async () => {
  for (const action of ['pointercancel', 'lostpointercapture', 'pointerup']) {
    const page = await loadPage({ activeEvent: winter, groups: [division20], rings: [{ ...ringA1 }] });
    await page.openDayOf();
    await page.pointerAction('pointerdown');
    await page.pointerAction('pointermove', { x: 100, y: 40 });
    await page.pointerAction(action, { x: 100, y: 40 });
    assert.equal(page.requests.some((request) => request.path.endsWith('/queue')), false);
    const initialLoads = page.requests.filter((request) => request.path === '/api/groups').length;
    await page.refreshTimer();
    assert.ok(page.requests.filter((request) => request.path === '/api/groups').length > initialLoads);
  }
});

test('integrated ring assignment loads active-event divisions, not selected-event groups or drafts', async () => {
  const page = await loadPage({
    activeEvent: spring,
    groupsByEvent: { [winter]: [{ ...division20, name: 'Wrong event' }], [spring]: [division20] },
    draft: { eventName: winter, groups: [{ ...division20, name: 'Unsaved draft' }] },
    rings: [ringA1, { ringId: 'ring-b-2', ringLabel: 'B2', tabletLabel: 'Offline tablet', lastHeartbeatAt: '2020-01-01', queuedGroupDivisionNumbers: [] }]
  });
  await page.openDayOf();
  assert.equal(page.element('ringAssignmentView').hidden, false);
  assert.equal(page.element('placeholderView').hidden, true);
  assert.equal(new URLSearchParams(page.location.search).get('view'), 'ring-assignment');
  assert.match(page.element('raDivisions').innerHTML, /Active division/);
  assert.doesNotMatch(page.element('raDivisions').innerHTML, /Wrong event|Unsaved draft/);
  assert.match(page.element('raRings').innerHTML, /Ring A1/);
  assert.match(page.element('raRings').innerHTML, /Ring B2/);
  assert.match(page.element('raRings').innerHTML, /Disconnected/);
  assert.equal(page.element('detailsPanel').hidden, true);
  assert.equal(page.requests.filter((request) => request.path === '/api/groups').at(-1).name, spring);
  const groupIndex = page.requests.findIndex((request) => request.path === '/api/groups');
  const ringIndex = page.requests.findIndex((request) => request.path === '/api/rings');
  assert.ok(groupIndex < ringIndex, 'prime saved divisions before reading availability');
  await page.ringAction('raRings', { raRing: 'ring-b-2' });
  assert.equal(page.element('detailsPanel').hidden, false);
  assert.equal(page.element('detailsTitle').textContent, 'Ring Details');
  assert.match(page.element('ringAssignmentDetails').innerHTML, /Offline tablet/);
  assert.doesNotMatch(page.element('raRings').innerHTML, /Offline tablet|Reset ring/);
  await page.openImport();
  assert.equal(page.element('ringAssignmentView').hidden, true);
  assert.equal(page.element('ringAssignmentDetails').hidden, true);
});

test('ring assignment queues by click and drop, displays members, removes queue entries and confirms reset', async () => {
  const page = await loadPage({ activeEvent: winter, groups: [division20], rings: [{ ...ringA1 }], confirm: true });
  await page.openDayOf();
  await page.ringAction('raDivisions', { raDivision: '20' });
  assert.match(page.element('raNotice').textContent, /Select a ring/);
  assert.equal(page.requests.some((request) => request.init && request.path.includes('/queue')), false);
  await page.ringAction('raRings', { raRing: 'ring-a-1' });
  await page.ringAction('raDivisions', { raDivision: '20' });
  const queued = page.requests.find((request) => request.path.endsWith('/queue'));
  assert.equal(queued.name, winter);
  assert.deepEqual(JSON.parse(queued.init.body), { groupDivisionNumber: '20' });
  assert.doesNotMatch(page.element('raDivisions').innerHTML, /data-ra-division="20"/);
  assert.match(page.element('raRings').innerHTML, /No tablet/);
  assert.match(page.element('raRings').innerHTML, /Queued/);
  assert.match(page.element('ringAssignmentDetails').innerHTML, /Saved Competitor/);
  await page.ringAction('ringAssignmentDetails', { raRemove: '20' });
  assert.match(page.element('raDivisions').innerHTML, /data-ra-division="20"/);
  await page.ringAction('raRings', { raRing: 'ring-a-1' }, { event: 'drop', divisionId: '20' });
  assert.doesNotMatch(page.element('raDivisions').innerHTML, /data-ra-division="20"/);
  await page.ringAction('ringAssignmentDetails', {}, { reset: true });
  assert.match(page.confirmations.at(-1), /Reset this ring/);
  assert.match(page.element('raDivisions').innerHTML, /data-ra-division="20"/);
  assert.match(page.element('raNotice').textContent, /Ring reset/);
});

test('ring assignment direct link, search, empty state, errors and event switching stay scoped', async () => {
  const page = await loadPage({
    search: '?view=ring-assignment', activeEvent: winter, rings: [{ ...ringA1 }],
    groupsByEvent: { [winter]: [division20], [spring]: [] }
  });
  await settle();
  assert.equal(page.element('ringAssignmentView').hidden, false);
  page.element('raSearch').value = 'no-match';
  await page.input('raSearch', 'input');
  assert.doesNotMatch(page.element('raDivisions').innerHTML, /data-ra-division/);
  page.element('raSearch').value = '';
  await page.input('raSearch', 'input');
  await page.ringAction('raRings', { raRing: 'ring-a-1' });
  page.setActiveEvent(spring);
  await page.click('raRefreshBtn');
  assert.equal(page.element('detailsPanel').hidden, true);
  assert.equal(page.element('raEvent').textContent, spring);
  assert.match(page.element('raDivisions').innerHTML, /No saved divisions/);
  page.setActiveEvent('');
  await page.click('raRefreshBtn');
  assert.match(page.element('raNotice').textContent, /No active event/);
  assert.doesNotMatch(page.element('raRings').innerHTML, /data-ra-ring/);
  const failed = await loadPage({ activeEvent: winter, failRings: true });
  await failed.openDayOf();
  assert.match(failed.element('raNotice').textContent, /Rings unavailable/);
  assert.equal(failed.element('detailsPanel').hidden, true);
});

test('ring updates reject changed active context and display server errors without reporting success', async () => {
  const page = await loadPage({ activeEvent: winter, groups: [division20], rings: [{ ...ringA1 }] });
  await page.openDayOf();
  await page.ringAction('raRings', { raRing: 'ring-a-1' });
  page.setActiveEvent(spring);
  await page.ringAction('raDivisions', { raDivision: '20' });
  assert.match(page.element('raNotice').textContent, /Update failed: The active event changed/);
  const failed = await loadPage({ activeEvent: winter, groups: [division20], rings: [{ ...ringA1 }], failRingUpdate: true });
  await failed.openDayOf();
  await failed.ringAction('raRings', { raRing: 'ring-a-1' });
  await failed.ringAction('raDivisions', { raDivision: '20' });
  assert.match(failed.element('raNotice').textContent, /Update failed: Queue failed/);
  assert.match(failed.element('raDivisions').innerHTML, /data-ra-division="20"/);
});

test('saved ring layout is explicit and confirmed instead of resetting assignments on load', async () => {
  const page = await loadPage({ activeEvent: spring, rings: [{ ...ringA1 }], confirm: true });
  await page.openDayOf();
  assert.equal(page.element('raLayoutBtn').hidden, false);
  assert.equal(page.requests.some((request) => request.path === '/api/rings/config'), false);
  await page.click('raLayoutBtn');
  assert.match(page.confirmations.at(-1), /resets ALL ring assignments/);
  const apply = page.requests.find((request) => request.path === '/api/rings/config');
  assert.equal(apply.name, spring);
  assert.deepEqual(JSON.parse(apply.init.body), { letterCount: 2, numberCount: 3 });
  assert.equal(page.element('raRingCount').textContent, '6 rings');
  assert.equal(page.element('raLayoutBtn').hidden, true);
});

test('Head Table integrates active-event totals, preserves disconnected divisions and has no assignment/reset controls', async () => {
  const groups = Array.from({ length: 5 }, (_, index) => ({ ...division20, groupDivisionNumber: 20 + index, name: `Active group ${index}` }));
  const page = await loadPage({
    activeEvent: spring, selectedEvent: winter,
    groupsByEvent: { [spring]: groups, [winter]: [{ ...division20, name: 'Wrong event' }] },
    rings: [
      { ...ringA1, tabletLabel: 'Offline tablet', lastHeartbeatAt: '2020-01-01', groupDivisionNumber: '20', queuedGroupDivisionNumbers: ['21'], completedGroupDivisionNumbers: ['22'] },
      { ...ringA1, ringId: 'ring-a-2', ringLabel: 'A2', tabletLabel: 'Online', lastHeartbeatAt: new Date().toISOString(), completedGroupDivisionNumbers: ['22'] }
    ]
  });
  await page.openDayOf(4);
  assert.equal(page.element('headTableView').hidden, false);
  assert.equal(page.element('placeholderView').hidden, true);
  assert.equal(page.element('workspaceTitle').textContent, 'Head Table');
  assert.equal(page.element('bannerEventName').textContent, spring);
  assert.equal(new URLSearchParams(page.location.search).get('view'), 'head-table');
  const summary = page.element('htSummary').innerHTML;
  for (const [label, count] of [['Completed', 1], ['Active', 1], ['Queued', 1], ['Available', 2], ['Disconnected', 1], ['Assistance', 0]]) {
    assert.ok(summary.includes(`${label}: <strong>${count}</strong>`), `${label} count`);
  }
  const primary = summary.match(/<div class="ht-primary-counts"[^>]*>([\s\S]*?)<\/div>/)[1];
  assert.deepEqual([...primary.matchAll(/>(Available|Active|Disconnected|Assistance):/g)].map((match) => match[1]),
    ['Available', 'Active', 'Disconnected', 'Assistance']);
  assert.match(primary, /class="chip warning">Disconnected: <strong>1/);
  assert.match(primary, /class="chip">Assistance: <strong>0/);
  assert.doesNotMatch(primary, /Queued:|Completed:|<button/);
  assert.match(summary, /Overall progress: <strong>1 of 5<\/strong> divisions completed/);
  assert.doesNotMatch(summary, /Saved divisions|Connected rings/);
  assert.match(page.element('htRings').innerHTML, /Disconnected|active division preserved/);
  assert.doesNotMatch(page.element('htRings').innerHTML, /Wrong event/);
  assert.equal(page.requests.filter((request) => request.path === '/api/groups').at(-1).name, spring);
  await page.ringAction('htRings', { htRing: 'ring-a-1' });
  assert.equal(page.element('detailsPanel').hidden, false);
  assert.equal(page.element('headTableDetails').hidden, false);
  assert.match(page.element('headTableDetails').innerHTML, /Offline tablet/);
  assert.doesNotMatch(page.element('headTableDetails').innerHTML, /data-ra-remove|data-ra-reset|data-ra-division|data-ht-clear/);
  await page.click('htAssignmentBtn');
  assert.equal(page.element('ringAssignmentView').hidden, false);
  assert.equal(page.element('headTableView').hidden, true);
  assert.equal(page.element('headTableDetails').hidden, true);
});

test('Head Table priority ranks attention, freezes selected positions and supports fixed ring order', async () => {
  const started = new Date(Date.now() - 60000).toISOString();
  const online = { tabletLabel: 'Connected tablet', lastHeartbeatAt: new Date().toISOString() };
  const rings = [
    { ...ringA1 },
    { ...ringA1, ringId: 'ring-a-2', ringLabel: 'A2', ...online },
    { ...ringA1, ringId: 'ring-a-3', ringLabel: 'A3', ...online, assistanceType: 'general', assistanceRequestedAt: started },
    { ...ringA1, ringId: 'ring-a-4', ringLabel: 'A4', ...online, assistanceType: 'medical', assistanceRequestedAt: started },
    { ...ringA1, ringId: 'ring-a-5', ringLabel: 'A5', groupDivisionNumber: '20', tabletLabel: 'Offline', lastHeartbeatAt: '2020-01-01' },
    { ...ringA1, ringId: 'ring-a-6', ringLabel: 'A6', ...online, groupDivisionNumber: '22', ringElapsed: '20:00', ringEstimated: '10:00', ringPacePercent: 100, assignmentStartedAt: started }
  ];
  const page = await loadPage({ activeEvent: winter, rings });
  await page.openDayOf(4);
  const order = () => [...page.element('htRings').innerHTML.matchAll(/data-ht-ring="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(order(), ['ring-a-4', 'ring-a-3', 'ring-a-5', 'ring-a-2', 'ring-a-6', 'ring-a-1']);
  assert.match(page.element('htRings').innerHTML, /medical assistance - waiting/);
  await page.ringAction('htRings', { htRing: 'ring-a-6' });
  rings[0].assistanceType = 'medical';
  rings[0].assistanceRequestedAt = started;
  await page.click('htRefreshBtn');
  assert.equal(order().at(-1), 'ring-a-1', 'selected ring freezes positions');
  await page.ringAction('headTableDetails', {}, { close: true });
  assert.equal(order()[0], 'ring-a-1', 'priority resumes on close');
  page.element('htOrder').value = 'ring';
  await page.input('htOrder', 'change');
  assert.deepEqual(order(), rings.map((ring) => ring.ringId));
  rings[5].assistanceType = 'medical';
  await page.click('htRefreshBtn');
  assert.deepEqual(order(), rings.map((ring) => ring.ringId));
});

test('Head Table uses reported phases, timing, history and sparring details and toggles competitors', async () => {
  const now = new Date().toISOString();
  const page = await loadPage({
    activeEvent: winter, search: '?view=head-table', groups: [division20],
    rings: [{ ...ringA1, groupDivisionNumber: '20', currentPhaseName: 'sparring', assignmentStartedAt: now,
      ringElapsed: '12:00', ringEstimated: '10:00', ringPacePercent: 20,
      currentPhaseElapsed: '2:00', currentPhaseEstimated: '4:00', currentPhaseCompletedCount: 2, currentPhaseTotalCount: 4,
      checkInCount: 8, checkInTotal: 9, sparringActualBoutCount: 4, sparringCompletedBoutCount: 2, sparringByeCount: 1,
      phaseHistory: [{ name: 'setup', startTime: now, endTime: now, elapsed: '3:00', estimated: '4:00' }],
      phasePlan: { phases: [{ key: 'setup', label: 'Setup', state: 'complete' }, { key: 'sparring', label: 'Sparring', state: 'active', progress: 50 }, { key: 'awards', label: 'Awards', state: 'upcoming', progress: 0 }] }
    }]
  });
  await settle();
  assert.equal(page.element('headTableView').hidden, false);
  assert.match(page.element('htRings').innerHTML, /ht-segment complete" style="--ht-fill: 100%"/);
  assert.match(page.element('htRings').innerHTML, /ht-segment active" style="--ht-fill: 50%"/);
  assert.match(page.element('htRings').innerHTML, /ht-segment upcoming" style="--ht-fill: 0%"/);
  assert.match(page.element('htRings').innerHTML, /aria-valuenow="50"/);
  assert.match(page.element('htRings').innerHTML, /Setup: complete, 100%; Sparring: active, 50%; Awards: upcoming, 0%/);
  assert.equal((page.element('htRings').innerHTML.match(/class="ht-phase-pill"/g) || []).length, 1);
  assert.doesNotMatch(page.element('htRings').innerHTML, /<progress|Elapsed 12:00|ht-phases/);
  await page.ringAction('htRings', { htRing: 'ring-a-1' });
  let details = page.element('headTableDetails').innerHTML;
  assert.match(details, /Running late/);
  for (const text of ['Sparring', 'Bouts', '2 / 4', 'Byes', 'Phase history (1)', '12:00', '10:00', '8 / 9']) assert.ok(details.includes(text), text);
  assert.match(details, /Show competitors/);
  await page.ringAction('headTableDetails', { htGroup: '20' });
  assert.match(page.element('headTableDetails').innerHTML, /Saved Competitor/);
  await page.ringAction('headTableDetails', { htGroup: '20' });
  assert.doesNotMatch(page.element('headTableDetails').innerHTML, /Saved Competitor/);
});

test('Head Table does not fabricate estimates, pace or progress when timing is missing or invalid', async () => {
  const page = await loadPage({
    activeEvent: winter,
    rings: [
      { ...ringA1, groupDivisionNumber: '20', ringPacePercent: 0 },
      { ...ringA1, ringId: 'ring-a-2', ringLabel: 'A2', groupDivisionNumber: '22', ringEstimated: '0:00', ringElapsed: '5:00', ringPacePercent: 0 },
      { ...ringA1, ringId: 'ring-a-3', ringLabel: 'A3', groupDivisionNumber: '24', ringEstimated: '10:00', ringElapsed: '5:00', ringPacePercent: 0 }
    ]
  });
  await page.openDayOf(4);
  assert.match(page.element('htRings').innerHTML, /Phase progress unavailable/);
  assert.doesNotMatch(page.element('htRings').innerHTML, /Within estimate|Ahead of estimate|<progress/);
  await page.ringAction('htRings', { htRing: 'ring-a-1' });
  assert.match(page.element('headTableDetails').innerHTML, /Estimate unavailable/);
  assert.match(page.element('headTableDetails').innerHTML, /Progress unavailable/);
  await page.ringAction('htRings', { htRing: 'ring-a-3' });
  assert.match(page.element('headTableDetails').innerHTML, /Timing unavailable/);
});

test('Head Table segmented pill follows reported applicable phases and updates without inventing idle progress', async () => {
  const ring = { ...ringA1, groupDivisionNumber: '20', phasePlan: { phases: [
    { key: 'setup', label: 'Setup', state: 'active', progress: 25 },
    { key: 'hyungs', label: 'Hyungs', state: 'upcoming', progress: 0 },
    { key: 'awards', label: 'Awards', state: 'upcoming', progress: 0 }
  ] } };
  const page = await loadPage({ activeEvent: winter, rings: [ring] });
  await page.openDayOf(4);
  assert.match(page.element('htRings').innerHTML, /--ht-fill: 25%/);
  assert.doesNotMatch(page.element('htRings').innerHTML, /Weapons|Sparring/);
  ring.phasePlan.phases[0] = { key: 'setup', label: 'Setup', state: 'complete', progress: 100 };
  ring.phasePlan.phases[1] = { key: 'hyungs', label: 'Hyungs', state: 'active', progress: 75 };
  await page.click('htRefreshBtn');
  assert.match(page.element('htRings').innerHTML, /ht-segment active" style="--ht-fill: 75%"/);
  ring.phasePlan.phases[1].progress = null;
  await page.click('htRefreshBtn');
  assert.match(page.element('htRings').innerHTML, /Hyungs: active, progress unavailable/);
  assert.doesNotMatch(page.element('htRings').innerHTML, /aria-valuenow/);
  ring.groupDivisionNumber = '';
  await page.click('htRefreshBtn');
  assert.match(page.element('htRings').innerHTML, /No current division/);
  assert.doesNotMatch(page.element('htRings').innerHTML, /role="progressbar"|ht-segment active|Hyungs/);
});

test('Head Table previews only the next queued division with unfilled phase segments', async () => {
  const ring = { ...ringA1, queuedGroupDivisionNumbers: ['20', '22'], queuedPhasePlan: {
    groupDivisionNumber: '20', phases: [
      { key: 'setup', label: 'Setup', state: 'complete', progress: 100 },
      { key: 'hyungs', label: 'Hyungs', state: 'active', progress: 50 },
      { key: 'sparring', label: 'Sparring' },
      { key: 'awards', label: 'Awards' }
    ]
  } };
  const page = await loadPage({ activeEvent: winter, rings: [ring] });
  await page.openDayOf(4);
  const overview = page.element('htRings').innerHTML;
  assert.match(overview, /Division 20.*queued, not started/);
  assert.equal((overview.match(/ht-segment upcoming" style="--ht-fill: 0%"/g) || []).length, 4);
  assert.doesNotMatch(overview, /ht-segment active|ht-segment complete|Weapons/);
  await page.ringAction('htRings', { htRing: 'ring-a-1' });
  assert.match(page.element('headTableDetails').innerHTML, /Next phase - not started/);
  assert.match(page.element('headTableDetails').innerHTML, /<h3>Current phase<\/h3>/);
  assert.doesNotMatch(page.element('headTableDetails').innerHTML, /<h3>Current division<\/h3>|Next division - not started/);
  ring.queuedGroupDivisionNumbers = ['22'];
  await page.click('htRefreshBtn');
  assert.doesNotMatch(page.element('htRings').innerHTML, /role="progressbar"/);
  ring.queuedGroupDivisionNumbers = [];
  await page.click('htRefreshBtn');
  assert.match(page.element('htRings').innerHTML, /No current division/);
});

test('Head Table stale data is explicit, recovers, and never falls back to selected event', async () => {
  const page = await loadPage({
    activeEvent: spring, groupsByEvent: { [spring]: [division20], [winter]: [] },
    rings: [{ ...ringA1, groupDivisionNumber: '20' }]
  });
  await page.openDayOf(4);
  assert.match(page.element('htFreshness').textContent, /Last successful refresh/);
  page.failRings();
  await page.click('htRefreshBtn');
  assert.match(page.element('htNotice').textContent, /Rings unavailable/);
  assert.match(page.element('htFreshness').textContent, /STALE DATA/);
  assert.match(page.element('htRings').innerHTML, /Division 20/);
  page.failRings(false);
  await page.click('htRefreshBtn');
  assert.doesNotMatch(page.element('htFreshness').textContent, /STALE DATA/);
  await page.ringAction('htRings', { htRing: 'ring-a-1' });
  page.setActiveEvent(winter);
  await page.click('htRefreshBtn');
  assert.equal(page.element('bannerEventName').textContent, winter);
  assert.equal(page.element('detailsPanel').hidden, true);
  assert.match(page.element('htSummary').innerHTML, /Overall progress: <strong>0 of 0/);
  page.setActiveEvent('');
  await page.click('htRefreshBtn');
  assert.match(page.element('htNotice').textContent, /No active event/);
  assert.doesNotMatch(page.element('htRings').innerHTML, /data-ht-ring/);
  const unavailable = await loadPage({ activeEvent: spring });
  await unavailable.openDayOf(4);
  unavailable.failActiveEvent();
  await unavailable.click('htRefreshBtn');
  assert.equal(unavailable.element('bannerEventStatus').textContent, 'Unavailable');
  assert.match(unavailable.element('htSummary').innerHTML, /totals unavailable/);
});

test('Head Table clears assistance only after confirmation, scopes requests and displays errors', async () => {
  for (const confirm of [false, true]) {
    const now = new Date().toISOString();
    const page = await loadPage({ activeEvent: winter, confirm, rings: [{ ...ringA1, assistanceType: 'medical', assistanceRequestedAt: now }] });
    await page.openDayOf(4);
    assert.match(page.element('htSummary').innerHTML, /class="chip warning">Assistance: <strong>1/);
    assert.match(page.element('htSummary').innerHTML, /class="chip">Disconnected: <strong>0/);
    await page.ringAction('htRings', { htRing: 'ring-a-1' });
    await page.ringAction('headTableDetails', {}, { clear: true });
    const writes = page.requests.filter((request) => request.path.endsWith('/assistance/clear'));
    assert.equal(writes.length, confirm ? 1 : 0);
    if (confirm) {
      assert.equal(writes[0].name, winter);
      assert.equal(JSON.parse(writes[0].init.body).expectedAssistanceRequestedAt, now);
      assert.match(page.element('htNotice').textContent, /Assistance request cleared/);
      assert.doesNotMatch(page.element('headTableDetails').innerHTML, /data-ht-clear/);
    }
  }
  const failed = await loadPage({ activeEvent: winter, confirm: true, failClear: true, rings: [{ ...ringA1, assistanceType: 'medical', assistanceRequestedAt: 'request-1' }] });
  await failed.openDayOf(4);
  await failed.ringAction('htRings', { htRing: 'ring-a-1' });
  await failed.ringAction('headTableDetails', {}, { clear: true });
  assert.match(failed.element('htNotice').textContent, /Unable to clear assistance: Clear failed/);
  assert.match(failed.element('headTableDetails').innerHTML, /data-ht-clear/);
});

test('leaving Head Table ignores late board responses and cancels its polling', async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const page = await loadPage({ activeEvent: winter, waitForGroups: waiting, rings: [{ ...ringA1 }] });
  await page.openDayOf(4);
  await page.openImport();
  release();
  await settle();
  await settle();
  assert.equal(page.element('headTableView').hidden, true);
  assert.equal(page.element('workspaceTitle').textContent, 'Import');
  assert.equal(page.element('headTableDetails').hidden, true);
});

test('Head Table flags data older than thirty seconds and blocks stale assistance actions', async () => {
  const page = await loadPage({
    activeEvent: winter, confirm: true,
    rings: [{ ...ringA1, assistanceType: 'general', assistanceRequestedAt: new Date().toISOString() }]
  });
  await page.openDayOf(4);
  await page.ringAction('htRings', { htRing: 'ring-a-1' });
  await page.advanceTime(31000);
  assert.match(page.element('htFreshness').textContent, /STALE DATA/);
  await page.ringAction('headTableDetails', {}, { clear: true });
  assert.equal(page.requests.some((request) => request.path.endsWith('/assistance/clear')), false);
  await page.click('htRefreshBtn');
  assert.doesNotMatch(page.element('htFreshness').textContent, /STALE DATA/);
  await page.ringAction('headTableDetails', {}, { clear: true });
  assert.ok(page.requests.some((request) => request.path.endsWith('/assistance/clear')));
});

test('Head Table clearing rejects stale event and replaced assistance requests', async () => {
  for (const change of ['event', 'request']) {
    const ring = { ...ringA1, assistanceType: 'general', assistanceRequestedAt: 'original-request' };
    const page = await loadPage({ activeEvent: winter, confirm: true, rings: [ring] });
    await page.openDayOf(4);
    await page.ringAction('htRings', { htRing: 'ring-a-1' });
    if (change === 'event') page.setActiveEvent(spring);
    else ring.assistanceRequestedAt = 'replacement-request';
    await page.ringAction('headTableDetails', {}, { clear: true });
    assert.match(page.element('htNotice').textContent, /Unable to clear assistance: The (active event|assistance request) changed/);
    assert.equal(ring.assistanceType, 'general');
  }
});
