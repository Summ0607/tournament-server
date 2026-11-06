const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DEFAULT_ACCOUNT_POLICY } = require('../backend/accountPolicy');

async function harness({ view = 'users', initialSession = false, role = 'administrator', returnTo = '' } = {}) {
  const nodes = new Map(), intervals = [], requests = [], documentHandlers = {}, windowHandlers = {};
  class Node {
    constructor(tag = 'input') {
      this.tag = tag; this.children = []; this.handlers = {}; this.value = ''; this.checked = false;
      this.hidden = false; this.disabled = false; this.textContent = ''; this.dataset = {};
    }
    append(...children) {
      this.children.push(...children);
      for (const child of children) if (child.id) nodes.set(child.id, child);
    }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    addEventListener(name, callback) { this.handlers[name] = callback; }
    querySelectorAll(selector) {
      const inputs = this.children.flatMap((child) => [child, ...child.querySelectorAll('input')])
        .filter((child) => child.tag === 'input');
      return selector === 'input:checked' ? inputs.filter((input) => input.checked) : inputs;
    }
    reset() {
      for (const input of ['userId', 'userPassword', 'confirmPassword']) nodes.get(input).value = '';
      for (const input of nodes.get('roles').children) input.checked = false;
      nodes.get('userEnabled').checked = true;
    }
  }
  const html = fs.readFileSync(path.join(__dirname, '..', 'account', 'index.html'), 'utf8');
  for (const [, tag, id] of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) {
    const node = new Node(tag); node.id = id; nodes.set(id, node);
  }
  for (const value of ['administrator', 'judging-coordinator', 'tournament-operator', 'event-coordinator', 'viewer']) {
    const input = new Node(); input.value = value; nodes.get('roles').append(input);
  }
  let loggedIn = initialSession, rejectLogin = false, rejectUserSave = false, revokeSavedSession = false, timestamp = 0;
  const account = { userId: 'admin', roles: [role], enabled: true, revision: 1 };
  let policy = { revision: 1, policy: { ...DEFAULT_ACCOUNT_POLICY } };
  let accounts = [account];
  const context = vm.createContext({
    document: {
      getElementById: (id) => nodes.get(id),
      createElement: (tag) => new Node(tag), createTextNode: (text) => { const n = new Node('text'); n.textContent = text; return n; },
      querySelectorAll: (selector) => selector === 'button' ? [...nodes.values()].filter((node) => node.tag === 'button') : [],
      addEventListener: (name, callback) => { documentHandlers[name] = callback; }
    },
    window: { confirm: () => true, addEventListener: (name, callback) => { windowHandlers[name] = callback; } },
    location: { pathname: `/account/${view}`, origin: 'https://tourn-svr.home.arpa:3443',
      search: `?returnTo=${encodeURIComponent(returnTo)}`, replace: (value) => {
        context.navigationBlocked = false;
        windowHandlers.beforeunload?.({ preventDefault() { context.navigationBlocked = true; } });
        context.destination = value;
      } },
    URL, URLSearchParams,
    setInterval: (callback) => { intervals.push(callback); },
    Date: { now: () => timestamp },
    fetch: async (url, options) => {
      const endpoint = url.slice('/api/account'.length);
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ endpoint, ...options, body });
      let data, status = 200;
      if (endpoint === '/login') {
        if (rejectLogin) { status = 401; data = { error: 'Invalid user ID or password.' }; }
        else { loggedIn = true; data = { account, csrfToken: 'login-csrf' }; }
      } else if (!loggedIn) { status = 401; data = { error: 'Sign in to continue.' }; }
      else if (endpoint === '/session') data = { account, csrfToken: 'session-csrf',
        homePath: role === 'viewer' ? '/audience-monitor/' : '/tournament-management/?view=event-setup' };
      else if (endpoint === '/logout') { loggedIn = false; status = 204; }
      else if (endpoint === '/activity') data = { account };
      else if (endpoint === '/policy' && options.method === 'GET') data = policy;
      else if (endpoint === '/policy') {
        if (JSON.stringify(body.policy) !== JSON.stringify(policy.policy)) {
          policy = { revision: policy.revision + 1, policy: body.policy }; loggedIn = false;
        }
        data = policy;
      } else if (endpoint === '/users' && options.method === 'GET') data = { users: accounts };
      else if (rejectUserSave) { status = 409; data = { error: 'Account changed. Reload before saving.' }; }
      else {
        const saved = { userId: body.userId || endpoint.split('/').pop(),
          roles: body.roles, enabled: body.enabled ?? true, revision: (body.revision || 0) + 1 };
        accounts = [...accounts.filter((item) => item.userId !== saved.userId), saved];
        if (revokeSavedSession) loggedIn = false;
        data = { account: saved };
      }
      return { ok: status < 400, status, json: async () => structuredClone(data) };
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'account', 'account.js'), 'utf8'), context);
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
  await flush();
  const fire = async (id, name = 'click') => {
    nodes.get(id).handlers[name]({ preventDefault() {} });
    await flush();
  };
  async function login() {
    nodes.get('loginUser').value = 'admin'; nodes.get('loginPassword').value = 'test password';
    await fire('loginForm', 'submit');
  }
  return { nodes, intervals, requests, documentHandlers, windowHandlers, context, fire, login, flush,
    expire: () => { loggedIn = false; }, rejectLogin: () => { rejectLogin = true; },
    switchAccount: (userId) => { account.userId = userId; loggedIn = true; },
    revokeOnSave: () => { revokeSavedSession = true; },
    rejectSave: () => { rejectUserSave = true; }, advance: () => { timestamp += 60001; } };
}

