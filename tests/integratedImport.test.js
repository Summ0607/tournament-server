const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const initializeDatabase = require('../db/init');
const importCSV = require('../db/import-csv');
const { createCompetitorStore } = require('../backend/competitorStore');
const { buildEstimates } = require('../backend/ringEstimates');

const html = fs.readFileSync(path.join(__dirname, '..', 'tournament-management', 'index.html'), 'utf8');
const winter = 'Winter Tournament 2027';
const spring = 'Spring Tournament 2027';
const draftKey = 'tournamentSetup.groupReviewDraft';
const savedCompetitor = { id: 1, firstName: 'Saved', lastName: 'Competitor', rank: 'G1', gender: 'Male', age: 16, ageAsOf: '2027-01-16' };
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
    removeAttribute(name) { delete this[name]; },
    hasAttribute(name) { return Object.hasOwn(this, name); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    checkValidity() { return true; },
    reportValidity() {},
    focus() { this.focused = true; },
    showModal() { this.open = true; },
    show() { this.open = true; },
    close() { this.open = false; },
    contains(target) { return this.children.includes(target); }
  };
}

async function loadPage(options = {}) {
  const elements = new Map();
  for (const id of ['csAll', 'cs-name', 'cs-code', 'cs-description', 'cs-isTeam', 'cs-gender', 'cs-minAge', 'cs-maxAge', 'cs-minRank', 'cs-maxRank', 'cs-points']) elements.set(id, element());
  for (const field of require('../assets/visual-definitions').fields) {
    elements.set(`vd-${field.key}`, element());
    if (field.type === 'color') elements.set(`vd-${field.key}-picker`, element());
  }
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    elements.set(match[1], element(html.slice(match.index + match[0].length).split('<')[0]));
  }
  const parseElements = (pattern) => [...html.matchAll(pattern)].map((match) => {
    const id = match[0].match(/\sid="([^"]+)"/);
    const node = id ? elements.get(id[1]) : element();
    for (const attr of match[0].matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(attr[1], attr[2]);
    node.textContent = html.slice(match.index + match[0].length).split('<')[0];
    return node;
  });
  const nav = parseElements(/<button\b[^>]*data-nav-id="[^"]+"[^>]*>/g);
  const navGroups = parseElements(/<button\b[^>]*data-nav-group="[^"]+"[^>]*>/g);
  const externalLinks = parseElements(/<a\b[^>]*data-nav-external[^>]*>/g);
  const navById = new Map(nav.map((node) => [node.getAttribute('data-nav-id'), node]));
  let activeEvent = options.activeEvent || '';
  let activeFailure = false;
  let ringFailure = Boolean(options.failRings);
  const storage = new Map([['eventAdmin.lastSelectedEvent', options.selectedEvent ?? winter]]);
  if (options.expanded !== undefined) storage.set('tournamentManagement.navigation.expanded', options.expanded);
  if (options.draft) storage.set(draftKey, JSON.stringify(options.draft));
  const rosters = new Map([[winter, options.competitors || []], [spring, []]]);
  const configs = new Map([
    [winter, { name: winter, date: '2027-01-16', scope: 'regional', ringConfigX: 0, ringConfigY: 0 }],
    [spring, { name: spring, date: '2027-04-10', scope: 'world', ringConfigX: 2, ringConfigY: 3 }]
  ]);
  const location = { protocol: 'http:', origin: 'http://localhost:3000', href: `http://localhost:3000/tournament-management/${options.search || ''}`, search: options.search || '' };
  const windowHandlers = {};
  const media = { matches: Boolean(options.mobile), addEventListener: (_name, handler) => { media.change = handler; } };
  const entries = [{ url: location.href, state: null }];
  let historyPosition = 0;
  const setLocation = (url) => {
    location.href = String(url);
    location.search = new URL(url).search;
  };
  const history = {
    get state() { return entries[historyPosition].state; },
    replaceState: (state, _title, url) => {
      entries[historyPosition] = { state, url: String(url) };
      setLocation(url);
    },
    pushState: (state, _title, url) => {
      entries.splice(++historyPosition, entries.length, { state, url: String(url) });
      setLocation(url);
    },
    go: (delta) => {
      if (!entries[historyPosition + delta]) return;
      historyPosition += delta;
      setLocation(entries[historyPosition].url);
      windowHandlers.popstate({ state: history.state });
    }
  };
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
    TeamWorkspace: require('../tournament-management/team-management'),
    VisualDefinitions: require('../tournament-management/visual-definitions'),
    SchoolsWorkspace: require('../tournament-management/schools'),
    RanksWorkspace: require('../tournament-management/ranks'),
    CompetitionSettingsWorkspace: require('../tournament-management/competition-settings'),
    TournamentResultsWorkspace: require('../tournament-management/results'),
    RingJudgesWorkspace: require('../tournament-management/ring-judges'),
    JudgeAssignmentsWorkspace: require('../tournament-management/judge-assignments'),
    JudgeManagementWorkspace: require('../tournament-management/judge-management'),
    VolunteersWorkspace: require('../tournament-management/volunteers'),
    DivisionRules: require('../assets/division-rules'),
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
      BrowserSession: options.browserSession,
      location,
      history,
      matchMedia: () => media,
      addEventListener: (name, handler) => { windowHandlers[name] = handler; },
      localStorage: {
        getItem: (key) => { if (options.storageUnavailable) throw new Error('Storage unavailable'); return storage.get(key) || null; },
        setItem: (key, value) => { if (options.storageUnavailable) throw new Error('Storage unavailable'); storage.set(key, value); },
        removeItem: (key) => storage.delete(key)
      },
      alert: (message) => { confirmations.push(message); },
      confirm: (message) => { confirmations.push(message); return options.confirm === true; }
    },
    document: {
      getElementById: (id) => {
        const dynamicParent = {
          jaAvailabilityList: 'jaAvailabilityPanel',
          jaArbitrators: 'jaRingPlanning',
          jaArbitratorList: 'jaRingPlanning'
        }[id];
        if (dynamicParent && !elements.has(id)) {
          const parent = elements.get(dynamicParent);
          if (!parent.innerHTML.includes(`id="${id}"`)) return null;
          elements.set(id, element());
        }
        assert.ok(elements.has(id), `Missing element ${id}`);
        return elements.get(id);
      },
      querySelector: () => element(),
      querySelectorAll: (selector) => selector === '.sidebar-item' ? nav
        : selector === '[data-nav-group]' ? navGroups
        : selector === '[data-nav-external]' ? externalLinks
        : (options.estimateNodes || []).filter((node) => node.hasAttribute(selector.slice(1, -1))),
      createElement: () => element(),
      elementFromPoint: () => pointerTarget
    },
    fetch: async (url, init) => {
      const request = new URL(url);
      const name = request.searchParams.get('eventName');
      requests.push({ path: request.pathname, name, init });
      let data;
      switch (request.pathname) {
        case '/api/judge-management':
          data = { revision: 0, judges: [], aliases: require('../backend/judgeManagementRoutes').defaults,
            certificationLevels: require('../db/judgeCertification').certificationLevels(),
            ranks: require('../db/judgeCertification').judgeRankOptions() };
          break;
        case '/api/volunteers':
          data = { revision: null, types: [{ id: 'judging', name: 'Judging' }], volunteers: [], configurationLocked: false };
          break;
        case '/api/ring-judges':
          data = { eventName: name, revision: null, judges: [], configurationLocked: false,
            volunteerDirectory: { revision: null, tournamentDate: '2027-01-09',
              volunteers: [], types: [{ id: 'judging', name: 'Judging' }] } };
          break;
        case '/api/tournament-results':
          data = { eventName: name, source: { id: 'live', simulation: false },
            sources: [{ id: 'live', label: 'Live tournament' }], divisionCount: 0, competitorCount: 0,
            medals: { first: 0, second: 0, third: 0 }, disciplines: [], correctedAges: 0, categories: [] };
          break;
        case '/api/ranks':
          data = { ranks: require('../backend/rankRoutes').initialRanks };
          break;
        case '/api/schools':
          data = { schools: require('../backend/schoolRoutes').initialSchools };
          break;
        case '/api/visual-definitions':
          data = { revision: null, values: require('../assets/visual-definitions').defaults() };
          break;
        case '/api/teams':
          if (options.teamRequest) return options.teamRequest(name, init);
          data = { eventName: name, teams: [], roster: options.teamRoster || [],
            settings: { TS: { teamSize: 3, genderPolicy: 'single' }, TH: { teamSize: 3, genderPolicy: 'single' } }, configurationLocked: Boolean(options.teamLocked) };
          break;
        case '/api/simulator/runs':
          if (options.failSimulatorList) return { ok: false, json: async () => ({ error: 'Simulator list unavailable' }) };
          data = { runs: options.simulatorRuns || [] };
          break;
        case '/api/events/list':
          if (options.failEventList) return { ok: false, json: async () => ({ error: 'Tournament list unavailable' }) };
          data = { events: Array.from(configs.keys()) }; break;
        case '/api/events/active':
          data = { activeEvent };
          if (options.waitForActive) await options.waitForActive(requests.filter((item) => item.path === '/api/events/active').length);
          if (activeFailure) return { ok: false, json: async () => ({ error: 'Active event unavailable' }) };
          break;
        case '/api/events/activate':
          if (options.waitForActivation) await options.waitForActivation;
          if (options.failActivation) return { ok: false, json: async () => ({ error: 'Activation unavailable' }) };
          activeEvent = JSON.parse(init.body).eventName;
          data = { ok: true, activeEvent };
          break;
        case '/api/events/config':
          if (options.failEventMetadata === name) return { ok: false, json: async () => ({ error: 'Metadata unavailable' }) };
          data = { eventConfig: configs.get(name), dbExists: name === winter ? dbExists : false,
            ageDateLocked: Boolean(options.ageDateLocked),
            configurationLocked: Boolean(options.configurationLocked),
            configurationLockReason: options.configurationLocked ? 'Event configuration is locked. Reset the run to return to preparation.' : '' };
          break;
        case '/api/events/reset-run':
          options.configurationLocked = false;
          rings = [];
          data = { ok: true, archive: 'run-archives/test-run' };
          break;
        case '/api/events/create':
        case '/api/events/modify': {
          if (options.failEventSave) return { ok: false, json: async () => ({ error: 'Save unavailable' }) };
          const body = JSON.parse(init.body);
          configs.set(body.eventName, body);
          data = { ok: true };
          break;
        }
        case '/api/competitors':
          if (options.waitForRoster) await options.waitForRoster;
          if (failSnapshot) return { ok: false, json: async () => ({ error: 'Database unavailable' }) };
          data = options.rostersByEvent ? options.rostersByEvent[name] || [] : rosters.get(name);
          break;
        case '/api/groups':
          if (options.waitForGroups) await (typeof options.waitForGroups === 'function' ? options.waitForGroups(name) : options.waitForGroups);
          data = { groups: options.groupsByEvent ? options.groupsByEvent[name] || [] : groups };
          break;
        case '/api/rings': {
          if (ringFailure) return { ok: false, json: async () => ({ error: 'Rings unavailable' }) };
          if (name !== activeEvent) return { ok: false, json: async () => ({ error: 'The active event changed. Refresh Ring Assignment before continuing.' }) };
          const assigned = new Set(rings.flatMap((ring) => [ring.groupDivisionNumber, ...(ring.queuedGroupDivisionNumbers || []), ...(ring.completedGroupDivisionNumbers || [])]).map(String));
          const eventGroups = options.groupsByEvent ? options.groupsByEvent[name] || [] : groups;
          data = { rings: JSON.parse(JSON.stringify(rings)), ringConfig,
            eventStartedAt: typeof options.eventStartedAt === 'function' ? options.eventStartedAt() : options.eventStartedAt || '',
            schedule: options.schedule,
            estimates: typeof options.estimates === 'function' ? options.estimates() : options.estimates,
            availableGroupDivisionNumbers: eventGroups.map((group) => String(group.groupDivisionNumber)).filter((id) => !assigned.has(id)) };
          break;
        }
        case '/api/rings/schedule/day2':
          if (options.schedule) options.schedule = { ...options.schedule, day2Started: true };
          data = { ok: true };
          break;
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
          if (request.pathname.startsWith('/api/competition-settings/')) {
            data = { revision: null, rows: require('../assets/competition-settings').defaults(request.pathname.split('/').at(-1)), configurationLocked: false };
            break;
          }
          if (/^\/api\/simulator\/runs\/[^/]+\/(?:ring-assignment|head-table)$/.test(request.pathname)) {
            if (options.waitForSimulation) await options.waitForSimulation;
            if (options.failSimulation) return { ok: false, json: async () => ({ error: 'Simulation unavailable' }) };
            const board = typeof options.simulatorBoard === 'function' ? options.simulatorBoard() : options.simulatorBoard;
            if (!board) throw new Error('Missing simulator board fixture');
            data = board;
            break;
          }
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
  const dispatch = async (target, name = 'click', event = {}) => {
    await target.handlers[name](event);
    await settle();
  };
  return {
    element: (id) => elements.get(id),
    openTournament: () => dispatch(elements.get('tournamentListBody'), 'click', {
      target: { closest: () => ({ getAttribute: () => elements.get('eventNameInput').value }) }
    }),
    click: (id) => dispatch(elements.get(id)),
    input: (id, name) => dispatch(elements.get(id), name),
    submitLookup: () => dispatch(elements.get('clToolbar'), 'submit', { preventDefault() {} }),
    openImport: () => dispatch(elements.get('clImportBtn')),
    openGroups: () => dispatch(navById.get('groups')),
    openDayOf: (id = 'ring-assignment') => dispatch(navById.get(id)),
    navigate: (id) => dispatch(navById.get(id)),
    selectTournament: async (name) => {
      elements.get('tournamentReferenceSelect').value = name;
      await dispatch(elements.get('tournamentReferenceSelect'), 'change');
      await settle();
      await settle();
    },
    clickDivision: async (number) => {
      const link = { getAttribute: (name) => name === 'data-cl-division' ? String(number) : null };
      await elements.get('clResults').handlers.click({
        target: { closest: (selector) => selector === '[data-cl-division]' ? link : null },
        preventDefault() {}
      });
      await settle();
      await settle();
    },
    activeEvent: () => activeEvent,
    nav: (id) => navById.get(id),
    navGroups, externalLinks,
    history: async (delta) => { history.go(delta); await settle(); },
    permissionsChanged: () => windowHandlers['browser-permissions-changed'](),
    historyLength: () => entries.length,
    key: (id, key) => dispatch(elements.get(id), 'keydown', { key, preventDefault() {} }),
    resize: (mobile) => { media.matches = mobile; media.change(); },
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
      const ticks = [...timers.entries()].filter(([, timer]) => timer.delay === 1000);
      for (const [id, timer] of ticks) {
        if (timers.delete(id)) timer.callback();
      }
      await settle();
    },
    refreshDayOf: async () => {
      // An open day-of view refreshes when it is selected again.
      navById.get('ring-assignment').setAttribute('aria-disabled', 'false');
      await dispatch(navById.get('ring-assignment'));
    },
    location,
    select: async (name) => {
      if (name === '__new__') {
        await dispatch(elements.get('createEventBtn'));
      } else {
        elements.get('tournamentReferenceSelect').value = name;
        await dispatch(elements.get('tournamentReferenceSelect'), 'change');
      }
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
  assert.equal(page.element('pageContent').classList.contains('group-builder'), false);
  assertNextDefault(page);
  assert.equal(page.element('importedCount').textContent, 1);
  assert.equal(page.element('warningCount').textContent, 'Not available');
  assert.equal(page.element('importDetailTime').textContent, 'Loaded from saved database');
  await page.click('importNextBtn');
  assert.equal(page.element('groupsView').hidden, false);
  assert.equal(page.element('pageContent').classList.contains('group-builder'), true);
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

test('age-bound tournament dates stay locked while other preparation settings remain editable', async () => {
  const page = await loadPage({ ageDateLocked: true });
  await page.openTournament();
  assert.equal(page.element('dateInput').disabled, true);
  assert.equal(page.element('locationInput').disabled, false);
  assert.equal(page.element('saveMetadataBtn').disabled, false);
  assert.match(page.element('eventConfigurationHelp').textContent, /date is fixed/);
});

test('legacy birth-date drafts are removed on page load without deleting saved groups', async () => {
  const page = await loadPage({
    competitors: [savedCompetitor],
    draft: { eventName: winter, groups: [{ id: 'legacy', competitors: [{ ...savedCompetitor, dob: '2010-01-01' }] }] }
  });
  assert.equal(page.storage.has(draftKey), false);
  assert.match(page.confirmations[0], /birth dates.*removed/);
  await page.openGroups();
  assert.doesNotMatch(page.element('gbBanners').innerHTML, /legacy/);
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
  await page.openGroups();
  await page.openImport();
  page.element('csvTextInput').value = 'First Name\nNew';
  const importing = page.click('importBtn');
  await settle();
  await page.selectTournament(spring);
  assert.equal(page.element('tournamentReferenceSelect').value, winter);
  await page.click('importBtn');
  await page.openGroups();
  await page.navigate('results');
  await page.history(-1);
  assert.equal(new URLSearchParams(page.location.search).get('view'), 'import');
  assert.equal(page.element('importView').hidden, false);
  assert.equal(page.historyLength(), 3);
  for (const link of page.externalLinks) {
    let prevented = false;
    link.handlers.click({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  }
  assert.equal(page.element('groupsView').hidden, true);
  assert.equal(page.requests.filter((request) => request.init).length, 1);
  release();
  await importing;
  assertNextDefault(page);
  await page.history(-1);
  assert.equal(page.element('groupsView').hidden, false);
  await page.history(1);
  assert.equal(page.element('importView').hidden, false);
});

test('navigation destinations have stable IDs, approved labels and native Administration links', async () => {
  const page = await loadPage({ activeEvent: spring });
  const expected = {
    'event-setup': 'Tournament', competitors: 'Competitors', volunteers: 'Volunteers', 'volunteer-types': 'Volunteer Types', groups: 'Divisions',
    results: 'Results', 'team-management': 'Teams', 'team-settings': 'Settings', 'ring-judges': 'Ring Judges',
    'judge-assignments': 'Judge Assignments', 'tablet-pairing': 'Ring Assignment', 'ring-assignment': 'Division Assignments',
    'division-qr': 'Division QR Codes', 'head-table': 'Head Table', 'audience-viewer': 'Audience Viewer', printing: 'Printing', 'csv-settings': 'CSV Settings',
    'judge-management': 'Judges', 'judge-testing': 'Testing', 'judge-eligibility': 'Eligibility',
    'judge-experience': 'Experience', 'judge-csv-settings': 'CSV Settings', 'clinic-management': 'Clinic Management',
    'event-history': 'Event History', 'your-account': 'Your Account', 'visual-definitions': 'Visual Definitions',
    'server-maintenance': 'Server Maintenance', simulator: 'Simulator', schools: 'Schools', ranks: 'Ranks',
    'competition-types': 'Competition Types', 'grand-champion-categories': 'Grand Champion Categories', 'medal-points': 'Medal Points',
    users: 'Users', 'user-account-settings': 'User Account Settings'
  };
  assert.equal([...html.matchAll(/data-nav-id="/g)].length, Object.keys(expected).length);
  for (const [id, label] of Object.entries(expected)) assert.equal(page.nav(id).getAttribute('data-nav-label'), label);
  assert.equal(page.externalLinks.length, 0);
  assert.equal(page.nav('import'), undefined);
  assert.equal(page.nav('competitors').getAttribute('data-nav-parents'), 'tournament');
  assert.doesNotMatch(html, /id="navCompetitors"|id="navCompetitorsChildren"/);
  assert.equal(page.nav('ring-assignment').getAttribute('data-nav-parents'), 'tournament rings');
  assert.ok(html.indexOf('data-nav-id="tablet-pairing"') < html.indexOf('data-nav-id="ring-assignment"'));
  assert.equal(page.nav('head-table').getAttribute('data-nav-parents'), 'tournament rings');
  for (const id of ['judge-management', 'judge-testing', 'judge-eligibility', 'judge-experience', 'judge-csv-settings']) {
    assert.equal(page.nav(id).getAttribute('data-nav-parents'), 'judge-management');
  }
  assert.ok(html.indexOf('id="navVolunteers"') < html.indexOf('id="navCompetitionSettings"'));
  assert.doesNotMatch(html, /id="navSelectedEvent"|id="navActiveEvent"/);
  page.nav('groups').textContent = 'A translated display label';
  await page.openGroups();
  assert.equal(page.element('workspaceTitle').textContent, 'Divisions');
  assert.equal(page.element('workspacePanel').getAttribute('aria-label'), 'Divisions workspace');
  assert.equal(page.nav('groups').getAttribute('aria-current'), 'page');
  assert.equal(page.nav('event-setup').hasAttribute('aria-current'), false);
});

test('Judge Management sections open independently and expand their navigation group', async () => {
  const sections = ['judge-management', 'judge-testing', 'judge-eligibility', 'judge-experience', 'judge-csv-settings'];
  const panels = ['jmJudges', 'jmTesting', 'jmEligibility', 'jmExperience', 'jmCsvSettings'];
  const page = await loadPage();
  for (const [index, id] of sections.entries()) {
    await page.navigate(id);
    assert.equal(page.element('navJudgeManagementChildren').hidden, false);
    assert.equal(page.element('judgeManagementView').hidden, false);
    for (const [panelIndex, panel] of panels.entries()) {
      assert.equal(page.element(panel).hidden, panelIndex !== index);
    }
    assert.equal(page.element('workspaceTitle').textContent, page.nav(id).getAttribute('data-nav-label'));
    assert.equal(new URLSearchParams(page.location.search).get('view'), id);
    assert.equal(page.nav(id).getAttribute('aria-current'), 'page');
  }
  await page.navigate('event-setup');
  assert.equal(page.element('judgeManagementView').hidden, true);
  const direct = await loadPage({ search: '?view=judge-experience' });
  assert.equal(direct.element('navJudgeManagementChildren').hidden, false);
  assert.equal(direct.element('jmExperience').hidden, false);
  assert.equal(direct.element('workspaceTitle').textContent, 'Experience');
});

test('Judge Management email entry and CSV mapping are explicitly disabled', () => {
  assert.match(html, /<label>Email \(not available yet\)<input type="email" disabled><\/label>/);
  assert.match(html, /<label>Email \(not available yet\)<input disabled placeholder="email, email_address"><\/label>/);
  assert.match(html, /<label>Search name or WTSDA ID<input id="jmSearch" type="search"><\/label>/);
});

test('Judge Management preview opens Add and Import screens and returns to their source', async () => {
  const page = await loadPage({ search: '?view=judge-management' });
  assert.equal(page.element('jmJudges').hidden, false);
  await page.click('jmAddJudge');
  assert.equal(page.element('jmAdd').hidden, false);
  assert.equal(page.element('workspaceTitle').textContent, 'Add Judge');
  assert.equal(page.element('workspacePanel').getAttribute('aria-label'), 'Add Judge workspace');
  await page.click('jmAddCancel');
  assert.equal(page.element('jmJudges').hidden, false);
  await page.click('jmImportJudges');
  assert.equal(page.element('jmImport').hidden, false);
  assert.equal(page.element('workspaceTitle').textContent, 'Import Judges');
  await page.click('jmImportCancel');
  assert.equal(page.element('jmJudges').hidden, false);
  await page.navigate('judge-testing');
  await page.click('jmTestingAdd');
  await page.click('jmAddCancel');
  assert.equal(page.element('jmTesting').hidden, false);
  assert.equal(page.element('workspaceTitle').textContent, 'Testing');
  for (const [section, addButton, panel, title] of [
    ['judge-eligibility', 'jmEligibilityAdd', 'jmEligibility', 'Eligibility'],
    ['judge-experience', 'jmExperienceAdd', 'jmExperience', 'Experience']
  ]) {
    await page.navigate(section);
    await page.click(addButton);
    await page.click('jmAddCancel');
    assert.equal(page.element(panel).hidden, false);
    assert.equal(page.element('workspacePanel').getAttribute('aria-label'), `${title} workspace`);
  }
  assert.equal(page.requests.some((request) => request.init && request.init.method !== 'GET'), false);
});

test('Ring Assignment opens daily QR tools inside the shell and unloads on navigation', async () => {
  const page = await loadPage({ activeEvent: spring, search: '?view=tablet-pairing' });
  assert.equal(page.element('administrationToolView').hidden, false);
  assert.equal(page.element('administrationToolFrame').getAttribute('src'), '/tablet-pairing/?embedded=1');
  assert.equal(page.element('administrationToolFrame').getAttribute('title'), 'Ring Assignment');
  assert.equal(page.element('workspaceTitle').textContent, 'Ring Assignment');
  assert.equal(page.element('tournamentReferenceLabel').textContent, 'Active Tournament');
  await page.openDayOf();
  assert.equal(page.element('ringAssignmentView').hidden, false);
  assert.equal(page.element('administrationToolFrame').hasAttribute('src'), false);
});

test('role-limited shell selects an allowed initial workspace and rejects programmatic forbidden navigation', async () => {
  const views = new Set(['tablet-pairing', 'ring-assignment', 'head-table', 'audience-viewer', 'your-account']);
  const page = await loadPage({ activeEvent: spring, search: '?view=ring-assignment',
    browserSession: { ready: Promise.resolve(), canView: (view) => views.has(view) } });
  assert.equal(page.element('ringAssignmentView').hidden, false);
  assert.equal(page.element('tournamentReferenceSelect').disabled, true);
  await page.navigate('users');
  assert.equal(page.element('ringAssignmentView').hidden, false);
  assert.match(page.element('notice').textContent, /role does not permit/);
  await page.navigate('tablet-pairing');
  assert.equal(page.element('administrationToolFrame').getAttribute('src'), '/tablet-pairing/?embedded=1');
  assert.equal(page.element('tournamentReferenceSelect').disabled, true);
  await page.navigate('head-table');
  assert.equal(page.element('headTableView').hidden, false);
});

test('revoked workspaces retain edits and block controls without disabling permitted navigation', async () => {
  const views = new Set(['event-setup', 'ring-assignment']);
  const page = await loadPage({ browserSession: { ready: Promise.resolve(), canView: (view) => views.has(view) } });
  await page.click('createEventBtn');
  page.element('eventNameInput').value = 'Retained tournament draft';
  views.delete('event-setup');
  page.permissionsChanged();
  assert.equal(page.element('workspacePanel').inert, true);
  assert.equal(page.element('detailsPanel').inert, true);
  assert.notEqual(page.element('pageContent').inert, true);
  assert.equal(page.element('eventNameInput').value, 'Retained tournament draft');
  views.add('event-setup');
  page.permissionsChanged();
  assert.equal(page.element('workspacePanel').inert, false);
  assert.equal(page.element('eventNameInput').value, 'Retained tournament draft');
});

test('Administration tools stay in the shell, unload on exit, and obey unsaved draft guards', async () => {
  const page = await loadPage({ activeEvent: spring, search: '?view=simulator' });
  assert.equal(page.element('administrationToolView').hidden, false);
  assert.equal(page.element('administrationToolFrame').getAttribute('src'), '/simulator/?embedded=1');
  assert.equal(page.element('tournamentReference').hidden, true);
  assert.equal(page.element('navAdministration').getAttribute('aria-expanded'), 'true');
  assert.equal(page.nav('simulator').getAttribute('aria-current'), 'page');
  await page.navigate('server-maintenance');
  assert.equal(page.element('administrationToolFrame').getAttribute('src'), '/admin/?embedded=1');
  assert.equal(page.element('administrationToolFrame').getAttribute('title'), 'Server Maintenance');
  await page.navigate('competitors');
  assert.equal(page.element('administrationToolView').hidden, true);
  assert.equal(page.element('administrationToolFrame').hasAttribute('src'), false);
  await page.navigate('team-settings');
  page.element('tmSize').value = '4';
  await page.input('tmSize', 'input');
  await page.navigate('simulator');
  assert.equal(page.element('teamSettingsView').hidden, false);
  assert.match(page.confirmations.at(-1), /unsaved team/);
});

test('schools navigation remains Administration-scoped with an add/edit overlay', async () => {
  const page = await loadPage({ activeEvent: spring, search: '?view=schools' });
  assert.equal(page.element('schoolsView').hidden, false);
  assert.equal(page.element('tournamentReference').hidden, true);
  assert.equal(page.nav('schools').getAttribute('aria-current'), 'page');
  assert.equal(page.element('navAdministration').getAttribute('aria-expanded'), 'true');
  assert.match(page.element('schoolsBody').innerHTML, /Vaughns Dojang IV - Audubon.*GM Charles Vaughn/);
  await page.click('addSchool');
  assert.equal(page.element('schoolDialog').open, true);
  assert.equal(page.element('schoolDialogTitle').textContent, 'Add School');
  await page.click('schoolCancel');
  assert.equal(page.element('schoolDialog').open, false);
  assert.equal(page.activeEvent(), spring);
});

test('ranks navigation is Administration-scoped, displays abbreviations and guards unsaved overlays', async () => {
  const page = await loadPage({ activeEvent: spring, search: '?view=ranks' });
  assert.equal(page.element('ranksView').hidden, false);
  assert.equal(page.element('tournamentReference').hidden, true);
  assert.equal(page.nav('ranks').getAttribute('aria-current'), 'page');
  assert.equal(page.element('navAdministration').getAttribute('aria-expanded'), 'true');
  assert.match(page.element('ranksBody').innerHTML, /Tiny Tigers \/ Little Dragons.*TTLD.*Special Dragons.*SD/);
  await page.click('addRank');
  page.element('rank-name').value = 'Draft';
  await page.navigate('competitors');
  assert.equal(page.element('ranksView').hidden, false);
  assert.match(page.confirmations.at(-1), /unsaved rank/);
  assert.equal(page.element('rank-name').value, 'Draft');
  assert.equal(page.activeEvent(), spring);
});

test('competition settings pages share selected tournament, expand tiers and guard unsaved category edits', async () => {
  const page = await loadPage({ activeEvent: spring, search: '?view=grand-champion-categories' });
  assert.equal(page.element('competitionSettingsView').hidden, false);
  assert.equal(page.element('tournamentReferenceSelect').value, winter);
  assert.equal(page.element('navCompetitionSettings').getAttribute('aria-expanded'), 'true');
  assert.match(page.element('csBody').innerHTML, /Adult Female Black Belt Champion/);
  await page.click('csAdd');
  page.element('cs-name').value = 'Draft category';
  await page.selectTournament(spring);
  assert.equal(page.element('tournamentReferenceSelect').value, winter);
  assert.match(page.confirmations.at(-1), /unsaved competition settings/);
  await page.navigate('medal-points');
  assert.equal(page.nav('grand-champion-categories').getAttribute('aria-current'), 'page');
  assert.equal(page.element('cs-name').value, 'Draft category');
  const medals = await loadPage({ search: '?view=medal-points' });
  assert.match(medals.element('csBody').innerHTML, /1st Place.*10.*2nd Place.*8.*3rd Place.*5/);
  assert.equal(medals.element('csAdd').textContent, 'Add Medal');
  const types = await loadPage({ search: '?view=competition-types' });
  assert.match(types.element('csBody').innerHTML, /Team Sparring.*TS.*Yes/);
  assert.equal(types.activeEvent(), '');
});

test('navigation restores disclosure preferences and opens every active ancestor', async () => {
  const storageKey = 'tournamentManagement.navigation.expanded';
  const page = await loadPage({ expanded: JSON.stringify({ tournament: false, competitors: true, rings: true, administration: true }) });
  assert.equal(page.element('navTournament').getAttribute('aria-expanded'), 'true');
  assert.equal(page.element('navRingsChildren').hidden, false);
  assert.equal(page.element('navAdministrationChildren').hidden, false);
  await page.click('navRings');
  assert.equal(page.element('navRingsChildren').hidden, true);
  const reloaded = await loadPage({ expanded: page.storage.get(storageKey), search: '?view=import' });
  assert.equal(reloaded.element('navRingsChildren').hidden, true);
  assert.equal(reloaded.element('navAdministrationChildren').hidden, false);
  assert.equal(reloaded.nav('competitors').getAttribute('aria-current'), 'page');
  assert.equal(reloaded.element('importView').hidden, false);
  for (const button of reloaded.navGroups) {
    assert.equal(button.getAttribute('type'), 'button');
    assert.equal(reloaded.element(button.getAttribute('aria-controls')).hidden, button.getAttribute('aria-expanded') !== 'true');
  }
});

test('manual team navigation opens both tiers, stays selected-scoped and protects unsaved team/settings edits', async () => {
  const page = await loadPage({ activeEvent: spring, teamRoster: [savedCompetitor, newCompetitor] });
  await page.navigate('team-management');
  assert.equal(page.element('teamsView').hidden, false);
  assert.equal(page.element('placeholderView').hidden, true);
  assert.equal(page.element('detailsPanel').hidden, true);
  assert.equal(page.element('navTeams').getAttribute('aria-expanded'), 'true');
  assert.equal(page.element('navTournament').getAttribute('aria-expanded'), 'true');
  assert.equal(page.element('tournamentReferenceSelect').value, winter);
  assert.equal(page.requests.filter((request) => request.path === '/api/teams').at(-1).name, winter);
  await page.click('tmAdd');
  page.element('tmName').value = 'Unsaved';
  await page.input('tmName', 'input');
  await page.navigate('team-management');
  assert.equal(page.element('tmName').value, 'Unsaved');
  await page.navigate('team-settings');
  assert.equal(page.element('teamsView').hidden, false);
  assert.match(page.confirmations.at(-1), /unsaved team/);
  await page.selectTournament(spring);
  assert.equal(page.element('tournamentReferenceSelect').value, winter);
  await page.history(-1);
  assert.equal(page.element('teamsView').hidden, false);
  assert.equal(page.nav('team-management').getAttribute('aria-current'), 'page');
  const settings = await loadPage({ activeEvent: spring, search: '?view=team-settings', confirm: true });
  assert.equal(settings.element('teamSettingsView').hidden, false);
  settings.element('tmSize').value = '4';
  await settings.input('tmSize', 'input');
  await settings.selectTournament(spring);
  assert.match(settings.confirmations.at(-1), /unsaved team or team settings/);
  assert.equal(settings.element('tmSize').value, 3);
  assert.equal(settings.requests.filter((request) => request.path === '/api/teams').at(-1).name, spring);
  assert.equal(settings.activeEvent(), spring);
  const noSelection = await loadPage({ selectedEvent: '', search: '?view=team-management' });
  assert.equal(noSelection.requests.some((request) => request.path === '/api/teams'), false);
  assert.equal(noSelection.element('tmAdd').disabled, true);
});

test('visual definitions are Administration-scoped and guard draft navigation without changing live selection', async () => {
  const page = await loadPage({ activeEvent: spring, search: '?view=visual-definitions' });
  assert.equal(page.element('visualDefinitionsView').hidden, false);
  assert.equal(page.element('tournamentReference').hidden, true);
  assert.equal(page.element('detailsPanel').hidden, true);
  assert.equal(page.element('navAdministration').getAttribute('aria-expanded'), 'true');
  assert.equal(page.nav('visual-definitions').getAttribute('aria-current'), 'page');
  assert.equal(page.requests.filter((request) => request.path === '/api/visual-definitions').length, 1);
  page.element('vd-bodySize').value = '13';
  await page.input('vd-bodySize', 'input');
  await page.navigate('competitors');
  assert.equal(page.element('visualDefinitionsView').hidden, false);
  assert.match(page.confirmations.at(-1), /unsaved visual definitions/);
  assert.equal(page.element('vd-bodySize').value, '13');
  assert.equal(page.activeEvent(), spring);
  const confirmed = await loadPage({ activeEvent: spring, search: '?view=visual-definitions', confirm: true });
  confirmed.element('vd-bodySize').value = '13';
  await confirmed.input('vd-bodySize', 'input');
  await confirmed.navigate('competitors');
  assert.equal(confirmed.element('visualDefinitionsView').hidden, true);
  assert.equal(confirmed.element('competitorLookupView').hidden, false);
});

test('Head Table links open under Ring Management and tolerate storage failures', async () => {
  for (const expanded of ['not json', '[]', 'null', '{"rings":"false"}']) {
    const page = await loadPage({ expanded, search: '?view=head-table', activeEvent: winter });
    assert.equal(page.element('navRings').getAttribute('aria-expanded'), 'true');
    assert.equal(page.nav('head-table').getAttribute('data-nav-parents'), 'tournament rings');
    assert.equal(page.element('navTournamentChildren').hidden, false);
    assert.equal(page.nav('head-table').getAttribute('aria-current'), 'page');
  }
  const unavailable = await loadPage({ storageUnavailable: true });
  await unavailable.click('navAdministration');
  assert.equal(unavailable.element('navAdministrationChildren').hidden, false);
  await unavailable.navigate('your-account');
  assert.equal(unavailable.nav('your-account').getAttribute('data-nav-planned'), undefined);
  assert.equal(unavailable.element('administrationToolFrame').getAttribute('src'), '/account/profile?embedded=1');
});

test('Results is tournament-scoped, read-only and independent of active ring controls', async () => {
  const page = await loadPage({ activeEvent: spring });
  await page.navigate('results');
  assert.equal(page.nav('results').getAttribute('data-nav-planned'), undefined);
  assert.equal(page.element('resultsView').hidden, false);
  assert.equal(page.element('placeholderView').hidden, true);
  assert.equal(page.element('workspaceTitle').textContent, 'Running Results');
  await page.selectTournament(winter);
  assert.ok(page.requests.some((request) => request.path === '/api/tournament-results' && request.name === winter));
  assert.match(page.element('resultSummary').textContent, /0 completed divisions/);
  assert.equal(page.element('resultSource').disabled, false);
  await page.navigate('schools');
  assert.equal(page.element('resultsView').hidden, true);
});

test('Ring Judges and Volunteer Management use selected-tournament preparation', async () => {
  const page = await loadPage({ activeEvent: spring, selectedEvent: winter, confirm: false });
  await page.navigate('ring-judges');
  assert.equal(page.element('ringJudgesView').hidden, false);
  assert.equal(page.nav('ring-judges').getAttribute('data-nav-planned'), undefined);
  assert.equal(page.element('tournamentReferenceLabel').textContent, 'Tournament for this page');
  assert.equal(page.element('bannerEventName').textContent, winter);
  assert.ok(page.requests.some((request) => request.path === '/api/ring-judges' && request.name === winter));
  await page.click('rjAdd');
  page.element('rj-firstName').value = 'Unsaved judge';
  await page.navigate('volunteers');
  assert.equal(page.element('ringJudgesView').hidden, false);
  await page.selectTournament(spring);
  assert.equal(page.element('tournamentReferenceSelect').value, winter);
  page.element('rj-firstName').value = '';
  await page.click('rjCancel');
  await page.navigate('volunteers');
  assert.equal(page.element('ringJudgesView').hidden, true);
  assert.equal(page.element('volunteersView').hidden, false);
  assert.equal(page.nav('volunteers').getAttribute('data-nav-parents'), 'tournament volunteer-management');
  assert.equal(page.nav('volunteers').getAttribute('data-nav-planned'), undefined);
  assert.equal(page.activeEvent(), spring);
  assert.equal(page.requests.some((request) => request.path === '/api/events/activate'), false);
});

test('Planned destinations are explicit, independently addressable and never load or write live tools', async () => {
  assert.doesNotMatch(html, /class="nav-planned"/);
  const page = await loadPage({ activeEvent: spring });
  const before = page.requests.length;
  for (const id of ['printing', 'csv-settings', 'clinic-management', 'event-history']) {
    assert.equal(page.nav(id).getAttribute('data-nav-planned'), 'true');
    await page.navigate(id);
    assert.equal(page.element('placeholderView').hidden, false);
    assert.equal(page.element('placeholderTitle').textContent, page.nav(id).getAttribute('data-nav-label'));
    assert.equal(page.element('placeholderMessage').textContent,
      id === 'clinic-management' ? 'Under Development.' : 'Planned.');
    assert.equal(page.nav(id).getAttribute('aria-current'), 'page');
    assert.equal(new URLSearchParams(page.location.search).get('view'), id);
    for (const view of ['eventSetupView', 'importView', 'groupsView', 'ringAssignmentView', 'headTableView', 'competitorLookupView', 'detailsPanel']) {
      assert.equal(page.element(view).hidden, true);
    }
  }
  assert.equal(page.requests.slice(before).some((request) => request.init || request.path.startsWith('/api/rings')), false);
  const direct = await loadPage({ search: '?view=printing' });
  assert.equal(direct.element('placeholderTitle').textContent, 'Printing');
  assert.equal(direct.element('placeholderView').hidden, false);
  assert.equal(direct.requests.some((request) => request.init), false);
});

test('browser Back and Forward restore URLs, current markers, active ancestors and saved-only source', async () => {
  const page = await loadPage({ search: '?view=groups&source=saved', activeEvent: winter });
  await page.openImport();
  await page.openDayOf();
  assert.equal(page.element('workspaceTitle').textContent, 'Division Assignments');
  assert.equal(page.historyLength(), 3);
  await page.history(-1);
  assert.equal(page.element('importView').hidden, false);
  assert.equal(page.nav('competitors').getAttribute('aria-current'), 'page');
  await page.history(-1);
  assert.equal(page.element('groupsView').hidden, false);
  assert.equal(new URLSearchParams(page.location.search).get('source'), 'saved');
  await page.history(1);
  assert.equal(page.element('importView').hidden, false);
  await page.history(1);
  assert.equal(page.element('ringAssignmentView').hidden, false);
  assert.equal(page.nav('ring-assignment').getAttribute('aria-current'), 'page');
  await page.openDayOf();
  assert.equal(page.historyLength(), 3, 'Selecting the current page refreshes without adding history');
});

test('mobile Menu and Escape use native controls and return focus; page selection focuses the heading', async () => {
  const page = await loadPage({ mobile: true });
  assert.equal(page.element('primaryNavigation').classList.contains('mobile-closed'), true);
  assert.equal(page.element('navToggle').getAttribute('aria-expanded'), 'false');
  await page.click('navToggle');
  assert.equal(page.element('navToggle').getAttribute('aria-expanded'), 'true');
  assert.equal(page.element('primaryNavigation').classList.contains('mobile-closed'), false);
  await page.key('primaryNavigation', 'Escape');
  assert.equal(page.element('navToggle').getAttribute('aria-expanded'), 'false');
  assert.equal(page.element('navToggle').focused, true);
  await page.click('navToggle');
  await page.navigate('printing');
  assert.equal(page.element('primaryNavigation').classList.contains('mobile-closed'), true);
  assert.equal(page.element('workspaceTitle').focused, true);
  page.resize(false);
  assert.equal(page.element('navToggle').getAttribute('aria-expanded'), 'true');
  page.resize(true);
  assert.equal(page.element('navToggle').getAttribute('aria-expanded'), 'false');
  assert.match(html, /<button id="navToggle"[^>]+type="button"[^>]+aria-controls="primaryNavigation"/);
  assert.match(html, /\.sidebar\.mobile-closed\s*\{\s*display: none;/);
});

test('a missing database can be initialized, imported and used to persist group assignments', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'integrated-import-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, 'tournament.db');
  const csvPath = path.join(directory, 'registration.csv');
  fs.writeFileSync(csvPath, 'First Name,Last Name,DOB,Association Number,Gender,Current Rank\nNew,Competitor,01/01/2010,TSD-001,Male,G1\n');
  assert.equal(fs.existsSync(dbPath), false);
  await initializeDatabase(dbPath);
  await importCSV(csvPath, dbPath, { clearExisting: true, tournamentDate: '2027-01-16' });
  const store = createCompetitorStore(dbPath);
  const competitors = await store.loadCompetitors();
  assert.equal(competitors.length, 1);
  assert.equal(competitors[0].firstName, 'New');
  await store.saveDivisionAssignments([{ groupId: 'new-group', competitors }]);
  const restored = await createCompetitorStore(dbPath).loadCompetitors();
  assert.equal(restored[0].groupDivisionNumber, 20);
});

for (const header of ['Special Needs', 'Special Needs (Y|N)']) {
  test(`Special Needs import, grouping and save/reload preserve ${header} flags`, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'special-needs-import-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const dbPath = path.join(directory, 'tournament.db');
    const csvPath = path.join(directory, 'registration.csv');
    const year = new Date().getFullYear();
    fs.writeFileSync(csvPath, `First Name,Last Name,DOB,Association Number,Gender,Current Rank,${header}\n` + [
      `One,Test,01/01/${year - 14},TSD-001,Male,G10,Y`,
      `Two,Test,01/01/${year - 17},TSD-002,Male,CDB,Y`,
      `Three,Test,01/01/${year - 16},TSD-003,Female,G1,Y`,
      `Four,Test,01/01/${year - 18},TSD-004,Male,D1,Y`,
      `Five,Test,01/01/${year - 18},TSD-005,Male,G1,Y`,
      `Six,Test,01/01/${year - 14},TSD-006,Male,G10,N`
    ].join('\n'));
    await initializeDatabase(dbPath);
    const imported = await importCSV(csvPath, dbPath, { clearExisting: true, tournamentDate: '2027-01-16' });
    assert.equal(imported.normalizedCompetitors.filter((c) => c.specialNeeds === 1).length, 5);
    const store = createCompetitorStore(dbPath);
    const competitors = await store.loadCompetitors();
    const { buildGroups } = require('../backend/groupBuilder');
    const groups = buildGroups(competitors);
    assert.equal(groups.length, 5);
    assert.equal(groups.filter((g) => g.specialNeeds).length, 4);
    await store.saveDivisionAssignments(groups);
    const maleSpecial = competitors.filter((c) => c.gender === 'Male' && c.specialNeeds === 1);
    const manualGroups = groups.filter((g) => !g.competitors.some((c) => maleSpecial.some((member) => member.id === c.id)));
    manualGroups.push({ groupId: 'manual-special', name: 'Special Needs manual combination', competitors: maleSpecial });
    await store.saveDivisionAssignments(manualGroups);
    const saved = await store.loadCompetitors();
    assert.equal(saved.filter((c) => c.specialNeeds === 1).length, 5);
    assert.ok(saved.filter((c) => c.specialNeeds === 1).every((c) => c.groupDivisionName.startsWith('Special Needs')));
    assert.equal(new Set(saved.filter((c) => c.gender === 'Male' && c.specialNeeds === 1).map((c) => c.groupDivisionNumber)).size, 1);
    const spoofed = saved.filter((c) => ['One', 'Six'].includes(c.firstName)).map((c) => ({ ...c, specialNeeds: 0 }));
    await assert.rejects(store.saveDivisionAssignments([{ competitors: spoofed }]), { code: 'INVALID_DIVISION_GROUP' });
    assert.deepEqual((await store.loadCompetitors()).map((c) => c.groupDivisionNumber), saved.map((c) => c.groupDivisionNumber));
  });
}

test('Special Needs move restrictions and labels apply in Group Builder', async () => {
  const special = { ...savedCompetitor, specialNeeds: 1, dob: '01/01/2010' };
  const ordinary = { ...newCompetitor, specialNeeds: 0 };
  const page = await loadPage({
    competitors: [special, ordinary],
    groups: [
      { id: 'special', competitors: [special] },
      { id: 'ordinary', competitors: [ordinary] }
    ]
  });

  test('manual Special Needs drag accepts different ages and ranks but rejects other genders', async () => {
    const special = { ...savedCompetitor, specialNeeds: 1, dob: '01/01/2010' };
    const adult = { ...newCompetitor, specialNeeds: 1, rank: 'D1', age: 26, ageAsOf: '2027-01-16' };
    const female = { ...adult, id: 3, gender: 'Female' };
    const page = await loadPage({
      competitors: [special, adult, female],
      groups: [
        { id: 'source', competitors: [special] },
        { id: 'adult', competitors: [adult] },
        { id: 'female', competitors: [female] }
      ]
    });
    await page.openGroups();
    const banners = page.element('gbBanners');
    banners.handlers.click({
      target: { closest: (selector) => selector === '.gb-banner' ? { dataset: { id: 'source' } } : null }
    });
    const id = /data-comp="([^"]+)"/.exec(page.element('gdMembers').innerHTML)[1];
    page.element('gdMembers').handlers.dragstart({
      target: { closest: () => ({ dataset: { comp: id } }) },
      dataTransfer: { setData() {} }
    });
    for (const [target, expected] of [['female', false], ['adult', true]]) {
      let accepted = false;
      banners.handlers.dragover({
        target: { closest: () => ({ dataset: { id: target }, classList: { add() {} } }) },
        preventDefault() { accepted = true; },
        dataTransfer: {}
      });
      assert.equal(accepted, expected);
    }
    banners.handlers.drop({
      target: { closest: () => ({ dataset: { id: 'adult' } }) },
      preventDefault() {}
    });
    assert.match(banners.innerHTML, /Mixed ranks - Mixed age bands/);
    await page.click('gbSaveBtn');
    assert.equal(page.element('gbSaveBtn').classList.contains('primary'), false);
    assert.deepEqual(page.errors, []);
  });
  await page.openGroups();
  assert.match(page.element('gbBanners').innerHTML, /Special Dragons - Gup - 13-17/);
  assert.match(page.element('gbStats').innerHTML, /Special Dragons: <strong>1/);
  page.element('gbBanners').handlers.click({
    target: { closest: (selector) => selector === '.gb-banner' ? { dataset: { id: 'special' } } : null }
  });
  assert.match(page.element('gdMembers').innerHTML, /Special Dragons/);
  const id = /data-comp="([^"]+)"/.exec(page.element('gdMembers').innerHTML)[1];
  page.element('gdMembers').handlers.dragstart({
    target: { closest: () => ({ dataset: { comp: id } }) },
    dataTransfer: { setData() {} }
  });
  let accepted = false;
  page.element('gbBanners').handlers.dragover({
    target: { closest: () => ({ dataset: { id: 'ordinary' } }) },
    preventDefault() { accepted = true; },
    dataTransfer: {}
  });
  assert.equal(accepted, false);
  assert.deepEqual(page.errors, []);
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

test('empty divisions distinguish new cards from previously populated draft cards', async () => {
  const page = await loadPage({
    competitors: [savedCompetitor],
    draft: { eventName: winter, groups: [
      { id: 'new', competitors: [] },
      { id: 'used', hasHadCompetitors: true, competitors: [] }
    ] }
  });
  await page.openGroups();
  const html = page.element('gbBanners').innerHTML;
  assert.match(html, /gb-banner new-empty[^"]*" data-id="new"/);
  assert.match(html, /New - awaiting competitors/);
  assert.match(html, /gb-banner emptied[^"]*" data-id="used"/);
  assert.match(html, /Emptied/);
});

test('removing the last competitor marks a division emptied rather than new', async () => {
  const page = await loadPage({
    competitors: [savedCompetitor],
    groups: [{ id: '20', competitors: [savedCompetitor] }]
  });
  await page.openGroups();
  page.element('gbBanners').handlers.click({
    target: { closest: (selector) => selector === '.gb-banner' ? { dataset: { id: '20' } } : null }
  });
  const id = /data-comp="([^"]+)"/.exec(page.element('gdMembers').innerHTML)[1];
  page.element('gdMembers').handlers.click({
    target: { closest: (selector) => selector === '.gd-row'
      ? { dataset: { comp: id } } : selector === '[data-unassign]' ? {} : null }
  });
  assert.match(page.element('gbBanners').innerHTML, /gb-banner emptied selected/);
  assert.match(page.element('gdMembers').innerHTML, /This division is now empty/);
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
  assert.equal(fallback.element('workspaceTitle').textContent, 'Tournaments');
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
  assert.match(page.element('tournamentListBody').innerHTML, /Active/);
  await page.select(spring);
  assert.equal(page.element('bannerEventName').textContent, spring);
  assert.equal(page.element('bannerEventDate').textContent, '2027-04-10');
  assert.equal(page.element('bannerEventStatus').textContent, 'Active');
  await page.click('resetEventBtn');
  assert.equal(page.element('bannerEventName').textContent, spring);
  assert.equal(page.element('bannerEventDate').textContent, '2027-04-10');
  assert.equal(page.element('bannerEventStatus').textContent, 'Active');
});

test('day-of banner uses active event and date across all day-of sections, not selected drafts', async () => {
  const page = await loadPage({
    activeEvent: spring,
    draft: { eventName: winter, groups: [] }
  });
  assert.equal(page.element('bannerEventStatus').textContent, 'Unsaved changes');
  for (const id of ['ring-assignment', 'head-table']) {
    await page.openDayOf(id);
    assert.equal(page.element('bannerEventLabel').textContent, 'Active Event:');
    assert.equal(page.element('bannerEventName').textContent, spring);
    assert.equal(page.element('bannerEventDate').textContent, '2027-04-10');
    assert.equal(page.element('bannerEventStatus').textContent, 'Active');
    assert.equal(page.element('bannerMetadata').getAttribute('aria-label'), 'Active event metadata');
  }
  await page.navigate('judge-assignments');
  assert.equal(page.element('bannerEventLabel').textContent, 'Selected Event:');
  assert.equal(page.element('bannerEventName').textContent, winter);
  assert.equal(page.element('bannerEventDate').textContent, '2027-01-16');
  assert.equal(page.element('tournamentReferenceLabel').textContent, 'Tournament for this page');
  await page.openDayOf('competitors');
  assert.equal(page.element('bannerEventLabel').textContent, 'Selected Event:');
  assert.equal(page.element('bannerEventName').textContent, winter);
  assert.equal(page.element('tournamentReferenceSelect').value, winter);
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
  assert.match(page.element('placeholderMessage').textContent, /No active tournament/);
  page.setActiveEvent(spring);
  await page.refreshDayOf();
  assert.equal(page.element('bannerEventName').textContent, spring);
  page.failActiveEvent();
  await page.openDayOf();
  assert.equal(page.element('bannerEventStatus').textContent, 'Unavailable');
  assert.equal(page.element('bannerEventDate').textContent, '2027-04-10');
  assert.match(page.element('placeholderMessage').textContent, /Unable to load active event/);
  const noActive = await loadPage();
  await noActive.openDayOf();
  assert.equal(noActive.element('workspaceTitle').textContent, 'Division Assignments');
  assert.equal(noActive.nav('ring-assignment').getAttribute('aria-disabled'), 'false');
  assert.equal(noActive.element('tournamentReferenceSelect').hidden, false);
  assert.equal(noActive.requests.some((request) => request.path === '/api/rings'), false);
});

test('integrated event metadata sends numeric dimensions, displays zero and blocks invalid input', async () => {
  const page = await loadPage();
  await page.openTournament();
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
  page.element('scopeInput').value = 'regional';
  page.element('ringConfigXInput').value = '4';
  page.element('ringConfigYInput').value = '5';
  await page.click('saveMetadataBtn');
  post = page.requests.filter((request) => request.init).at(-1);
  assert.equal(post.path, '/api/events/create');
  assert.equal(JSON.parse(post.init.body).ringConfigX, 4);
  assert.equal(JSON.parse(post.init.body).ringConfigY, 5);
  assert.equal(page.element('bannerEventName').textContent, 'New Event');
  assert.equal(page.element('bannerEventDate').textContent, 'Not set');

  await page.openTournament();
  const beforeInvalidSave = page.requests.filter((request) => request.init).length;
  page.element('ringConfigXInput').checkValidity = () => false;
  await page.click('saveMetadataBtn');
  assert.equal(page.requests.filter((request) => request.init).length, beforeInvalidSave);
  assert.match(page.element('notice').textContent, /whole numbers/);
});

test('event format is saved, loaded and counted as an unsaved change', async () => {
  const page = await loadPage();
  await page.openTournament();
  assert.equal(page.element('tournamentDaysInput').value, '1');
  page.element('tournamentDaysInput').value = '2';
  await page.input('tournamentDaysInput', 'change');
  assert.equal(page.element('bannerEventStatus').textContent, 'Unsaved changes');
  await page.click('saveMetadataBtn');
  const post = page.requests.filter((request) => request.init).at(-1);
  assert.equal(post.path, '/api/events/modify');
  assert.equal(JSON.parse(post.init.body).tournamentDays, 2);
  await page.openTournament();
  assert.equal(page.element('tournamentDaysInput').value, '2');
  assert.notEqual(page.element('bannerEventStatus').textContent, 'Unsaved changes');
});

test('new tournaments require an event type and show its sanctioning policy', async () => {
  const page = await loadPage();
  await page.click('createEventBtn');
  page.element('eventNameInput').value = 'No Event Type';
  await page.click('saveMetadataBtn');
  assert.match(page.element('notice').textContent, /Select an event type/);
  assert.equal(page.requests.some((request) => request.path === '/api/events/create'), false);
  assert.match(html, /id="scopeInput" required/);
  assert.match(html, /Regional, National, and World events are sanctioned\. In-House events are unsanctioned\./);
});

test('tournament list opens a center-workspace form with honest scope and live ring count', async () => {
  const page = await loadPage({ activeEvent: winter });
  assert.equal(page.element('workspaceTitle').textContent, 'Tournaments');
  assert.match(page.element('tournamentListBody').innerHTML, /data-edit-tournament=/);
  assert.match(page.element('tournamentListBody').innerHTML, /Regional \(Sanctioned\)/);
  assert.doesNotMatch(html, /id="eventSelect"|id="modifyEventBtn"|id="activeEventChip"/);
  await page.openTournament();
  assert.equal(page.element('tournamentList').hidden, true);
  assert.equal(page.element('detailsPanel').hidden, true);
  assert.equal(page.element('metadataPanel').hidden, false);
  assert.equal(page.element('scopeInput').value, 'regional');
  assert.equal(page.element('eventNameInput').disabled, true);
  page.element('scopeInput').value = 'in-house';
  page.element('ringConfigXInput').value = '4';
  page.element('ringConfigYInput').value = '4';
  await page.input('ringConfigXInput', 'input');
  assert.equal(page.element('ringCountSummary').textContent, '4 × 4 = 16 rings');
  assert.equal(page.element('bannerEventStatus').textContent, 'Unsaved changes');
  await page.navigate('results');
  assert.equal(page.element('eventSetupView').hidden, false);
  assert.match(page.confirmations.at(-1), /Discard unsaved tournament details/);
  await page.click('resetEventBtn');
  assert.equal(page.element('metadataPanel').hidden, false);
  await page.click('saveMetadataBtn');
  const save = page.requests.find((request) => request.path === '/api/events/modify');
  assert.equal(JSON.parse(save.init.body).scope, 'in-house');
  assert.equal(page.element('tournamentList').hidden, false);
  assert.match(page.element('tournamentListBody').innerHTML, /In-House/);
  assert.equal(page.requests.some((request) => request.path === '/api/events/activate'), false);
});

test('new tournament opens an empty workspace and failed save retains scope and edits', async () => {
  const page = await loadPage({ failEventSave: true });
  await page.click('createEventBtn');
  assert.equal(page.element('workspaceTitle').textContent, 'Create Tournament');
  assert.equal(page.element('eventNameInput').value, '');
  assert.equal(page.element('eventNameInput').disabled, false);
  assert.equal(page.element('tournamentSavedActions').hidden, true);
  assert.match(page.element('ringCountSummary').textContent, /0 × 0 = 0 rings \(Unconfigured\)/);
  page.element('eventNameInput').value = 'New Scope Event';
  await page.input('eventNameInput', 'input');
  page.element('scopeInput').value = 'world';
  page.element('locationInput').value = 'New venue';
  await page.click('saveMetadataBtn');
  assert.equal(page.element('scopeInput').value, 'world');
  assert.equal(page.element('locationInput').value, 'New venue');
  assert.equal(page.element('metadataPanel').hidden, false);
  assert.match(page.element('notice').textContent, /Save unavailable/);
  assert.equal(JSON.parse(page.requests.find((request) => request.path === '/api/events/create').init.body).scope, 'world');
});

test('tournament list and per-row metadata loading failures are explicit', async () => {
  const failed = await loadPage({ failEventList: true });
  assert.match(failed.element('tournamentListBody').innerHTML, /Unable to load tournaments: Tournament list unavailable/);
  const partial = await loadPage({ failEventMetadata: spring });
  assert.match(partial.element('tournamentListBody').innerHTML, /Unable to load metadata: Metadata unavailable/);
  assert.match(partial.element('tournamentListBody').innerHTML, /Winter Tournament 2027/);
});

test('browser history cancellation preserves tournament edits without repeated prompts', async () => {
  const page = await loadPage();
  await page.navigate('results');
  await page.navigate('event-setup');
  await page.openTournament();
  page.element('scopeInput').value = 'in-house';
  const current = page.location.href;
  await page.history(-1);
  assert.equal(page.location.href, current);
  assert.equal(page.element('scopeInput').value, 'in-house');
  assert.equal(page.element('metadataPanel').hidden, false);
  assert.equal(page.confirmations.length, 1);
});

const orderedGroups = [
  { groupDivisionNumber: 51, name: 'Gup older', competitors: [{ ...savedCompetitor, rank: 'G1', age: 9, gender: 'Female' }] },
  { groupDivisionNumber: 42, name: 'TT older', competitors: [{ ...savedCompetitor, rank: 'TTLD', age: 7 }] },
  { groupDivisionNumber: 31, name: 'BB younger', competitors: [{ ...savedCompetitor, rank: 'D1', age: 14 }] },
  { groupDivisionNumber: 50, name: 'Gup younger', competitors: [{ ...savedCompetitor, rank: 'G1', age: 8 }] },
  { groupDivisionNumber: 41, name: 'Special Needs', specialNeeds: true, competitors: [{ ...savedCompetitor, specialNeeds: 1, age: 6, gender: 'Female' }] },
  { groupDivisionNumber: 40, name: 'TT younger', competitors: [{ ...savedCompetitor, rank: 'TTLD', age: 5 }] },
  { groupDivisionNumber: 30, name: 'BB older', competitors: [{ ...savedCompetitor, rank: 'D1', age: 17 }, { ...savedCompetitor, rank: 'D1', age: 12 }] }
];
const shownDivisions = (page) => [...page.element('raDivisions').innerHTML.matchAll(/data-ra-division="(\d+)"/g)].map((match) => match[1]);

test('available division filters are multi-select, visibility-only and keep running order and mixed ages', async () => {
  const page = await loadPage({ activeEvent: winter, groups: orderedGroups, rings: [{ ...ringA1 }] });
  await page.openDayOf();
  assert.deepEqual(shownDivisions(page), ['31', '30', '40', '41', '42', '50', '51']);
  const filters = page.element('raFilters').innerHTML;
  for (const label of ['All (7)', 'BB (2)', 'TT (2)', 'SD (1)', 'Gup (2)']) assert.match(filters, new RegExp(label.replace(/[()]/g, '\\$&')));
  assert.match(page.element('raDivisions').innerHTML, /Mixed ages 12-17/);
  assert.equal((page.element('raDivisions').innerHTML.match(/Mixed ages/g) || []).length, 1);
  const writes = () => page.requests.filter((request) => request.init);
  const before = writes().length;
  await page.ringAction('raFilters', { raFilter: 'Gup' });
  assert.deepEqual(shownDivisions(page), ['50', '51']);
  await page.ringAction('raFilters', { raFilter: 'BB' });
  assert.deepEqual(shownDivisions(page), ['31', '30', '50', '51']);
  assert.match(page.element('raFilters').innerHTML, /data-ra-filter="All" aria-pressed="false"/);
  await page.ringAction('raFilters', { raFilter: 'Gup' });
  await page.ringAction('raFilters', { raFilter: 'BB' });
  assert.match(page.element('raFilters').innerHTML, /data-ra-filter="All" aria-pressed="true"/);
  assert.deepEqual(shownDivisions(page), ['31', '30', '40', '41', '42', '50', '51']);
  await page.ringAction('raFilters', { raFilter: 'SD' });
  await page.ringAction('raFilters', { raFilter: 'All' });
  assert.equal(shownDivisions(page).length, 7);
  assert.equal(writes().length, before);
});

test('two-day events mark locked Day 2 divisions, show the format in the banner and explain it in Event Setup', async () => {
  const page = await loadPage({ activeEvent: winter, groups: orderedGroups, rings: [{ ...ringA1 }],
    schedule: { tournamentDays: 2, currentDay: 1, day1Complete: false, day2Started: false } });
  await page.openDayOf();
  await page.ringAction('raFilters', { raFilter: 'All' });
  const markup = page.element('raDivisions').innerHTML;
  assert.match(markup, /ra-day2-locked/);
  assert.match(markup, /draggable="false"[^>]*data-ra-division="40"/);
  assert.match(markup, /Day 2 &middot; locked/);
  assert.doesNotMatch(markup.match(/<button[^>]*data-ra-division="30"[^>]*>/)[0], /ra-day2-locked/);
  assert.equal(page.element('tournamentDaysHint').textContent.includes('All divisions run in one continuous event'), true);
  page.element('tournamentDaysInput').value = '2';
  await page.input('tournamentDaysInput', 'change');
  assert.match(page.element('tournamentDaysHint').textContent, /Day 2 \(TT\/SD\/Gup\) stays locked/);
});

test('schedule summary covers one-day and two-day Day 2 guards', async () => {
  const oneDay = await loadPage({ activeEvent: winter, groups: orderedGroups, rings: [{ ...ringA1 }] });
  await oneDay.openDayOf();
  assert.equal(oneDay.element('raScheduleSummary').hidden, false);
  assert.match(oneDay.element('raScheduleSummary').innerHTML, /One-day event/);
  assert.match(oneDay.element('raScheduleSummary').innerHTML, /BB oldest first &middot; TT\/SD then Gup youngest first/);
  assert.match(oneDay.element('raScheduleSummary').innerHTML, /data-ra-event-setup/);
  assert.doesNotMatch(oneDay.element('raScheduleSummary').innerHTML, /Start Day 2/);

  const options = { activeEvent: winter, groups: orderedGroups, rings: [{ ...ringA1 }],
    schedule: { tournamentDays: 2, currentDay: 1, day1Complete: false, day2Started: false } };
  const page = await loadPage(options);
  await page.openDayOf();
  assert.match(page.element('raScheduleSummary').innerHTML, /Two-day event &middot; Day 1 \(BB\)/);
  assert.match(page.element('raScheduleSummary').innerHTML, /Day 2 is locked until every BB division is complete/);
  assert.match(page.element('raScheduleSummary').innerHTML, /disabled>Start Day 2/);
  assert.match(page.element('raFilters').innerHTML, /data-ra-filter="BB" aria-pressed="true"/);
  assert.match(page.element('raFilters').innerHTML, /data-ra-filter="All" aria-pressed="false"/);
  const writes = () => page.requests.filter((request) => request.init);
  let before = writes().length;
  await page.ringAction('raScheduleSummary', { raStartDay2: '' });
  assert.equal(writes().length, before);
  await page.ringAction('raRings', { raRing: 'ring-a-1' });
  before = writes().length;
  await page.ringAction('raDivisions', { raDivision: '40' });
  assert.equal(writes().length, before);
  assert.match(page.element('raNotice').textContent, /Day 2 divisions cannot be assigned/);
  await page.ringAction('raDivisions', { raDivision: '30' });
  assert.equal(writes().length, before + 1);

  options.schedule = { ...options.schedule, day1Complete: true };
  await page.click('raRefreshBtn');
  assert.match(page.element('raScheduleSummary').innerHTML, /Day 2 is ready to start/);
  assert.doesNotMatch(page.element('raScheduleSummary').innerHTML, /disabled>Start Day 2/);
  before = writes().length;
  await page.ringAction('raScheduleSummary', { raStartDay2: '' });
  assert.match(page.confirmations.at(-1), /Start Day 2/);
  assert.equal(writes().length, before);
});

test('Start Day 2 posts after confirmation and simulator view stays read-only', async () => {
  const options = { activeEvent: winter, groups: orderedGroups, rings: [{ ...ringA1 }], confirm: true,
    schedule: { tournamentDays: 2, currentDay: 1, day1Complete: true, day2Started: false } };
  const page = await loadPage(options);
  await page.openDayOf();
  await page.ringAction('raScheduleSummary', { raStartDay2: '' });
  const post =   page.requests.filter((request) => request.init).at(-1);
  assert.equal(post.path, '/api/rings/schedule/day2');
  assert.equal(post.init.method, 'POST');
  assert.match(page.element('raScheduleSummary').innerHTML, /Day 2 in progress/);
  assert.doesNotMatch(page.element('raScheduleSummary').innerHTML, /Start Day 2/);

  const runId = 'day-break-run';
  const sim = await loadPage({
    activeEvent: winter, groups: orderedGroups, rings: [{ ...ringA1 }], confirm: true,
    simulatorRuns: [{ runId, sourceEventName: 'Rehearsal', status: 'day-break' }],
    simulatorBoard: { eventName: 'SIMULATION - rehearsal', simulatorStatus: 'day-break', groups: orderedGroups, rings: [{ ...ringA1 }],
      availableGroupDivisionNumbers: orderedGroups.map((group) => String(group.groupDivisionNumber)),
      ringConfig: { letterCount: 1, numberCount: 1 },
      schedule: { tournamentDays: 2, currentDay: 1, day1Complete: true, day2Started: false } }
  });
  await sim.openDayOf();
  sim.element('raSourceRun').value = runId;
  await sim.input('raSourceRun', 'change');
  assert.match(sim.element('raScheduleSummary').innerHTML, /Read-only/);
  assert.doesNotMatch(sim.element('raScheduleSummary').innerHTML, /Start Day 2/);
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
  assert.match(markup, /class="ra-division-label">Division 22 - Queued division<br>/);
  assert.match(markup, /data-ra-group="20"[^>]* aria-expanded="false"[^>]*>Show competitors<\/button>/);
  assert.match(markup, /data-ra-group="22"[^>]*>Show competitors<\/button>/);
  assert.doesNotMatch(markup, /ra-link/);
  await page.ringAction('ringAssignmentDetails', { raGroup: '22' });
  markup = page.element('ringAssignmentDetails').innerHTML;
  assert.match(markup, /data-ra-group="22"[^>]* aria-expanded="true"[^>]*>Hide competitors<\/button>/);
  assert.match(markup, /data-ra-group="20"[^>]*>Show competitors<\/button>/);
  assert.match(markup, /Saved Competitor/);
  await page.ringAction('ringAssignmentDetails', { raGroup: '22' });
  markup = page.element('ringAssignmentDetails').innerHTML;
  assert.match(markup, /data-ra-group="22"[^>]* aria-expanded="false"[^>]*>Show competitors<\/button>/);
  assert.doesNotMatch(markup, /Saved Competitor|Showing competitors|class="danger"/);
  assert.match(markup, /class="ra-ring-maintenance"/);
  assert.match(markup, /target="_blank" rel="noopener" href="\/tablet-pairing\/\?ring=ring-a-1">Daily tablet QR code<\/a>/);
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
  for (const card of cards()) {
    assert.equal((card.match(/class="ra-ring-line"/g) || []).length, 2, 'ring information occupies two compact lines');
    assert.match(card, /ra-ring-line"><strong>Ring [^<]+<\/strong><span class="ra-connection">/);
    assert.match(card, /ra-ring-line"><span class="ra-assignment"[^>]*>[^<]+<\/span><span class="ra-meta">\d+ queued<\/span>/);
  }
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
  assert.equal(page.element('raNotice').textContent, '');
  assert.equal(page.element('raNotice').className, 'notice');
  await page.ringAction('ringAssignmentDetails', { raRemove: '20' });
  assert.match(page.element('raDivisions').innerHTML, /data-ra-division="20"/);
  assert.equal(page.element('raNotice').className, 'notice');
  await page.ringAction('raRings', { raRing: 'ring-a-1' }, { event: 'drop', divisionId: '20' });
  assert.doesNotMatch(page.element('raDivisions').innerHTML, /data-ra-division="20"/);
  assert.equal(page.element('raNotice').className, 'notice');
  await page.ringAction('ringAssignmentDetails', {}, { reset: true });
  assert.match(page.confirmations.at(-1), /Reset this ring/);
  assert.match(page.element('raDivisions').innerHTML, /data-ra-division="20"/);
  assert.equal(page.element('raNotice').textContent, '');
  assert.equal(page.element('raNotice').className, 'notice');
});

test('ring assignment direct link, search, empty state, errors and event switching stay scoped', async () => {
  const page = await loadPage({
    search: '?view=ring-assignment', activeEvent: winter, rings: [{ ...ringA1 }],
    groupsByEvent: { [winter]: [division20], [spring]: [] }
  });
  await settle();
  assert.equal(page.element('ringAssignmentView').hidden, false);
  await page.ringAction('raFilters', { raFilter: 'TT' });
  assert.doesNotMatch(page.element('raDivisions').innerHTML, /data-ra-division/);
  assert.match(page.element('raFilters').innerHTML, /data-ra-filter="TT" aria-pressed="true"/);
  await page.ringAction('raFilters', { raFilter: 'All' });
  assert.match(page.element('raDivisions').innerHTML, /data-ra-division="20"/);
  await page.ringAction('raRings', { raRing: 'ring-a-1' });
  page.setActiveEvent(spring);
  await page.click('raRefreshBtn');
  assert.equal(page.element('detailsPanel').hidden, true);
  assert.equal(page.element('raEvent').textContent, spring);
  assert.match(page.element('raDivisions').innerHTML,
    /No saved division configuration for Spring Tournament 2027\. Open Divisions, build and save groups for this tournament, then refresh Ring Assignment\./);
  page.setActiveEvent('');
  await page.click('raRefreshBtn');
  assert.match(page.element('raNotice').textContent, /No active tournament/);
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

test('opening Ring Assignment never applies a destructive layout and Event Setup uses a single save', async () => {
  const page = await loadPage({ activeEvent: spring, rings: [{ ...ringA1 }], confirm: true });
  await page.openDayOf();
  assert.equal(page.requests.some((request) => request.path === '/api/rings/config'), false);
  assert.doesNotMatch(html, /id="raLayoutBtn"|id="applyEventRingLayoutBtn"/);
  await page.select(spring);
  await page.openTournament();
  page.element('ringConfigXInput').value = '4';
  await page.click('saveMetadataBtn');
  const save = page.requests.find((request) => request.path === '/api/events/modify');
  assert.equal(JSON.parse(save.init.body).ringConfigX, 4);
  assert.equal(page.requests.some((request) => request.path === '/api/rings/config'), false);
});

test('all event settings lock together and confirmed reset run unlocks them', async () => {
  const page = await loadPage({ activeEvent: winter, selectedEvent: spring, configurationLocked: true, confirm: true });
  await page.openTournament();
  for (const id of ['locationInput', 'scopeInput', 'dateInput', 'tournamentDaysInput', 'ringConfigXInput', 'ringConfigYInput', 'saveMetadataBtn']) {
    assert.equal(page.element(id).disabled, true, id);
  }
  assert.match(page.element('eventConfigurationHelp').textContent, /locked/);
  assert.equal(page.element('deleteEventBtn').disabled, false);
  assert.equal(page.element('resetRunBtn').disabled, false);
  assert.equal(page.element('eventNameInput').disabled, true);
  await page.click('resetRunBtn');
  assert.match(page.confirmations.at(-1), /Stop all tablet activity/);
  assert.match(page.confirmations.at(-1), /Results and ring state will be archived/);
  const reset = page.requests.find((request) => request.path === '/api/events/reset-run');
  assert.deepEqual(JSON.parse(reset.init.body), { eventName: spring, confirm: true });
  for (const id of ['locationInput', 'scopeInput', 'dateInput', 'tournamentDaysInput', 'ringConfigXInput', 'ringConfigYInput', 'saveMetadataBtn']) {
    assert.equal(page.element(id).disabled, false, id);
  }
  assert.match(page.element('notice').textContent, /run-archives\/test-run/);
});

test('cancelled reset run makes no request and leaves configuration locked', async () => {
  const page = await loadPage({ selectedEvent: spring, configurationLocked: true });
  await page.openTournament();
  await page.click('resetRunBtn');
  assert.equal(page.requests.some((request) => request.path === '/api/events/reset-run'), false);
  assert.equal(page.element('saveMetadataBtn').disabled, true);
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
  await page.openDayOf('head-table');
  assert.equal(page.element('headTableView').hidden, false);
  assert.equal(page.element('placeholderView').hidden, true);
  assert.equal(page.element('workspaceTitle').textContent, 'Head Table');
  assert.equal(page.element('bannerEventName').textContent, spring);
  assert.equal(new URLSearchParams(page.location.search).get('view'), 'head-table');
  const summary = page.element('htSummary').innerHTML;
  const divisions = summary.match(/aria-label="Division counts">([\s\S]*?)<\/div>/)[1];
  const ringGroup = summary.match(/aria-label="Ring counts">([\s\S]*?)<\/div>/)[1];
  assert.deepEqual([...divisions.matchAll(/class="ht-count">(\w[\w ]*) <strong>(\d+)/g)].map((match) => [match[1], Number(match[2])]),
    [['Unassigned', 2], ['Queued', 1], ['Active', 1], ['Completed', 1]]);
  assert.match(divisions, /<strong>1 of 5<\/strong> completed/);
  assert.match(divisions, /style="width: 20%"/);
  assert.match(ringGroup, /Rings \(2\)/);
  assert.match(ringGroup, /class="ht-count">Connected <strong>1/);
  assert.match(ringGroup, /class="ht-count warning">Disconnected <strong>1/);
  assert.match(ringGroup, /class="ht-count">Assistance <strong>0/);
  assert.doesNotMatch(summary, /Available|<button|chip/);
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
  await page.openDayOf('head-table');
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
  await page.openDayOf('head-table');
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
  await page.openDayOf('head-table');
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
  await page.openDayOf('head-table');
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
  await page.openDayOf('head-table');
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
  assert.match(page.element('htSummary').innerHTML, /<strong>0 of 0<\/strong> completed/);
  page.setActiveEvent('');
  await page.click('htRefreshBtn');
  assert.match(page.element('htNotice').textContent, /No active tournament/);
  assert.doesNotMatch(page.element('htRings').innerHTML, /data-ht-ring/);
  const unavailable = await loadPage({ activeEvent: spring });
  await unavailable.openDayOf('head-table');
  unavailable.failActiveEvent();
  await unavailable.click('htRefreshBtn');
  assert.equal(unavailable.element('bannerEventStatus').textContent, 'Unavailable');
  assert.match(unavailable.element('htSummary').innerHTML, /totals unavailable/);
});

test('Head Table clears assistance only after confirmation, scopes requests and displays errors', async () => {
  for (const confirm of [false, true]) {
    const now = new Date().toISOString();
    const page = await loadPage({ activeEvent: winter, confirm, rings: [{ ...ringA1, assistanceType: 'medical', assistanceRequestedAt: now }] });
    await page.openDayOf('head-table');
    assert.match(page.element('htSummary').innerHTML, /class="ht-count warning">Assistance <strong>1/);
    assert.match(page.element('htSummary').innerHTML, /class="ht-count">Disconnected <strong>0/);
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
  await failed.openDayOf('head-table');
  await failed.ringAction('htRings', { htRing: 'ring-a-1' });
  await failed.ringAction('headTableDetails', {}, { clear: true });
  assert.match(failed.element('htNotice').textContent, /Unable to clear assistance: Clear failed/);
  assert.match(failed.element('headTableDetails').innerHTML, /data-ht-clear/);
});

test('leaving Head Table ignores late board responses and cancels its polling', async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const page = await loadPage({ activeEvent: winter, waitForGroups: waiting, rings: [{ ...ringA1 }] });
  await page.openDayOf('head-table');
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
  await page.openDayOf('head-table');
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
    await page.openDayOf('head-table');
    await page.ringAction('htRings', { htRing: 'ring-a-1' });
    if (change === 'event') page.setActiveEvent(spring);
    else ring.assistanceRequestedAt = 'replacement-request';
    await page.ringAction('headTableDetails', {}, { clear: true });
    assert.match(page.element('htNotice').textContent, /Unable to clear assistance: The (active event|assistance request) changed/);
    assert.equal(ring.assistanceType, 'general');
  }
});

function estimationFixture() {
  const now = Date.now();
  const groups = [division20, { ...division20, groupDivisionNumber: 22 }, { ...division20, groupDivisionNumber: 24 }];
  const rings = [{
    ...ringA1, tabletLabel: 'Tablet', lastHeartbeatAt: new Date(now).toISOString(),
    groupDivisionNumber: '20', queuedGroupDivisionNumbers: ['22'],
    assignmentStartedAt: new Date(now - 2 * 60000).toISOString(),
    phasePlan: { phases: [
      { key: 'setup', state: 'complete', progress: 100 }, { key: 'hyungs', state: 'active', progress: 0 },
      { key: 'sparring', state: 'upcoming', progress: 0 }, { key: 'awards', state: 'upcoming', progress: 0 }
    ] }
  }];
  return { activeEvent: winter, selectedEvent: spring, groups, rings,
    estimates: buildEstimates({ eventName: winter, groups, rings, now }) };
}

test('available division badges and Special Dragons descriptions preserve saved data', async () => {
  const groups = [
    { groupDivisionNumber: 20, name: 'Tiny Tiger', competitors: [{ ...savedCompetitor, rank: 'TTLD' }] },
    { groupDivisionNumber: 22, name: 'Special Needs Male Gup', specialNeeds: true,
      competitors: [{ ...savedCompetitor, specialNeeds: 1 }] },
    { groupDivisionNumber: 24, name: 'Gup', competitors: [{ ...savedCompetitor, rank: 'CDB' }] },
    { groupDivisionNumber: 26, name: 'Black Belt', competitors: [
      { ...savedCompetitor, rank: 'D1' }, { ...savedCompetitor, rank: 'CDB' }
    ] }
  ];
  const before = JSON.stringify(groups);
  const page = await loadPage({ activeEvent: winter, groups, rings: [ringA1] });
  await page.openDayOf();
  const markup = page.element('raDivisions').innerHTML;
  for (const badge of ['TT', 'SD', 'Gup', 'BB']) assert.match(markup, new RegExp(`>${badge}</span>`));
  assert.match(markup, /Special Dragons Male Gup/);
  assert.doesNotMatch(markup, /Special Needs/);
  assert.equal(JSON.stringify(groups), before);
});

test('Ring Assignment simulation is isolated, read-only and follows source selection', async () => {
  const runId = 'test-simulation';
  const simulation = {
    eventName: 'SIMULATION - rehearsal', simulatorStatus: 'running', groups: [division20],
    rings: [{ ...ringA1, queuedGroupDivisionNumbers: ['20'] }],
    availableGroupDivisionNumbers: ['20'], ringConfig: { letterCount: 1, numberCount: 1 },
    estimates: { version: 1, eventName: 'SIMULATION - rehearsal', status: 'unavailable', reason: 'Paused',
      generatedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 30000).toISOString(),
      rings: [], unassigned: [{ groupDivisionNumber: '20', durationMs: 300000, status: 'unavailable' }] }
  };
  const page = await loadPage({
    activeEvent: winter, groups: [division20], rings: [ringA1], confirm: true,
    simulatorRuns: [{ runId, sourceEventName: 'Rehearsal', status: 'running' }],
    simulatorBoard: simulation
  });
  await page.openDayOf();
  page.element('raSourceRun').value = runId;
  await page.input('raSourceRun', 'change');
  assert.match(page.element('raSimulationNotice').textContent, /SIMULATION - READ ONLY/);
  assert.equal(page.element('raEvent').textContent, simulation.eventName);
  assert.match(page.element('raDivisions').innerHTML, /draggable="false"/);
  assert.match(page.element('raDivisions').innerHTML, /Ring ~5 real min/);
  assert.match(page.element('raDivisions').innerHTML, /Start TBD/);
  await page.ringAction('raRings', { raRing: 'ring-a-1' });
  assert.doesNotMatch(page.element('ringAssignmentDetails').innerHTML, /data-ra-remove|data-ra-reset|tablet-pairing/);
  const writes = () => page.requests.filter((request) => request.init && request.init.method !== 'GET');
  const before = writes().length;
  await page.ringAction('raDivisions', { raDivision: '20' });
  await page.ringAction('ringAssignmentDetails', { raRemove: '20' });
  await page.ringAction('ringAssignmentDetails', {}, { reset: true });
  await page.ringAction('raRings', { raRing: 'ring-a-1' }, { event: 'drop', divisionId: '20' });
  await page.pointerAction('pointerdown');
  await page.pointerAction('pointerup', { ringId: 'ring-a-1' });
  assert.equal(writes().length, before);
  await page.ringAction('ringAssignmentDetails', { raGroup: '20' });
  assert.match(page.element('ringAssignmentDetails').innerHTML, /ra-members/);
  simulation.simulatorStatus = 'paused';
  await page.click('raRefreshBtn');
  assert.match(page.element('raSimulationNotice').textContent, /paused/);
  page.element('raSourceRun').value = '';
  await page.input('raSourceRun', 'change');
  assert.equal(page.element('raEvent').textContent, winter);
  assert.equal(page.element('raSimulationNotice').hidden, true);
  assert.match(page.element('raDivisions').innerHTML, /draggable="true"/);
});

test('unavailable simulation clears the board without falling back to live data', async () => {
  const page = await loadPage({ activeEvent: winter, groups: [division20], rings: [ringA1],
    search: '?simulatorRunId=missing', failSimulation: true });
  await page.openDayOf();
  assert.match(page.element('raNotice').textContent, /Simulation unavailable/);
  assert.doesNotMatch(page.element('raRings').innerHTML, /data-ra-ring/);
  assert.equal(page.requests.some((request) => request.path === '/api/rings'), false);
  assert.equal(page.element('raSimulationNotice').hidden, false);
});

test('switching back to live ignores a late simulator response', async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const page = await loadPage({ activeEvent: winter, groups: [division20], rings: [ringA1],
    waitForSimulation: waiting,
    simulatorBoard: { eventName: 'SIMULATION - late', simulatorStatus: 'running', groups: [],
      rings: [], availableGroupDivisionNumbers: [] } });
  await page.openDayOf();
  page.element('raSourceRun').value = 'late';
  await page.input('raSourceRun', 'change');
  page.element('raSourceRun').value = '';
  await page.input('raSourceRun', 'change');
  release();
  await settle();
  await settle();
  assert.equal(page.element('raEvent').textContent, winter);
  assert.equal(page.element('raSimulationNotice').hidden, true);
  assert.match(page.element('raRings').innerHTML, /Ring A1/);
});

test('Ring Assignment and Head Table show the same queue start and completion windows for the active event', async () => {
  const fixture = estimationFixture();
  const page = await loadPage(fixture);
  await page.openDayOf();
  await page.ringAction('raRings', { raRing: 'ring-a-1' });
  const assignment = page.element('ringAssignmentDetails').innerHTML;
  assert.match(assignment, /Current completion: .+ \(approx\.\)/);
  assert.match(assignment, /Estimated start: .+ \(approx\.\)/);
  assert.match(assignment, /Ring free after queue: .+ \(approx\.\)/);
  assert.match(page.element('raDivisions').innerHTML, /Start ~[^<]+/);
  assert.match(page.element('raDivisions').innerHTML, /Ring ~25 min/);
  assert.doesNotMatch(page.element('raDivisions').innerHTML, /\btitle=|\bdata-help=|data-estimate-help-expiry/);
  assert.match(page.element('raEstimateSummary').innerHTML, /Next ring free after queue: A1/);
  await page.openDayOf('head-table');
  await page.ringAction('htRings', { htRing: 'ring-a-1' });
  const headTable = page.element('headTableDetails').innerHTML;
  assert.match(headTable, /Current completion: .+ \(approx\.\)/);
  assert.equal(headTable.match(/Estimated start: [^<]+/)[0], assignment.match(/Estimated start: [^<]+/)[0]);
  assert.match(headTable, /Low-confidence planning windows, not call times/);
  assert.equal(page.requests.some((request) => request.init), false, 'Predictions never schedule or write assignments');
});

test('simulator Head Table mirrors live timing with simulated completion, paused and complete states', async () => {
  const fixture = estimationFixture();
  const eventName = 'SIMULATION - rehearsal';
  const runId = 'timing-rehearsal';
  const simulation = {
    eventName, simulatorStatus: 'running', ...fixture,
    eventStartedAt: new Date(Date.now() - 60000).toISOString(),
    availableGroupDivisionNumbers: [], heartbeatPolicy: { disconnectAfterSeconds: 90 },
    estimates: buildEstimates({ eventName, ...fixture, now: Date.now() })
  };
  const page = await loadPage({
    ...fixture, activeEvent: winter,
    simulatorRuns: [{ runId, sourceEventName: 'Rehearsal', status: 'running' }],
    simulatorBoard: simulation
  });
  await page.openDayOf('head-table');
  page.element('htSourceRun').value = runId;
  await page.input('htSourceRun', 'change');
  assert.match(page.element('htSimulationNotice').textContent, /SIMULATION.*read-only/);
  assert.match(page.element('htEventTiming').innerHTML, /Event started <strong>(?!TBD)[^<]+/);
  assert.match(page.element('htEventTiming').innerHTML, /Est\. completion <strong>~/);
  assert.doesNotMatch(page.element('htEstimateSummary').textContent, /live-event planning estimates are not shown/);
  simulation.simulatorStatus = 'paused';
  simulation.estimates = { ...simulation.estimates, status: 'unavailable', reason: 'Simulator run is paused.' };
  await page.click('htRefreshBtn');
  assert.match(page.element('htEventTiming').innerHTML, /Est\. completion <strong>Unavailable/);
  assert.match(page.element('htEventTiming').innerHTML, /Simulator run is paused/);
  simulation.estimates = { ...simulation.estimates, status: 'ready',
    eventCompletion: { status: 'complete', reason: null, window: null } };
  await page.click('htRefreshBtn');
  assert.match(page.element('htEventTiming').innerHTML, /All divisions complete/);
  assert.equal(page.requests.some((request) => request.init && request.init.method !== 'GET'), false);
});

test('Ring Assignment and Head Table show event start and a held all-division completion estimate, TBD until start', async () => {
  const fixture = estimationFixture();
  let offset = 0;
  let started = '';
  const page = await loadPage({ ...fixture, eventStartedAt: () => started,
    estimates: () => buildEstimates({ eventName: winter, groups: fixture.groups, rings: fixture.rings, now: Date.now() + offset }) });
  await page.openDayOf();
  assert.match(page.element('raEventTiming').innerHTML, /Event started <strong>TBD<\/strong>[\s\S]*Est\. completion <strong>TBD<\/strong>/);
  started = new Date(Date.now() - 5 * 60000).toISOString();
  await page.refreshTimer();
  const first = page.element('raEventTiming').innerHTML;
  assert.doesNotMatch(first, /Event started <strong>TBD/);
  assert.match(first, /Est\. completion <strong>~[^<]+<\/strong><small>\([^)]+\)<\/small>/);
  assert.match(first, /including unassigned divisions/);
  fixture.rings[0].queuedGroupDivisionNumbers = ['22', '24'];
  await page.refreshTimer();
  assert.equal(page.element('raEventTiming').innerHTML, first, 'completion is held between minute refreshes');
  offset += 61000;
  await page.advanceTime(61000);
  await page.refreshTimer();
  assert.notEqual(page.element('raEventTiming').innerHTML.match(/~[^<]+/)[0], first.match(/~[^<]+/)[0]);
  await page.openDayOf('head-table');
  assert.match(page.element('htEventTiming').innerHTML, /Est\. completion <strong>~/);
  fixture.rings[0].tabletLabel = '';
  await page.refreshTimer();
  assert.match(page.element('htEventTiming').innerHTML, /Est\. completion <strong>Unavailable<\/strong>/);
  assert.match(page.element('htEventTiming').innerHTML, /Ring A1: No tablet connected/);
});

test('Day-of pages show a running current-time clock in the shared header', async () => {
  const page = await loadPage(estimationFixture());
  assert.notEqual(page.element('bannerClockTime').textContent, '');
  await page.openDayOf();
  assert.equal(page.element('bannerClock').hidden, false);
  const before = page.element('bannerClockTime').textContent;
  await page.advanceTime(60000);
  assert.notEqual(page.element('bannerClockTime').textContent, before);
});

test('predictions reject missing, stale, wrong-event and malformed snapshots and refresh failures explicitly', async () => {
  for (const invalid of ['missing', 'stale', 'event', 'shape', 'window', 'future']) {
    const fixture = estimationFixture();
    if (invalid === 'missing') fixture.estimates = null;
    if (invalid === 'stale') fixture.estimates.validUntil = new Date(Date.now() - 1).toISOString();
    if (invalid === 'event') fixture.estimates.eventName = spring;
    if (invalid === 'shape') fixture.estimates.unassigned = {};
    if (invalid === 'window') fixture.estimates.rings[0].availability.window.expectedAt = 'invalid';
    if (invalid === 'future') fixture.estimates.generatedAt = new Date(Date.now() + 60000).toISOString();
    const page = await loadPage(fixture);
    await page.openDayOf('head-table');
    await page.ringAction('htRings', { htRing: 'ring-a-1' });
    assert.match(page.element('headTableDetails').innerHTML, /Ring free after queue unavailable:/, invalid);
    assert.match(page.element('htEstimateSummary').innerHTML, /unavailable/i, invalid);
  }
  const page = await loadPage(estimationFixture());
  await page.openDayOf('head-table');
  await page.ringAction('htRings', { htRing: 'ring-a-1' });
  page.failRings();
  await page.click('htRefreshBtn');
  assert.match(page.element('headTableDetails').innerHTML, /Ring free after queue unavailable: Ring data could not be refreshed/);
});

test('expired prediction text and hover help are invalidated even when automatic board refresh stops', async () => {
  const fixture = estimationFixture();
  const text = element('Old projected time');
  text.setAttribute('data-estimate-expiry', fixture.estimates.validUntil);
  const help = element();
  help.setAttribute('title', 'Old projected time');
  help.setAttribute('data-help', 'Old projected time');
  help.setAttribute('data-estimate-help-expiry', fixture.estimates.validUntil);
  const tileStart = element('Est. start ~10:40 AM');
  tileStart.setAttribute('data-estimate-expiry', fixture.estimates.validUntil);
  tileStart.setAttribute('data-estimate-stale-text', 'Start TBD (stale)');
  const page = await loadPage({ ...fixture, estimateNodes: [text, help, tileStart] });
  await page.openDayOf();
  await page.advanceTime(31000);
  assert.match(text.textContent, /stale/);
  assert.match(help.getAttribute('data-help'), /stale/);
  assert.equal(help.hasAttribute('title'), false);
  assert.equal(help.hasAttribute('data-estimate-help-expiry'), false);
  assert.equal(tileStart.textContent, 'Start TBD (stale)');
});

test('available tile has exactly one additional estimate line, including planning-only starts and saved duration', async () => {
  const groups = [{ ...division20, competitors: Array.from({ length: 6 }, () => savedCompetitor) }];
  const rings = [{ ...ringA1 }];
  const estimates = buildEstimates({ eventName: winter, groups, rings });
  const page = await loadPage({ activeEvent: winter, groups, rings, estimates });
  await page.openDayOf();
  const markup = page.element('raDivisions').innerHTML;
  assert.equal((markup.match(/class="ra-division-estimate"/g) || []).length, 1);
  assert.match(markup, /Start ~/);
  assert.match(markup, /Ring ~42 min/);
  assert.doesNotMatch(markup, /\btitle=|\bdata-help=|data-estimate-help-expiry/);
  assert.match(page.element('raRings').innerHTML, /No tablet/);
  assert.match(page.element('raEstimateSummary').innerHTML, /planning only/);
  assert.match(html, /\.ra-division-estimate \{ white-space: nowrap;/);
  assert.match(html, /no hover is needed/);
});

test('available tile retains duration when start is unavailable and rejects malformed or stale predictions', async () => {
  for (const condition of ['no-rings', 'assistance', 'window', 'stale', 'event', 'missing-roster']) {
    const groups = [{ ...division20, competitors: condition === 'missing-roster' ? [] : [savedCompetitor] }];
    const rings = condition === 'no-rings' ? [] : [{ ...ringA1, assistanceType: condition === 'assistance' ? 'medical' : '' }];
    const estimates = buildEstimates({ eventName: winter, groups, rings });
    if (condition === 'window') estimates.unassigned[0].window.expectedAt = 'invalid';
    if (condition === 'stale') estimates.validUntil = new Date(Date.now() - 1).toISOString();
    if (condition === 'event') estimates.eventName = spring;
    const page = await loadPage({ activeEvent: winter, groups, rings, estimates });
    await page.openDayOf();
    const markup = page.element('raDivisions').innerHTML;
    assert.match(markup, /Start TBD/, condition);
    assert.match(markup, ['stale', 'event', 'missing-roster'].includes(condition) ? /Ring time TBD/ : /Ring ~25 min/, condition);
    assert.doesNotMatch(markup, /Start ~/);
  }
});

test('available tile keeps the date for a next-day start without adding another estimate line', async () => {
  const fixture = estimationFixture();
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(10, 40, 0, 0);
  const suggestion = fixture.estimates.unassigned[0];
  suggestion.window = {
    earliestAt: new Date(date.getTime() - 60000).toISOString(),
    expectedAt: date.toISOString(),
    latestAt: new Date(date.getTime() + 60000).toISOString()
  };
  const page = await loadPage(fixture);
  await page.openDayOf();
  const markup = page.element('raDivisions').innerHTML;
  assert.ok(markup.includes(date.toLocaleDateString([], { month: 'short', day: 'numeric' })));
  assert.equal((markup.match(/class="ra-division-estimate"/g) || []).length, 1);
  assert.doesNotMatch(markup, /<br/);
});

const lookupPerson = {
  ...savedCompetitor, firstName: 'Anna', lastName: 'Hannah', parentFirstName: 'Pat',
  parentLastName: 'Guardian', phone: '555-0100', studio: 'North Studio',
  groupDivisionNumber: 20, groupDivisionName: 'Saved division'
};
async function searchLookup(page, query) {
  page.element('clSearch').value = query;
  await page.submitLookup();
}

test('Competitors browse the selected inactive tournament roster with contact columns and full rank names', async () => {
  const savedGroups = [{ groupDivisionNumber: 20, name: 'Saved division', competitors: [lookupPerson] }];
  const page = await loadPage({
    activeEvent: winter, selectedEvent: spring,
    rostersByEvent: { [spring]: [
      { ...lookupPerson, associationNumber: 'TSD-100' },
      { ...lookupPerson, id: 2, firstName: 'Beth', lastName: 'Brown', associationNumber: 'TSD-200', groupDivisionNumber: null }
    ] },
    groupsByEvent: { [spring]: savedGroups }
  });
  await page.openDayOf('competitors');
  assert.equal(page.element('workspaceTitle').textContent, 'Competitors');
  assert.equal(page.element('competitorLookupView').hidden, false);
  assert.equal(page.element('detailsPanel').hidden, true);
  assert.match(page.element('clStatus').textContent, /2 competitors.*Spring Tournament 2027/);
  assert.match(page.element('clResults').innerHTML, /TSD-100/);
  assert.match(page.element('clResults').innerHTML, /Division 20/);
  assert.match(page.element('clResults').innerHTML, /Gender|Male/);
  await searchLookup(page, 'TSD-200');
  assert.match(page.element('clResults').innerHTML, /Beth Brown/);
  assert.doesNotMatch(page.element('clResults').innerHTML, /Anna Hannah/);
  await searchLookup(page, '');
  await searchLookup(page, 'AN');
  assert.match(page.element('clResults').innerHTML, /<mark>An<\/mark>na/);
  assert.match(page.element('clResults').innerHTML, /555-0100/);
  assert.match(page.element('clResults').innerHTML.replace(/<\/?mark>/g, ''), /Pat Guardian/);
  await page.ringAction('clResults', { clRow: '1' });
  assert.equal(page.element('detailsPanel').hidden, false);
  assert.equal(page.element('detailsTitle').textContent, 'Competitor Details');
  for (const value of ['Anna', 'Hannah', 'Pat Guardian', '555-0100', '1st Gup', 'North Studio', 'Saved division', 'TSD-100']) {
    assert.ok(page.element('competitorLookupDetails').innerHTML.includes(value), value);
  }
  await searchLookup(page, 'No matching name');
  assert.match(page.element('clStatus').textContent, /0 competitors/);
  assert.equal(page.element('detailsPanel').hidden, true);
  assert.equal(page.element('competitorLookupDetails').innerHTML, '');
  assert.ok(page.requests.filter((request) => request.path === '/api/competitors').every((request) => request.name === spring));
  assert.equal(page.requests.some((request) => request.path === '/api/rings'), false);
  assert.equal(page.activeEvent(), winter);
  assert.equal(page.requests.some((request) => request.init), false);
  await page.click('clImportBtn');
  assert.equal(page.element('importView').hidden, false);
  assert.equal(page.element('importEventChip').textContent, spring);
});

test('Competitors show a saved roster within the default page size and safely highlight literal search text', async () => {
  const competitors = Array.from({ length: 125 }, (_, id) => ({
    id, firstName: 'A[<script>', lastName: 'Same', rank: 'G1', groupDivisionNumber: 20
  }));
  const page = await loadPage({ activeEvent: winter, competitors, search: '?view=competitors' });
  await settle();
  await settle();
  assert.match(page.element('clStatus').textContent, /125 competitors/);
  assert.equal((page.element('clResults').innerHTML.match(/data-cl-id=/g) || []).length, 125);
  await searchLookup(page, '[<');
  assert.match(page.element('clStatus').textContent, /125 competitors/);
  assert.match(page.element('clResults').innerHTML, /<mark>\[&lt;<\/mark>script&gt;/);
  assert.doesNotMatch(page.element('clResults').innerHTML, /<script>/);
  await page.ringAction('clResults', { clId: '0' });
  assert.match(page.element('competitorLookupDetails').innerHTML, /Not provided/);
});

test('changing selected tournament refreshes the roster and clears stale details without following active-event changes', async () => {
  const page = await loadPage({
    activeEvent: winter, rostersByEvent: { [winter]: [lookupPerson], [spring]: [{ ...lookupPerson, id: 2, firstName: 'SpringOnly' }] },
    groupsByEvent: { [winter]: [], [spring]: [] }
  });
  await page.openDayOf('competitors');
  await searchLookup(page, 'an');
  await page.ringAction('clResults', { clId: '1' });
  page.setActiveEvent(spring);
  await page.refreshTimer();
  assert.match(page.element('clResults').innerHTML, /<mark>An<\/mark>na/);
  assert.equal(page.activeEvent(), spring);
  await page.selectTournament(spring);
  assert.match(page.element('clResults').innerHTML, /SpringOnly/);
  assert.equal(page.element('competitorLookupDetails').innerHTML, '');
  assert.equal(page.element('detailsPanel').hidden, true);
  await page.openImport();
  assert.equal(page.element('clResults').innerHTML, '');
  assert.equal(page.element('competitorLookupDetails').innerHTML, '');
});

test('lookup roster failure clears details and late responses cannot reopen a departed view', async () => {
  const page = await loadPage({ activeEvent: winter, competitors: [lookupPerson] });
  await page.openDayOf('competitors');
  await searchLookup(page, 'an');
  await page.ringAction('clResults', { clId: '1' });
  page.failSnapshot();
  await page.click('clRefreshBtn');
  assert.match(page.element('clNotice').textContent, /Database unavailable/);
  assert.equal(page.element('competitorLookupDetails').innerHTML, '');
  assert.match(page.element('clResults').innerHTML, /Competitor roster unavailable/);
  let release;
  const waitForRoster = new Promise((resolve) => { release = resolve; });
  const late = await loadPage({ activeEvent: winter, competitors: [lookupPerson], waitForRoster });
  await late.openDayOf('competitors');
  await late.openGroups();
  release();
  await settle();
  await settle();
  assert.equal(late.element('competitorLookupView').hidden, true);
  assert.equal(late.element('competitorLookupDetails').innerHTML, '');
});

test('roster loading is race-guarded when selected tournament changes and reports missing selection', async () => {
  let release;
  const waitForRoster = new Promise((resolve) => { release = resolve; });
  const page = await loadPage({ activeEvent: winter, rostersByEvent: {
    [winter]: [lookupPerson], [spring]: [{ ...lookupPerson, id: 2, firstName: 'SpringOnly' }]
  }, waitForRoster });
  await page.openDayOf('competitors');
  await page.selectTournament(spring);
  release();
  await settle();
  await settle();
  assert.match(page.element('clResults').innerHTML, /SpringOnly/);
  assert.doesNotMatch(page.element('clResults').innerHTML, /Anna Hannah/);
  assert.equal(page.activeEvent(), winter);
  const missing = await loadPage({ activeEvent: winter, competitors: [lookupPerson] });
  await missing.openDayOf('competitors');
  await missing.selectTournament('');
  assert.match(missing.element('clNotice').textContent, /Select a tournament/);
  assert.match(missing.element('clResults').innerHTML, /Select a tournament/);
});

test('division loads are race-guarded when the shared tournament changes mid-request', async () => {
  let release;
  const waitForGroups = new Promise((resolve) => { release = resolve; });
  const page = await loadPage({
    selectedEvent: winter,
    groupsByEvent: {
      [winter]: [{ id: 'winter-20', groupDivisionNumber: 20, name: 'Winter division', competitors: [savedCompetitor] }],
      [spring]: [{ id: 'spring-22', groupDivisionNumber: 22, name: 'Spring division', competitors: [newCompetitor] }]
    },
    waitForGroups
  });
  await page.openGroups();
  await page.selectTournament(spring);
  release();
  await settle();
  await settle();
  assert.match(page.element('gbBanners').innerHTML, /data-id="spring-22"/);
  assert.doesNotMatch(page.element('gbBanners').innerHTML, /data-id="winter-20"/);
  assert.ok(page.requests.some((request) => request.path === '/api/groups' && request.name === winter));
  assert.ok(page.requests.some((request) => request.path === '/api/groups' && request.name === spring));
});

test('competitor search matches names and association IDs literally and safely', async () => {
  const page = await loadPage({
    activeEvent: winter,
    competitors: [
      { ...lookupPerson, associationNumber: 'TSD-100' },
      { ...lookupPerson, id: 2, firstName: 'Bob', lastName: 'Smith', rank: 'D2', associationNumber: 'TSD-200' },
      { ...lookupPerson, id: 3, firstName: 'Cara', lastName: 'Jones', rank: 'G3' },
      { ...lookupPerson, id: 4, firstName: 'A[<script>', lastName: 'Other', rank: 'D1' }
    ]
  });
  await page.openDayOf('competitors');
  assert.match(page.element('clStatus').textContent, /4 competitors/);
  await searchLookup(page, 'Anna');
  const markup = page.element('clResults').innerHTML;
  assert.match(page.element('clStatus').textContent, /1 competitor/);
  assert.equal((markup.match(/data-cl-id=/g) || []).length, 1);
  assert.match(markup, /<mark>Anna<\/mark>/);
  await searchLookup(page, 'TSD-200');
  assert.match(page.element('clResults').innerHTML, /TSD-200/);
  assert.match(page.element('clResults').innerHTML, /Bob Smith/);
  await searchLookup(page, '[<');
  assert.match(page.element('clResults').innerHTML, /A<mark>\[&lt;<\/mark>script&gt;/);
  assert.doesNotMatch(page.element('clResults').innerHTML, /<script>/);
  assert.match(html, /\.cl-table td \{ height: 36px;/);
  assert.match(html, /max-width: 1380px/);
});

test('competitor table keeps nine columns and accessible column filters with a responsive detail panel', () => {
  assert.match(html, /<colgroup><col><col><col><col><col><col><col><col><col><\/colgroup>/);
  for (const heading of ['TSD ID', 'Competitor', 'Age', 'Gender', 'Rank', 'Studio \/ School', 'Division', 'Contact name', 'Contact phone']) {
    assert.ok(html.includes(heading), heading);
  }
  assert.match(html, /cl-division-link/);
  assert.match(html, /\.cl-toolbar \{ display: flex; flex-wrap: wrap;/);
  assert.match(html, /<form id="clToolbar"[^>]*aria-label="Filter competitors"/);
  assert.doesNotMatch(html, /id="clFilters|id="clSearchBtn|id="clClearFiltersBtn|type="checkbox"[^>]*data-cl/);
  assert.match(html, /id="clApplyFiltersBtn"[^>]*type="submit"/);
  assert.doesNotMatch(html, /clFilterAgeMin|clFilterAgeMax|cl-age-field/);
  assert.match(html, /<option>25<\/option><option>50<\/option><option>100<\/option><option selected>250<\/option>/);
  assert.ok(html.indexOf('id="clResultCount"') < html.indexOf('<table class="cl-table"'));
  assert.ok(html.indexOf('id="clPagination"') < html.indexOf('<table class="cl-table"'));
});

test('competitor roster renders compact rows, sorting and complete sectioned personal details', async () => {
  const page = await loadPage({ activeEvent: winter, competitors: [
    { ...lookupPerson, email: 'guardian@example.test', age: 14, notes: '<Keep safe>' },
    { ...lookupPerson, id: 2, firstName: 'Beth', lastName: 'Zulu' }
  ] });
  await page.openDayOf('competitors');
  const results = page.element('clResults').innerHTML;
  assert.equal((results.match(/<tr /g) || []).length, 2);
  assert.equal((results.match(/<td[ >]/g) || []).length, 18);
  assert.doesNotMatch(results, /Rank:/);
  assert.match(results, /class="cl-rank"/);
  assert.equal(page.element('clResultCount').textContent, 'Showing 1–2 of 2');
  await page.click('clSortName');
  assert.equal(page.element('clNameHeading').getAttribute('aria-sort'), 'descending');
  assert.ok(page.element('clResults').innerHTML.indexOf('Beth') < page.element('clResults').innerHTML.indexOf('Anna'));
  await page.submitLookup();
  await page.ringAction('clResults', { clId: '1' });
  const details = page.element('competitorLookupDetails').innerHTML;
  for (const value of ['Personal Information', 'Parent/Guardian', 'Competition Information', 'guardian@example.test', '>14<', 'Notes', '&lt;Keep safe&gt;']) assert.ok(details.includes(value), value);
  assert.equal(page.element('pageContent').classList.contains('competitor-lookup'), true);
  await searchLookup(page, 'nomatch');
  assert.equal(page.element('clResultCount').textContent, 'Showing 0–0 of 0');
});

test('competitor column filters apply immediately, combine with search, and show full ranks and escaped contacts', async () => {
  const page = await loadPage({ activeEvent: winter, competitors: [
    { ...lookupPerson, rank: 'G6', gender: 'Female', parentFirstName: '<Pat>', parentLastName: 'Guardian', phone: '5551234567' },
    { ...lookupPerson, id: 2, rank: 'D1', gender: 'Male', studio: 'South Studio', parentFirstName: '', parentLastName: '', phone: '' }
  ] });
  await page.openDayOf('competitors');
  assert.match(page.element('clResults').innerHTML, /6th Gup/);
  assert.match(page.element('clResults').innerHTML, /Cho Dan/);
  assert.match(page.element('clResults').innerHTML, /&lt;Pat&gt; Guardian/);
  assert.match(page.element('clResults').innerHTML, /555-123-4567/);
  assert.match(page.element('clResults').innerHTML, /<td>—<\/td>\s*<td>—<\/td>/);
  assert.doesNotMatch(page.element('clResults').innerHTML, /<Pat>/);
  await page.ringAction('clResults', { clId: String(lookupPerson.id) });
  assert.match(page.element('competitorLookupDetails').innerHTML, /6th Gup/);
  assert.doesNotMatch(page.element('competitorLookupDetails').innerHTML, />G6</);
  assert.match(page.element('clFilterRank').innerHTML, /value="G6">6th Gup/);
  page.element('clFilterRank').value = 'G6';
  await page.input('clFilterRank', 'change');
  assert.match(page.element('clStatus').textContent, /1 competitor/);
  assert.doesNotMatch(page.element('clResults').innerHTML, /Cho Dan/);
  await page.refreshTimer();
  assert.equal(page.element('clFilterRank').value, 'G6');
  assert.match(page.element('clStatus').textContent, /1 competitor/);
  page.element('clFilterGender').value = 'Male';
  await page.input('clFilterGender', 'change');
  assert.match(page.element('clResults').innerHTML, /No matching competitors/);
  page.element('clFilterGender').value = '';
  await page.input('clFilterGender', 'change');
  await searchLookup(page, '555-123');
  assert.match(page.element('clStatus').textContent, /1 competitor/);
  await searchLookup(page, '6th Gup');
  assert.match(page.element('clStatus').textContent, /1 competitor/);
  await searchLookup(page, 'Guardian');
  assert.match(page.element('clStatus').textContent, /1 competitor/);
  page.element('clFilterStudio').value = 'South Studio';
  await page.input('clFilterStudio', 'change');
  assert.match(page.element('clResults').innerHTML, /No matching competitors/);
  await page.selectTournament(spring);
  for (const id of ['clFilterGender', 'clFilterRank', 'clFilterStudio']) assert.equal(page.element(id).value, '');
});

test('competitor school and gender filters combine with age search and reset when the selected tournament changes', async () => {
  const people = [
    { ...lookupPerson, age: 15, gender: 'Female' },
    { ...lookupPerson, id: 2, firstName: 'Bob', rank: 'D2', studio: 'South Studio', age: 17, gender: 'Male', groupDivisionNumber: 22 },
    { ...lookupPerson, id: 3, firstName: 'Cara', studio: 'North Studio', age: 20, gender: 'Female', groupDivisionNumber: null }
  ];
  const page = await loadPage({ activeEvent: winter, competitors: people });
  await page.openDayOf('competitors');
  assert.match(page.element('clFilterStudio').innerHTML, /South Studio/);
  page.element('clFilterStudio').value = 'North Studio';
  page.element('clFilterGender').value = 'Female';
  page.element('clSearch').value = '15';
  await page.submitLookup();
  assert.match(page.element('clStatus').textContent, /1 competitor.*filters applied/);
  assert.match(page.element('clResults').innerHTML, /Anna/);
  await searchLookup(page, 'Bob');
  assert.match(page.element('clResults').innerHTML, /No matching competitors found/);
  for (const id of ['clFilterStudio', 'clFilterGender']) page.element(id).value = '';
  await page.submitLookup();
  assert.match(page.element('clResults').innerHTML, /Bob/);
  await searchLookup(page, '17');
  assert.match(page.element('clStatus').textContent, /1 competitor/);
  assert.doesNotMatch(page.element('clResults').innerHTML, /Anna/);
  await page.selectTournament(spring);
  assert.equal(page.element('clSearch').value, '');
  assert.equal(page.element('clFilterGender').value, '');
  assert.equal(page.element('clFilterStudio').value, '');
});

const pagedRoster = (length = 2036) => Array.from({ length }, (_, index) => ({
  ...lookupPerson, id: index + 1, firstName: 'Person', lastName: String(index + 1).padStart(4, '0'),
  associationNumber: `TSD-${index + 1}`, studio: index % 2 ? 'South Studio' : 'North Studio',
  gender: index % 2 ? 'Male' : 'Female', age: 10 + index % 20
}));
const resultIds = (page) => [...page.element('clResults').innerHTML.matchAll(/data-cl-id="(\d+)"/g)].map((match) => Number(match[1]));
const resultSummary = (page) => page.element('clResultCount').textContent;
const goLookupPage = (page, number) => page.ringAction('clPagination', { clPage: String(number) });

test('competitor pagination bounds rows and numbered windows across more than 2,000 records', async () => {
  const page = await loadPage({ competitors: pagedRoster() });
  await page.openDayOf('competitors');
  assert.equal(resultSummary(page), 'Showing 1–250 of 2,036');
  assert.deepEqual(resultIds(page), Array.from({ length: 250 }, (_, index) => index + 1));
  assert.match(page.element('clPagination').innerHTML, /aria-label="Previous page" disabled/);
  assert.match(page.element('clPagination').innerHTML, /aria-current="page">1<\/button>/);
  await goLookupPage(page, 2);
  assert.equal(resultSummary(page), 'Showing 251–500 of 2,036');
  assert.equal(resultIds(page)[0], 251);
  assert.equal(resultIds(page).at(-1), 500);
  await page.ringAction('clResults', { clId: '251' });
  assert.match(page.element('competitorLookupDetails').innerHTML, /0251/);
  await goLookupPage(page, 9);
  assert.equal(resultSummary(page), 'Showing 2,001–2,036 of 2,036');
  assert.equal(resultIds(page).length, 36);
  assert.match(page.element('clPagination').innerHTML, /aria-label="Next page" disabled/);
  // Details follow the full filtered roster, not just the visible slice.
  assert.match(page.element('competitorLookupDetails').innerHTML, /0251/);
  page.element('clPageSize').value = '25';
  await page.input('clPageSize', 'change');
  assert.equal(resultSummary(page), 'Showing 1–25 of 2,036');
  await goLookupPage(page, 40);
  const pager = page.element('clPagination').innerHTML;
  assert.equal(resultSummary(page), 'Showing 976–1,000 of 2,036');
  assert.match(pager, /aria-current="page">40<\/button>/);
  assert.match(pager, /…/);
  assert.ok((pager.match(/<button /g) || []).length <= 9);
  for (const size of [50, 100, 250]) {
    page.element('clPageSize').value = String(size);
    await page.input('clPageSize', 'change');
    assert.equal(resultIds(page).length, size);
    assert.equal(resultIds(page)[0], 1);
    assert.equal(resultSummary(page), `Showing 1–${size} of 2,036`);
  }
});

test('competitor filters apply atomically on submit, preserve comma OR semantics, and reset pagination', async () => {
  const page = await loadPage({ competitors: pagedRoster(601) });
  await page.openDayOf('competitors');
  await goLookupPage(page, 3);
  page.element('clSearch').value = 'tsd-1, TSD-2, tsd-1, x, ';
  page.element('clFilterStudio').value = 'North Studio';
  page.element('clFilterGender').value = 'Female';
  assert.equal(resultSummary(page), 'Showing 501–601 of 601');
  await page.refreshTimer();
  assert.equal(resultSummary(page), 'Showing 501–601 of 601');
  await page.submitLookup();
  const expected = pagedRoster(601).filter((person) =>
    (person.associationNumber.toLowerCase().includes('tsd-1') || person.associationNumber.toLowerCase().includes('tsd-2'))
    && person.studio === 'North Studio' && person.gender === 'Female');
  assert.deepEqual(resultIds(page), expected.map((person) => person.id));
  assert.equal(resultSummary(page), `Showing 1–${expected.length} of ${expected.length}`);
  assert.equal(page.element('competitorLookupDetails').innerHTML, '');
  await searchLookup(page, 'x');
  assert.equal(resultSummary(page), 'Showing 0–0 of 0');
  assert.deepEqual(resultIds(page), []);
  assert.match(page.element('clPagination').innerHTML, /aria-label="Next page" disabled/);
});

test('competitor page resets on sorting and tournament changes, refresh preserves or clamps pages', async () => {
  const rostersByEvent = { [winter]: pagedRoster(601), [spring]: pagedRoster(301) };
  const page = await loadPage({ rostersByEvent });
  await page.openDayOf('competitors');
  await goLookupPage(page, 3);
  await page.refreshTimer();
  assert.equal(resultSummary(page), 'Showing 501–601 of 601');
  rostersByEvent[winter] = pagedRoster(280);
  await page.refreshTimer();
  assert.equal(resultSummary(page), 'Showing 251–280 of 280');
  assert.equal(resultIds(page).length, 30);
  await page.click('clSortName');
  assert.equal(resultSummary(page), 'Showing 1–250 of 280');
  assert.equal(resultIds(page)[0], 280);
  assert.equal(resultIds(page).at(-1), 31);
  await goLookupPage(page, 2);
  await page.selectTournament(spring);
  assert.equal(resultSummary(page), 'Showing 1–250 of 301');
  assert.equal(resultIds(page)[0], 301);
  assert.equal(page.element('competitorLookupDetails').innerHTML, '');
  rostersByEvent[spring] = [];
  await page.refreshTimer();
  assert.equal(resultSummary(page), 'Showing 0–0 of 0');
  assert.deepEqual(resultIds(page), []);
  page.failSnapshot();
  await page.click('clRefreshBtn');
  assert.equal(resultSummary(page), 'Showing 0–0 of 0');
  assert.equal(page.element('clRefreshBtn').disabled, false);
  assert.equal(page.element('clTableWrap').getAttribute('aria-busy'), 'false');
  assert.match(page.element('clNotice').textContent, /Database unavailable/);
});

test('saved division link opens the saved division for the same selected inactive tournament', async () => {
  const savedCompetitor = { ...lookupPerson, associationNumber: 'TSD-20' };
  const page = await loadPage({
    activeEvent: winter, selectedEvent: spring,
    rostersByEvent: { [spring]: [savedCompetitor] },
    groupsByEvent: { [spring]: [{ id: 'saved-division', groupDivisionNumber: 20, name: 'Spring division', competitors: [savedCompetitor] }] },
    draft: { eventName: spring, groups: [{ id: 'draft-only', groupDivisionNumber: 99, competitors: [savedCompetitor] }] }
  });
  await page.openDayOf('competitors');
  assert.match(page.element('clResults').innerHTML, /data-cl-division="20"/);
  await page.clickDivision(20);
  assert.equal(page.element('groupsView').hidden, false);
  assert.equal(page.element('gdName').textContent, 'Division 20');
  assert.doesNotMatch(page.element('gdName').textContent, /draft/i);
  assert.equal(new URLSearchParams(page.location.search).get('source'), 'saved');
  assert.equal(new URLSearchParams(page.location.search).get('eventName'), spring);
  assert.ok(page.requests.some((request) => request.path === '/api/groups' && request.name === spring));
  assert.equal(page.activeEvent(), winter);
});

test('each tournament workspace shows the shared selection while live ring pages stay active-scoped', async () => {
  const page = await loadPage({ activeEvent: winter, selectedEvent: spring });
  assert.equal(page.element('tournamentReference').hidden, true);
  await page.openImport();
  assert.equal(page.element('tournamentReferenceSelect').hidden, false);
  assert.equal(page.element('tournamentReferenceSelect').value, spring);
  await page.openGroups();
  assert.equal(page.element('tournamentReferenceSelect').value, spring);
  await page.openDayOf('head-table');
  assert.equal(page.element('tournamentReferenceSelect').hidden, false);
  assert.equal(page.element('tournamentReferenceLabel').textContent, 'Active Tournament');
  assert.equal(page.element('tournamentReferenceSelect').value, winter);
  await page.navigate('judge-management');
  assert.equal(page.element('tournamentReference').hidden, true);
  assert.equal(page.activeEvent(), winter);
  assert.equal(page.requests.some((request) => request.path.includes('/activate')), false);
});

test('all live Ring Management selectors activate only after confirmation and preserve preparation context', async () => {
  for (const view of ['tablet-pairing', 'ring-assignment', 'head-table']) {
    const page = await loadPage({ activeEvent: winter, selectedEvent: spring, confirm: true });
    await page.navigate(view);
    assert.equal(page.element('tournamentReferenceLabel').textContent, 'Active Tournament');
    assert.equal(page.element('tournamentReferenceSelect').hidden, false);
    await page.selectTournament(winter);
    assert.equal(page.confirmations.length, 0);
    assert.equal(page.requests.some((request) => request.path === '/api/events/activate'), false);
    const start = page.requests.length;
    await page.selectTournament(spring);
    assert.equal(page.confirmations.length, 1);
    assert.equal(page.confirmations[0], `Switch live operations to ${spring}? Connected tablets will use this tournament instead of the current active tournament.`);
    const posts = page.requests.slice(start).filter((request) => request.init?.method === 'POST');
    assert.deepEqual(posts.map((request) => request.path), ['/api/events/activate']);
    assert.equal(JSON.parse(posts[0].init.body).eventName, spring);
    assert.equal(page.activeEvent(), spring);
    assert.equal(page.element('tournamentReferenceSelect').value, spring);
    assert.equal(page.element('eventNameInput').value, spring);
    assert.equal(page.element('bannerEventName').textContent, spring);
    if (view === 'tablet-pairing') {
      assert.equal(page.element('administrationToolFrame').getAttribute('src'), '/tablet-pairing/?embedded=1');
    } else if (view === 'judge-assignments') {
      assert.equal(page.requests.slice(start).some((request) => request.path.startsWith('/api/rings')), false);
    } else {
      assert.ok(page.requests.slice(start).some((request) => request.path === '/api/rings' && request.name === spring));
    }
    await page.navigate('competitors');
    assert.equal(page.element('tournamentReferenceSelect').value, spring);
  }
});

test('Judge Assignments stays scoped to the selected tournament without changing the active event', async () => {
  const page = await loadPage({ activeEvent: spring, selectedEvent: winter });
  await page.navigate('judge-assignments');
  assert.equal(page.element('judgeAssignmentsView').hidden, false);
  assert.equal(page.element('tournamentReferenceLabel').textContent, 'Tournament for this page');
  assert.equal(page.element('tournamentReferenceSelect').value, winter);
  assert.equal(page.activeEvent(), spring);
  assert.equal(page.requests.some((request) => request.path === '/api/events/activate'), false);
});

test('cancelled and failed live activation retain the previous active tournament and browsing selection', async () => {
  for (const failActivation of [false, true]) {
    const page = await loadPage({ activeEvent: winter, selectedEvent: spring, confirm: failActivation, failActivation });
    await page.navigate('head-table');
    await page.selectTournament(spring);
    assert.equal(page.activeEvent(), winter);
    assert.equal(page.element('tournamentReferenceSelect').value, winter);
    assert.equal(page.element('bannerEventName').textContent, winter);
    assert.equal(page.element('eventNameInput').value, spring);
    assert.equal(page.requests.filter((request) => request.path === '/api/events/activate').length, failActivation ? 1 : 0);
    if (failActivation) assert.match(page.element('notice').textContent, /Unable to switch live operations: Activation unavailable/);
    await page.navigate('competitors');
    assert.equal(page.element('tournamentReferenceSelect').value, spring);
  }
});

test('no active tournament allows every live Ring Management chooser and activation never changes browsing selection', async () => {
  for (const view of ['ring-assignment', 'head-table']) {
    const page = await loadPage({ selectedEvent: winter, confirm: true });
    await page.navigate(view);
    assert.equal(page.nav(view).getAttribute('aria-disabled'), 'false');
    assert.equal(page.element('tournamentReferenceSelect').value, '');
    assert.equal(page.requests.some((request) => request.path === '/api/rings'), false);
    assert.match(page.element('placeholderMessage').textContent, /No active tournament/);
    await page.selectTournament(spring);
    assert.equal(page.activeEvent(), spring);
    assert.equal(page.element('eventNameInput').value, winter);
    await page.navigate('competitors');
    assert.equal(page.element('tournamentReferenceSelect').value, winter);
  }
});

test('busy activation disables chooser, blocks repeat activation and navigation, and resets ring details', async () => {
  let release;
  const waitForActivation = new Promise((resolve) => { release = resolve; });
  const page = await loadPage({ activeEvent: winter, selectedEvent: winter, confirm: true, waitForActivation,
    rings: [{ ringId: 'ring-a-1', ringLabel: 'A1', queuedGroupDivisionNumbers: [] }] });
  await page.navigate('head-table');
  await page.ringAction('htRings', { htRing: 'ring-a-1' });
  const switching = page.selectTournament(spring);
  await settle();
  assert.equal(page.element('tournamentReferenceSelect').disabled, true);
  await page.navigate('ring-judges');
  assert.equal(page.element('workspaceTitle').textContent, 'Head Table');
  await page.selectTournament(spring);
  assert.equal(page.requests.filter((request) => request.path === '/api/events/activate').length, 1);
  release();
  await switching;
  assert.equal(page.element('tournamentReferenceSelect').disabled, false);
  assert.equal(page.element('detailsPanel').hidden, true);
  assert.equal(page.element('eventNameInput').value, winter);
});

test('late active reads cannot overwrite a confirmed switch or cross-page active context', async () => {
  let release;
  let hold = false;
  const pending = new Promise((resolve) => { release = resolve; });
  const page = await loadPage({ activeEvent: winter, selectedEvent: winter, confirm: true,
    waitForActive: () => hold ? pending : undefined });
  await page.navigate('ring-assignment');
  hold = true;
  const oldRead = page.refreshDayOf();
  await settle();
  hold = false;
  await page.selectTournament(spring);
  release();
  await oldRead;
  await settle();
  assert.equal(page.element('bannerEventName').textContent, spring);
  assert.equal(page.element('tournamentReferenceSelect').value, spring);
  assert.equal(page.element('eventNameInput').value, winter);
});

test('stale active responses from a departed live page cannot replace the new page context', async () => {
  let release;
  let hold = false;
  const pending = new Promise((resolve) => { release = resolve; });
  const page = await loadPage({ activeEvent: winter, selectedEvent: winter,
    waitForActive: () => hold ? pending : undefined });
  hold = true;
  await page.navigate('ring-assignment');
  page.setActiveEvent(spring);
  hold = false;
  await page.navigate('head-table');
  release();
  await settle();
  await settle();
  assert.equal(page.element('bannerEventName').textContent, spring);
  assert.equal(page.element('tournamentReferenceSelect').value, spring);
  assert.equal(page.requests.some((request) => request.path === '/api/rings' && request.name === winter), false);
});

test('late division reads during activation do not request stale rings or restore old ring details', async () => {
  for (const view of ['ring-assignment', 'head-table']) {
    let release;
    let hold = false;
    const pending = new Promise((resolve) => { release = resolve; });
    const page = await loadPage({ activeEvent: winter, selectedEvent: winter, confirm: true,
      waitForGroups: (name) => hold && name === winter ? pending : undefined });
    hold = true;
    await page.navigate(view);
    await page.selectTournament(spring);
    release();
    await settle();
    await settle();
    assert.equal(page.element('bannerEventName').textContent, spring);
    assert.equal(page.element('tournamentReferenceSelect').value, spring);
    assert.equal(page.requests.some((request) => request.path === '/api/rings' && request.name === winter), false);
    assert.equal(page.element('detailsPanel').hidden, true);
  }
});

test('create and edit omit activation and import actions while competitor import remains available', async () => {
  assert.doesNotMatch(html, /id="(?:activateEventBtn|goToImportBtn)"|function activateEvent\(/);
  assert.ok(html.indexOf('id="notice"') < html.indexOf('id="eventSetupView"'), 'activation errors must be outside the hidden tournament view');
  const page = await loadPage({ selectedEvent: winter });
  await page.openTournament();
  await page.navigate('competitors');
  await page.openImport();
  assert.equal(page.element('importView').hidden, false);
  assert.equal(page.requests.some((request) => request.path === '/api/events/activate'), false);
});

test('tournament switching protects unsaved division drafts and does not alter active tournament', async () => {
  const draft = { eventName: winter, groups: [{ id: 'draft', groupDivisionNumber: 99, competitors: [lookupPerson] }] };
  const page = await loadPage({ activeEvent: winter, selectedEvent: winter, draft, competitors: [lookupPerson] });
  await page.openGroups();
  await page.selectTournament(spring);
  assert.equal(page.element('tournamentReferenceSelect').value, winter);
  assert.equal(page.activeEvent(), winter);
  assert.match(page.confirmations[0], /unsaved division draft/);
  const confirmed = await loadPage({ activeEvent: winter, selectedEvent: winter, draft, confirm: true, competitors: [lookupPerson] });
  await confirmed.openGroups();
  await confirmed.selectTournament(spring);
  assert.equal(confirmed.element('tournamentReferenceSelect').value, spring);
  assert.equal(confirmed.activeEvent(), winter);
});

test('tournament selection warns before discarding unsaved event metadata edits', async () => {
  const page = await loadPage({ activeEvent: winter, selectedEvent: winter });
  await page.openTournament();
  page.element('locationInput').value = 'Unsaved venue';
  await page.selectTournament(spring);
  assert.equal(page.element('tournamentReferenceSelect').value, winter);
  assert.equal(page.element('locationInput').value, 'Unsaved venue');
  assert.match(page.confirmations[0], /unsaved tournament details/);
});

test('lookup formats ten-digit phone display without changing stored values or nonstandard numbers', async () => {
  for (const [phone, expected] of [
    ['6353676158', '635-367-6158'],
    ['(635) 367-6158', '635-367-6158'],
    ['635.367.6158', '635-367-6158'],
    ['+1 635 367 6158', '+1 635 367 6158'],
    ['6353676158 ext 12', '6353676158 ext 12'],
    ['555-0100', '555-0100'],
    ['', 'Not provided']
  ]) {
    const person = { ...lookupPerson, phone };
    const page = await loadPage({ activeEvent: winter, competitors: [person] });
    await page.openDayOf('competitors');
    await searchLookup(page, 'anna');
    await page.ringAction('clResults', { clId: '1' });
    assert.ok(page.element('competitorLookupDetails').innerHTML.includes(`<dt>Phone</dt><dd>${expected}</dd>`), phone);
    assert.equal(person.phone, phone);
  }
  assert.match(html, /--cl-details-width: clamp\(420px, calc\(65vw - 477px\), 460px\)/);
  assert.match(html, /min\(var\(--cl-details-width\), calc\(100vw - 32px\)\)/);
});
