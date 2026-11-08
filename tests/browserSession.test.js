const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

async function harness({ audience = false, initialSession = true } = {}) {
  const nodes = new Map(), intervals = [], handlers = {}, calls = [];
  let valid = initialSession, timestamp = 0, rejectLogin = false, legacySession = false;
  class Node {
    constructor() { this.handlers = {}; this.value = ''; this.disabled = false; this.textContent = ''; this.dataset = {}; }
    set innerHTML(html) {
      for (const [, id] of html.matchAll(/id="([^"]+)"/g)) {
        const node = new Node(); node.id = id; nodes.set(id, node);
      }
    }
    append(node) { if (node.id) nodes.set(node.id, node); }
    prepend(node) { this.append(node); }
    setAttribute() {}
    addEventListener(name, callback) { this.handlers[name] = callback; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    focus() {}
  }
  const draft = new Node(); draft.value = 'unsaved competitor changes';
  nodes.set('draft', draft);
  const passwordDraft = new Node(); passwordDraft.value = 'a sensitive password draft';
  nodes.set('passwordDraft', passwordDraft);
  const roleNode = new Node();
  roleNode.getAttribute = (name) => name === 'data-nav-id' ? 'users' : null;
  const body = new Node();
  const origin = 'https://tourn-svr.home.arpa:3443';
  const location = { href: `${origin}/${audience ? 'audience-monitor/' : 'tournament-management/'}`, origin,
    assign: (value) => { location.assigned = value; }, replace: (value) => { location.replaced = value; } };
  class BrowserRequest extends Request {
    constructor(input, options) { super(typeof input === 'string' ? new URL(input, location.href) : input, options); }
  }
  const session = { account: { userId: 'operator', roles: ['tournament-operator'] },
    csrfToken: 'session-csrf', allowedViews: ['ring-assignment', 'head-table', 'audience-viewer', 'your-account'],
    roleLabels: { 'tournament-operator': 'Tournament Operator' }, homePath: '/tournament-management/?view=ring-assignment' };
  const originalFetch = async (input, options) => {
    const request = new BrowserRequest(input, options);
    const endpoint = new URL(request.url).pathname;
    const body = request.method === 'GET' ? null : await request.clone().text();
    calls.push({ endpoint, method: request.method, headers: request.headers, body });
    const json = (data, status = 200) => Response.json(data, { status });
    if (endpoint === '/api/account/login') {
      if (rejectLogin) return json({ error: 'Invalid user ID or password.' }, 401);
      valid = true; return json({ account: session.account });
    }
    if (!valid) return json({ error: 'Sign in to continue.' }, 401);
    if (endpoint === '/api/account/session') return json(legacySession
      ? { account: session.account, csrfToken: session.csrfToken } : session);
    if (endpoint === '/api/account/logout') { valid = false; return new Response(null, { status: 204 }); }
    return json({ ok: true });
  };
  const window = { fetch: originalFetch, dispatchEvent() {}, confirm: () => true };
  window.top = { location };
  const context = vm.createContext({
    window, location, document: {
      readyState: 'complete', head: new Node(), body,
      getElementById: (id) => nodes.get(id), createElement: () => new Node(),
      querySelectorAll: (selector) => selector === 'input[type="password"]' ? [passwordDraft, nodes.get('browserLoginPassword')]
        : selector === '[data-nav-id], [data-auth-view]' ? [roleNode] : [],
      addEventListener: (name, callback) => { handlers[name] = callback; }
    },
    URL, Headers, Request: BrowserRequest, CustomEvent: class {}, Date: { now: () => timestamp },
    setInterval: (callback) => intervals.push(callback)
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'assets', 'browser-session.js'), 'utf8'), context);
  if (initialSession) await window.BrowserSession.ready;
  async function signIn() {
    nodes.get('browserLoginPassword').value = 'a password';
    await nodes.get('browserLoginForm').handlers.submit({ preventDefault() {} });
  }
  const flush = async () => { for (let count = 0; count < 5; count++) await new Promise(setImmediate); };
  if (!initialSession) await flush();
  return { window, location, nodes, calls, intervals, handlers, roleNode, signIn, flush,
    expire: () => { valid = false; }, advance: () => { timestamp += 60001; },
    switchAccount: (userId) => { session.account.userId = userId; valid = true; },
    rejectLogin: () => { rejectLogin = true; }, useLegacySession: () => { legacySession = true; } };
}

test('sign-in without a known page owner opens role home instead of resuming the old page', async () => {
  const h = await harness({ initialSession: false });
  assert.equal(h.nodes.get('browserLoginDialog').open, true);
  await h.signIn();
  assert.equal(h.location.replaced, '/tournament-management/?view=ring-assignment');
});

test('browser session shows identity, hides forbidden navigation and adds session CSRF to JSON changes', async () => {
  const h = await harness();
  assert.match(h.nodes.get('browserIdentity').textContent, /operator.*Tournament Operator/);
  assert.equal(h.roleNode.hidden, true);
  assert.equal(h.window.BrowserSession.canView('head-table'), true);
  const result = await h.window.fetch('/api/rings/ring-a-1/reset', { method: 'POST' });
  assert.equal(result.status, 200);
  const change = h.calls.at(-1);
  assert.equal(change.headers.get('x-csrf-token'), 'session-csrf');
  assert.equal(change.headers.get('content-type'), 'application/json');
  assert.equal(change.body, '{}');
});

