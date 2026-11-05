const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const sqlite3 = require('sqlite3');
const { createAccountSessions, IDLE_MS, ABSOLUTE_MS } = require('../backend/accountSessions');
const { DEFAULT_ACCOUNT_POLICY, validateAccountPolicy } = require('../backend/accountPolicy');

const password = 'a long demo passphrase';
async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tournament-accounts-'));
  let timestamp = 1000000;
  const file = path.join(root, 'accounts.db');
  let store = await createAccountSessions({ file, now: () => timestamp });
  t.after(async () => {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { file, get store() { return store; },
    setTime: (value) => { timestamp = value; },
    advance: (value) => { timestamp += value; },
    async reopen() {
      await store.close();
      store = await createAccountSessions({ file, now: () => timestamp });
    },
    create: (userId, roles = ['judging-coordinator']) =>
      store.createAccount({ userId, roles, password, actor: 'local-setup' })
  };
}

test('accounts validate inputs, preserve passphrases, hash secrets and do not disclose them', async (t) => {
  const p = await setup(t);
  for (const userId of ['', 'ab', ' spaced ', '../admin']) {
    await assert.rejects(p.create(userId), /User ID must/);
  }
  for (const value of ['short', 'a'.repeat(129), null]) {
    await assert.rejects(p.store.createAccount({ userId: 'admin', roles: ['administrator'],
      password: value, actor: 'local-setup' }), /Password must/);
  }
  await assert.rejects(p.create('admin', ['invalid-role']), /Select distinct roles/);
  await assert.rejects(p.create('admin', ['administrator', 'administrator']), /Select distinct roles/);
  const account = await p.create('Admin', ['administrator']);
  assert.deepEqual(account, { userId: 'admin', roles: ['administrator'], enabled: true, revision: 1 });
  await assert.rejects(p.create('ADMIN'), /already exists/);
  const login = await p.store.login({ userId: 'ADMIN', password });
  assert.match(login.token, /^[a-f0-9]{64}$/);
  assert.deepEqual(await p.store.listAccounts(), [account]);
  await assert.rejects(p.store.createAccount({ userId: 'no-audit', password,
    roles: ['administrator'], actor: '' }), /audit actor/);
  assert.deepEqual(await p.store.listAccounts(), [account]);
  for (const credentials of [{ userId: 'missing', password }, { userId: 'admin', password: 'bad' },
    { userId: null, password: null }]) {
    await assert.rejects(p.store.login(credentials), { message: 'Invalid user ID or password.', statusCode: 401 });
  }
  const db = new sqlite3.Database(p.file, sqlite3.OPEN_READONLY);
  try {
    const rows = await new Promise((resolve, reject) => db.all('SELECT * FROM accounts', (error, rows) => error ? reject(error) : resolve(rows)));
    assert.match(rows[0].password_hash, /^[a-f0-9]{128}$/);
    assert.match(rows[0].password_salt, /^[a-f0-9]{32}$/);
    const session = await new Promise((resolve, reject) => db.get('SELECT * FROM browser_sessions', (error, row) => error ? reject(error) : resolve(row)));
    assert.notEqual(session.token_hash, login.token);
    assert.equal(JSON.stringify(rows).includes(password), false);
  } finally {
    await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  }
});

test('browser sessions use exact idle boundaries; polling does not extend inactivity', async (t) => {
  const p = await setup(t);
  await p.create('coordinator');
  const { token } = await p.store.login({ userId: 'coordinator', password });
  p.advance(IDLE_MS - 1);
  const session = await p.store.resolveSession(token);
  assert.ok(session);
  assert.equal(session.idleExpiresAt, 1000000 + IDLE_MS);
  p.advance(1);
  assert.equal(await p.store.resolveSession(token), null);
  assert.equal(await p.store.resolveSession(token, { activity: true }), null);
});

test('activity extends idle time but never the exact twelve-hour absolute deadline', async (t) => {
  const p = await setup(t);
  await p.create('operator', ['tournament-operator']);
  const { token, expiresAt } = await p.store.login({ userId: 'operator', password });
  for (let elapsed = 20 * 60 * 1000; elapsed < ABSOLUTE_MS; elapsed += 20 * 60 * 1000) {
    p.setTime(1000000 + elapsed);
    const session = await p.store.resolveSession(token, { activity: true });
    assert.ok(session);
    assert.equal(session.expiresAt, expiresAt);
  }
  p.setTime(expiresAt - 1);
  assert.ok(await p.store.resolveSession(token, { activity: true }));
  p.setTime(expiresAt);
  assert.equal(await p.store.resolveSession(token), null);
});

test('multiple sessions survive restart; logout affects only the selected session', async (t) => {
  const p = await setup(t);
  await p.create('coordinator');
  const first = await p.store.login({ userId: 'coordinator', password });
  const second = await p.store.login({ userId: 'coordinator', password });
  assert.notEqual(first.token, second.token);
  await p.reopen();
  assert.ok(await p.store.resolveSession(first.token));
  assert.ok(await p.store.resolveSession(second.token));
  await p.store.logout(first.token);
  assert.equal(await p.store.resolveSession(first.token), null);
  assert.ok(await p.store.resolveSession(second.token));
  assert.equal(await p.store.resolveSession('invalid'), null);
});

test('disable, password reset and role changes revoke all sessions persistently', async (t) => {
  const p = await setup(t);
  let account = await p.create('coordinator');
  for (const change of [{ roles: ['tournament-operator'] }, { password: 'a replacement passphrase' }, { enabled: false }]) {
    const currentPassword = account.revision > 2 ? 'a replacement passphrase' : password;
    const first = await p.store.login({ userId: 'coordinator', password: currentPassword });
    const second = await p.store.login({ userId: 'coordinator', password: currentPassword });
    account = await p.store.changeAccount({ userId: 'coordinator', revision: account.revision, actor: 'admin', ...change });
    await p.reopen();
    assert.equal(await p.store.resolveSession(first.token), null);
    assert.equal(await p.store.resolveSession(second.token), null);
    if (change.password) {
      await assert.rejects(p.store.login({ userId: 'coordinator', password }),
        { statusCode: 401, message: 'Invalid user ID or password.' });
    }
  }
  await assert.rejects(p.store.login({ userId: 'coordinator', password: 'a replacement passphrase' }),
    { statusCode: 401, message: 'Invalid user ID or password.' });
});

test('password bounds count Unicode characters and preserve leading/trailing spaces', async (t) => {
  const p = await setup(t);
  for (const [userId, value] of [['minimum', ' '.repeat(2) + 'x'.repeat(11) + ' '.repeat(2)],
    ['unicode', '\u{1F512}'.repeat(15)], ['maximum', 'x'.repeat(128)]]) {
    await p.store.createAccount({ userId, password: value, roles: ['administrator'], actor: 'local-setup' });
    assert.ok((await p.store.login({ userId, password: value })).token);
    await assert.rejects(p.store.login({ userId, password: value.slice(1) }), { statusCode: 401 });
  }
});

test('serialized account changes reject a concurrent stale revision', async (t) => {
  const p = await setup(t);
  await p.create('coordinator');
  const { token } = await p.store.login({ userId: 'coordinator', password });
  const results = await Promise.allSettled([
    p.store.changeAccount({ userId: 'coordinator', revision: 1, roles: ['tournament-operator'], actor: 'admin' }),
    p.store.changeAccount({ userId: 'coordinator', revision: 1, enabled: false, actor: 'admin' })
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.statusCode, 409);
  assert.equal(await p.store.resolveSession(token), null);
  assert.deepEqual(await p.store.listAccounts(),
    [{ userId: 'coordinator', revision: 2, roles: ['tournament-operator'], enabled: true }]);
});

test('five failures trigger a persistent five-minute cooldown for known and unknown accounts', async (t) => {
  const p = await setup(t);
  await p.create('coordinator');
  for (const userId of ['COORDINATOR', 'unknown-user']) {
    for (let attempt = 0; attempt < 5; attempt++) {
      await assert.rejects(p.store.login({ userId, password: 'wrong' }), { statusCode: 401 });
    }
  }
  await p.reopen();
  for (const userId of ['coordinator', 'unknown-user']) {
    await assert.rejects(p.store.login({ userId, password }), { statusCode: 429, retryAfterSeconds: 300 });
  }
  p.advance(5 * 60 * 1000 - 1);
  await assert.rejects(p.store.login({ userId: 'coordinator', password }), { statusCode: 429, retryAfterSeconds: 1 });
  p.advance(1);
  assert.ok((await p.store.login({ userId: 'coordinator', password })).token);
  await assert.rejects(p.store.login({ userId: 'unknown-user', password }), { statusCode: 401 });
});

test('failure windows expire at fifteen minutes and successful login clears failures', async (t) => {
  const p = await setup(t);
  await p.create('coordinator');
  for (let attempt = 0; attempt < 4; attempt++) {
    await assert.rejects(p.store.login({ userId: 'coordinator', password: 'wrong' }), { statusCode: 401 });
  }
  p.advance(15 * 60 * 1000);
  await assert.rejects(p.store.login({ userId: 'coordinator', password: 'wrong' }), { statusCode: 401 });
  assert.ok((await p.store.login({ userId: 'coordinator', password })).token);
  for (let attempt = 0; attempt < 4; attempt++) {
    await assert.rejects(p.store.login({ userId: 'coordinator', password: 'wrong' }), { statusCode: 401 });
  }
  assert.ok((await p.store.login({ userId: 'coordinator', password })).token);
});

test('stale or invalid account changes roll back without revoking sessions', async (t) => {
  const p = await setup(t);
  const account = await p.create('admin', ['administrator']);
  const { token } = await p.store.login({ userId: 'admin', password });
  for (const change of [{ revision: 0, enabled: false }, { enabled: 'false' },
    { password: 'short' }, { enabled: false }, { roles: ['judging-coordinator'] }, { actor: '' }]) {
    await assert.rejects(p.store.changeAccount({ userId: 'admin', revision: account.revision,
      actor: 'local-setup', roles: ['administrator'], ...change }));
    assert.ok(await p.store.resolveSession(token));
    assert.deepEqual(await p.store.listAccounts(), [account]);
  }
  await p.create('second-admin', ['administrator']);
  await p.store.changeAccount({ userId: 'admin', revision: 1, enabled: false, actor: 'second-admin' });
  assert.equal(await p.store.resolveSession(token), null);
});

test('account storage rejects paths inside the web-served repository', async () => {
  await assert.rejects(createAccountSessions({ file: path.join(__dirname, '..', 'security.db') }),
    /outside the web-served repository/);
  await assert.rejects(createAccountSessions({ file: 'relative.db' }), /absolute account database path/);
});

test('policy validates all settings and cross-field safety limits', () => {
  assert.deepEqual(validateAccountPolicy(DEFAULT_ACCOUNT_POLICY), DEFAULT_ACCOUNT_POLICY);
  for (const change of [
    { passwordMinLength: 14 }, { passwordMaxLength: 63 }, { passwordMaxLength: 129 },
    { userIdMinLength: 2 }, { userIdMaxLength: 65 }, { userIdMinLength: 20, userIdMaxLength: 10 },
    { passwordMinLength: 100, passwordMaxLength: 64 }, { idleTimeoutMinutes: 4 },
    { idleTimeoutMinutes: 121 }, { absoluteTimeoutHours: 0 }, { absoluteTimeoutHours: 25 },
    { idleTimeoutMinutes: 120, absoluteTimeoutHours: 1 }, { failureThreshold: 2 },
    { failureThreshold: 11 }, { failureWindowMinutes: 0 }, { cooldownMinutes: 61 },
    { cooldownMinutes: 1.5 }, { allowConcurrentSessions: 'true' }, { unknown: 1 }
  ]) {
    assert.throws(() => validateAccountPolicy({ ...DEFAULT_ACCOUNT_POLICY, ...change }), { statusCode: 400 });
  }
  const missing = { ...DEFAULT_ACCOUNT_POLICY };
  delete missing.logoutAllSessions;
  assert.throws(() => validateAccountPolicy(missing), { statusCode: 400 });
});

test('policy persists across restarts and revokes every browser session only when changed', async (t) => {
  const p = await setup(t);
  await p.create('coordinator');
  const first = await p.store.login({ userId: 'coordinator', password });
  const second = await p.store.login({ userId: 'coordinator', password });
  const initial = await p.store.getPolicy();
  assert.deepEqual(initial, { revision: 1, policy: DEFAULT_ACCOUNT_POLICY });
  assert.deepEqual(await p.store.changePolicy({ ...initial, actor: 'admin' }), initial);
  assert.ok(await p.store.resolveSession(first.token));
  const policy = { ...initial.policy, idleTimeoutMinutes: 5, absoluteTimeoutHours: 1 };
  await assert.rejects(p.store.changePolicy({ revision: 0, policy, actor: 'admin' }), { statusCode: 409 });
  await assert.rejects(p.store.changePolicy({ revision: 1, policy, actor: '' }), { statusCode: 400 });
  assert.deepEqual(await p.store.getPolicy(), initial);
  assert.ok(await p.store.resolveSession(first.token));
  const saved = await p.store.changePolicy({ revision: 1, policy, actor: 'admin' });
  assert.deepEqual(saved, { revision: 2, policy });
  await p.reopen();
  assert.deepEqual(await p.store.getPolicy(), saved);
  assert.equal(await p.store.resolveSession(first.token), null);
  assert.equal(await p.store.resolveSession(second.token), null);
  const login = await p.store.login({ userId: 'coordinator', password });
  assert.equal(login.expiresAt, 1000000 + 60 * 60 * 1000);
  p.advance(5 * 60 * 1000);
  assert.equal(await p.store.resolveSession(login.token), null);
});

test('new identifier/password bounds apply to creation and reset, not existing logins', async (t) => {
  const p = await setup(t);
  const account = await p.create('short');
  await p.store.changePolicy({ revision: 1, actor: 'admin', policy: {
    ...DEFAULT_ACCOUNT_POLICY, userIdMinLength: 8, userIdMaxLength: 12,
    passwordMinLength: 30, passwordMaxLength: 64
  } });
  assert.ok((await p.store.login({ userId: 'short', password })).token);
  await assert.rejects(p.create('new'), /User ID must/);
  await assert.rejects(p.create('a'.repeat(13)), /User ID must/);
  await assert.rejects(p.create('new-person'), /Password must contain 30 to 64/);
  await assert.rejects(p.store.changeAccount({ userId: 'short', revision: account.revision,
    password, actor: 'admin' }), /Password must contain 30 to 64/);
  await p.store.createAccount({ userId: 'new-person', password: 'x'.repeat(30),
    roles: ['administrator'], actor: 'admin' });
  await assert.rejects(p.store.createAccount({ userId: 'too-long', password: 'x'.repeat(65),
    roles: ['administrator'], actor: 'admin' }), /Password must/);
});

test('concurrency and logout policies control the expected sessions', async (t) => {
  const p = await setup(t);
  await p.create('coordinator');
  let saved = await p.store.changePolicy({ revision: 1, actor: 'admin',
    policy: { ...DEFAULT_ACCOUNT_POLICY, allowConcurrentSessions: false } });
  const first = await p.store.login({ userId: 'coordinator', password });
  const second = await p.store.login({ userId: 'coordinator', password });
  assert.equal(await p.store.resolveSession(first.token), null);
  assert.ok(await p.store.resolveSession(second.token));
  saved = await p.store.changePolicy({ revision: saved.revision, actor: 'admin',
    policy: { ...saved.policy, allowConcurrentSessions: true, logoutAllSessions: true } });
  const third = await p.store.login({ userId: 'coordinator', password });
  const fourth = await p.store.login({ userId: 'coordinator', password });
  await p.store.logout(third.token);
  assert.equal(await p.store.resolveSession(third.token), null);
  assert.equal(await p.store.resolveSession(fourth.token), null);
});

test('optional account-change revocation keeps sessions current but disabling always blocks access', async (t) => {
  const p = await setup(t);
  await p.create('coordinator');
  await p.store.changePolicy({ revision: 1, actor: 'admin',
    policy: { ...DEFAULT_ACCOUNT_POLICY, revokeOnRoleChange: false, revokeOnPasswordReset: false } });
  const { token } = await p.store.login({ userId: 'coordinator', password });
  let account = await p.store.changeAccount({ userId: 'coordinator', revision: 1,
    roles: ['tournament-operator'], actor: 'admin' });
  assert.deepEqual((await p.store.resolveSession(token)).account.roles, ['tournament-operator']);
  account = await p.store.changeAccount({ userId: 'coordinator', revision: account.revision,
    password: 'replacement password phrase', actor: 'admin' });
  await p.reopen();
  assert.ok(await p.store.resolveSession(token));
  await p.store.changeAccount({ userId: 'coordinator', revision: account.revision, enabled: false, actor: 'admin' });
  assert.equal(await p.store.resolveSession(token), null);
});

test('configurable failed-login threshold, window and cooldown use exact boundaries', async (t) => {
  const p = await setup(t);
  await p.create('coordinator');
  await p.store.changePolicy({ revision: 1, actor: 'admin',
    policy: { ...DEFAULT_ACCOUNT_POLICY, failureThreshold: 3, failureWindowMinutes: 1, cooldownMinutes: 1 } });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(p.store.login({ userId: 'coordinator', password: 'wrong' }), { statusCode: 401 });
  }
  p.advance(60 * 1000);
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(p.store.login({ userId: 'coordinator', password: 'wrong' }), { statusCode: 401 });
  }
  await assert.rejects(p.store.login({ userId: 'coordinator', password }), { statusCode: 429, retryAfterSeconds: 60 });
  p.advance(60 * 1000);
  assert.ok((await p.store.login({ userId: 'coordinator', password })).token);
});