test('login returns to a local workspace or role home without fetching administration data', async () => {
  const h = await harness({ view: 'login', role: 'viewer', returnTo: '/audience-monitor/?source=active' });
  await h.login();
  assert.equal(h.context.destination, '/audience-monitor/?source=active');
  assert.equal(h.context.navigationBlocked, false);
  assert.equal(h.requests.some((request) => ['/policy', '/users'].includes(request.endpoint)), false);
  for (const returnTo of ['https://evil.example', '//evil.example', '/\\evil.example', '/\t/evil.example',
    '/account/login', '/account/settings', '']) {
    const rejected = await harness({ view: 'login', role: 'viewer', returnTo });
    await rejected.login();
    assert.equal(rejected.context.destination, '/audience-monitor/', returnTo);
  }
});

test('unsaved administration drafts can only be resumed by the original account', async () => {
  const h = await harness({ initialSession: true });
  h.nodes.get('userId').value = 'unsaved-account';
  await h.fire('userForm', 'input');
  h.switchAccount('other-admin');
  await h.intervals[0]();
  assert.equal(h.nodes.get('usersPanel').hidden, true);
  assert.equal(h.nodes.get('loginUser').value, 'admin');
  assert.equal(h.nodes.get('loginUser').readOnly, true);
  assert.match(h.nodes.get('status').textContent, /original user/);
  assert.equal(h.nodes.get('userId').value, 'unsaved-account');
  h.switchAccount('admin');
  await h.login();
  assert.equal(h.nodes.get('usersPanel').hidden, false);
  assert.match(h.nodes.get('passwordHelp').textContent, /10-128 characters.*uppercase.*lowercase.*number.*special/);
  assert.equal(h.nodes.get('userId').value, 'unsaved-account');
});

test('account UI shows login errors explicitly, clears passwords, and does not expose admin panels before login', async () => {
  const h = await harness();
  assert.equal(h.nodes.get('loginPanel').hidden, false);
  assert.equal(h.nodes.get('usersPanel').hidden, true);
  h.rejectLogin();
  await h.login();
  assert.match(h.nodes.get('status').textContent, /Invalid user ID or password/);
  assert.equal(h.nodes.get('loginPassword').value, '');
});