test('unattended monitor scopes session and data reads without generating editable-session activity', async () => {
  const h = await harness({ audience: true });
  assert.equal(h.calls[0].headers.get('x-tournament-audience'), 'true');
  await h.window.fetch('/api/rings/monitor');
  assert.equal(h.calls.at(-1).headers.get('x-tournament-audience'), 'true');
  h.advance();
  await h.handlers.pointerdown({ isTrusted: true });
  assert.equal(h.calls.some((call) => call.endpoint === '/api/account/activity'), false);
  await h.intervals[0]();
  assert.equal(h.calls.at(-1).endpoint, '/api/account/session');
  assert.equal(h.calls.at(-1).headers.get('x-tournament-audience'), 'true');
  await h.nodes.get('browserSignOut').handlers.click();
  assert.equal(h.calls.at(-1).endpoint, '/api/account/logout');
  assert.equal(h.calls.at(-1).headers.get('x-tournament-audience'), 'true');
});

test('expired save preserves drafts, clears passwords, opens reauthentication and never automatically replays the mutation', async () => {
  const h = await harness();
  h.expire();
  const result = await h.window.fetch('/api/rings/ring-a-1/queue', { method: 'POST', body: '{"groups":[1]}' });
  await h.flush();
  assert.equal(result.status, 401);
  assert.equal(h.nodes.get('draft').value, 'unsaved competitor changes');
  assert.equal(h.nodes.get('passwordDraft').value, '');
  assert.equal(h.nodes.get('browserLoginDialog').open, true);
  assert.equal(h.nodes.get('browserLoginUser').readOnly, true);
  await h.signIn();
  assert.equal(h.nodes.get('browserLoginDialog').open, false);
  assert.equal(h.location.replaced, undefined);
  assert.equal(h.nodes.get('draft').value, 'unsaved competitor changes');
  assert.equal(h.calls.filter((call) => call.endpoint === '/api/rings/ring-a-1/queue').length, 1);
  assert.match(h.nodes.get('browserSessionNotice').textContent, /never replayed automatically/);
  assert.equal(h.nodes.get('browserLoginPassword').value, '');
});

test('expired read resumes only after successful sign-in; failed login is visible and keeps draft', async () => {
  const h = await harness();
  h.expire();
  const waiting = h.window.fetch('/api/groups');
  await h.flush();
  assert.equal(h.nodes.get('browserLoginDialog').open, true);
  await h.signIn();
  assert.equal((await waiting).status, 200);
  assert.equal(h.calls.filter((call) => call.endpoint === '/api/groups').length, 2);
  h.expire();
  await h.intervals[0]();
  await h.flush();
  h.rejectLogin();
  await h.signIn();
  assert.equal(h.nodes.get('browserLoginDialog').open, true);
  assert.match(h.nodes.get('browserLoginMessage').textContent, /Invalid user ID/);
  assert.equal(h.nodes.get('draft').value, 'unsaved competitor changes');
  assert.equal(h.nodes.get('browserLoginPassword').value, '');
});

test('old running server code produces an explicit restart instruction rather than a misleading password failure', async () => {
  const h = await harness();
  h.expire();
  await h.window.fetch('/api/rings/ring-a-1/queue', { method: 'POST' });
  await h.flush();
  h.useLegacySession();
  await h.signIn();
  assert.equal(h.nodes.get('browserLoginDialog').open, true);
  assert.match(h.nodes.get('browserLoginMessage').textContent, /server is still running older code/);
  assert.match(h.nodes.get('browserLoginMessage').textContent, /password may already have been accepted/);
  assert.equal(h.nodes.get('draft').value, 'unsaved competitor changes');
});

test('background session polling does not extend idle time, only trusted user activity does', async () => {
  const h = await harness();
  await h.intervals[0]();
  assert.equal(h.calls.some((call) => call.endpoint === '/api/account/activity'), false);
  h.advance();
  await h.handlers.pointerdown({ isTrusted: false });
  assert.equal(h.calls.some((call) => call.endpoint === '/api/account/activity'), false);
  await h.handlers.pointerdown({ isTrusted: true });
  await h.handlers.keydown({ isTrusted: true });
  assert.equal(h.calls.filter((call) => call.endpoint === '/api/account/activity').length, 1);
});

test('a different account in another tab cannot resume the original user draft', async () => {
  const h = await harness();
  h.switchAccount('another-user');
  const checking = h.intervals[0]();
  await h.flush();
  assert.equal(h.nodes.get('browserLoginDialog').open, true);
  assert.equal(h.nodes.get('browserLoginUser').value, 'operator');
  assert.match(h.nodes.get('browserLoginMessage').textContent, /original user/);
  await h.signIn();
  assert.match(h.nodes.get('browserLoginMessage').textContent, /original account/);
  assert.equal(h.nodes.get('browserLoginDialog').open, true);
  h.switchAccount('operator');
  await h.signIn();
  await checking;
  assert.equal(h.nodes.get('draft').value, 'unsaved competitor changes');
});