test('administrator can create/edit users, keeps stale drafts and reauthenticates without losing edits', async () => {
  const h = await harness();
  await h.login();
  assert.equal(h.nodes.get('usersPanel').hidden, false);
  h.nodes.get('userId').value = 'new-user';
  h.nodes.get('roles').children[2].checked = true;
  h.nodes.get('userPassword').value = 'A sufficiently long phrase1!';
  h.nodes.get('confirmPassword').value = 'A sufficiently long phrase1!';
  await h.fire('userForm', 'input');
  await h.fire('userForm', 'submit');
  const creation = h.requests.find((r) => r.endpoint === '/users' && r.method === 'POST');
  assert.deepEqual(creation.body.roles, ['tournament-operator']);
  assert.equal(creation.headers['X-CSRF-Token'], 'session-csrf');
  assert.equal(h.nodes.get('userPassword').value, '');
  h.nodes.get('userEnabled').checked = false;
  await h.fire('userForm', 'input');
  h.expire();
  await h.intervals[0]();
  assert.equal(h.nodes.get('loginPanel').hidden, false);
  assert.equal(h.nodes.get('userId').value, 'new-user');
  assert.equal(h.nodes.get('userEnabled').checked, false);
  await h.login();
  assert.equal(h.nodes.get('userEnabled').checked, false);
  h.rejectSave();
  await h.fire('userForm', 'submit');
  assert.match(h.nodes.get('status').textContent, /draft has been kept/);
  assert.equal(h.nodes.get('userEnabled').checked, false);
  let prevented = false;
  h.windowHandlers.beforeunload({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
});

test('settings render every policy field and changed saves require reauthentication while unchanged saves do not', async () => {
  const h = await harness({ view: 'settings', initialSession: true });
  for (const key of Object.keys(DEFAULT_ACCOUNT_POLICY)) assert.ok(h.nodes.has(`policy-${key}`));
  assert.equal(h.nodes.get('policy-passwordMinLength').min, '10');
  assert.equal(h.nodes.get('policy-passwordMinLength').value, 10);
  await h.fire('policyForm', 'submit');
  assert.match(h.nodes.get('status').textContent, /unchanged/);
  assert.equal(h.nodes.get('loginPanel').hidden, true);
  h.nodes.get('policy-idleTimeoutMinutes').value = '45';
  await h.fire('policyForm', 'input');
  await h.fire('policyForm', 'submit');
  assert.match(h.nodes.get('status').textContent, /All browser sessions were revoked/);
  assert.equal(h.nodes.get('loginPanel').hidden, false);
  await h.login();
  assert.equal(h.nodes.get('policy-idleTimeoutMinutes').value, 45);
});

test('a successful self-update that revokes the session still explicitly reports the saved user', async () => {
  const h = await harness({ initialSession: true });
  h.nodes.get('users').children[0].children[3].children[0].handlers.click();
  h.nodes.get('userPassword').value = 'a changed administrator password';
  h.nodes.get('confirmPassword').value = 'a changed administrator password';
  h.revokeOnSave();
  await h.fire('userForm', 'submit');
  assert.equal(h.nodes.get('loginPanel').hidden, false);
  assert.match(h.nodes.get('status').textContent, /User saved.*session was revoked/);
  assert.equal(h.nodes.get('userPassword').value, '');
});

test('non-administrators see an explicit permission message and never request administrator data', async () => {
  const h = await harness({ initialSession: true, role: 'tournament-operator' });
  assert.equal(h.nodes.get('usersPanel').hidden, true);
  assert.match(h.nodes.get('status').textContent, /Administrator permission/);
  assert.equal(h.requests.some((r) => ['/users', '/policy'].includes(r.endpoint)), false);
});

test('background session checks do not refresh idle time; trusted user input refreshes at most once per minute', async () => {
  const h = await harness({ initialSession: true });
  await h.intervals[0]();
  assert.equal(h.requests.filter((r) => r.endpoint === '/activity').length, 0);
  h.advance();
  await h.documentHandlers.pointerdown({ isTrusted: false });
  assert.equal(h.requests.filter((r) => r.endpoint === '/activity').length, 0);
  await h.documentHandlers.pointerdown({ isTrusted: true });
  await h.documentHandlers.keydown({ isTrusted: true });
  assert.equal(h.requests.filter((r) => r.endpoint === '/activity').length, 1);
});
