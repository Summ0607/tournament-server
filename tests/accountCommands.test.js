const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3');
const { createAccountSessions } = require('../backend/accountSessions');
const { DEFAULT_ACCOUNT_POLICY } = require('../backend/accountPolicy');
const { parseArguments, readHiddenPassword, runAccountCommand } = require('../backend/accountCommands');

const password = 'A long setup passphrase1!';
const replacement = 'A new recovery passphrase1!';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tournament-account-commands-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'accounts.db');
}
function terminal(passwords = [password, password]) {
  let text = '', prompts = 0;
  return {
    input: { isTTY: true },
    output: { isTTY: true, write(value) { text += value; } },
    async readPassword() { return passwords[prompts++]; },
    get text() { return text; },
    get prompts() { return prompts; }
  };
}
function args(file, command = 'create', user = 'admin', roles = 'administrator') {
  return [command, '--database', file, '--user', user, ...(command === 'create' ? ['--roles', roles] : [])];
}
async function rows(file, sql) {
  const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY);
  try {
    return await new Promise((resolve, reject) => db.all(sql, (error, result) => error ? reject(error) : resolve(result)));
  } finally {
    await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  }
}

test('local commands reject password arguments, malformed options and redirected entry without disclosing values', async (t) => {
  const file = fixture(t);
  assert.equal(parseArguments(args(file, 'create', 'ADMIN')).userId, 'admin');
  for (const options of [
    [...args(file), '--password', password], [...args(file), password],
    [...args(file), '--user', 'other'], ['create'], args(file, 'unknown'),
    args('relative.db'), args(file, 'create', '../admin'), args(file, 'create', 'admin', 'invalid'),
    args(file, 'recover-admin').concat('--roles', 'administrator')
  ]) {
    assert.throws(() => parseArguments(options));
  }
  const cli = path.join(__dirname, '..', 'backend', 'accountCommands.js');
  for (const options of [args(file), [...args(file), '--password', password]]) {
    const result = spawnSync(process.execPath, [cli, ...options], { encoding: 'utf8', input: password });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Account command failed:/);
    assert.equal((result.stdout + result.stderr).includes(password), false);
  }
  assert.equal(fs.existsSync(file), false);
  await assert.rejects(readHiddenPassword('Password: ', { isTTY: false }, { isTTY: true }), /interactive terminal/);
});

test('hidden terminal entry never echoes secrets and restores terminal on completion and cancellation', async () => {
  for (const cancel of [false, true]) {
    const input = new PassThrough();
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (value) => { input.isRaw = value; };
    input.pause();
    let text = '';
    const output = { isTTY: true, write(value) { text += value; } };
    const pending = readHiddenPassword('Password (hidden): ', input, output);
    const rejected = cancel ? assert.rejects(pending, /interrupted/) : null;
    assert.equal(input.isRaw, true);
    input.write('secretx\b \u{1f600}');
    input.write(cancel ? '\x03' : '\r');
    if (cancel) await rejected;
    else assert.equal(await pending, 'secret \u{1f600}');
    assert.equal(text, 'Password (hidden): \n');
    assert.equal(input.isRaw, false);
    assert.equal(input.isPaused(), true);
    assert.equal(input.listenerCount('keypress'), 0);
    input.destroy();
  }
});

test('setup creates explicit roles with hidden confirmation, hashes passwords and records the local OS actor', async (t) => {
  const file = fixture(t), io = terminal();
  await runAccountCommand(args(file), io);
  await runAccountCommand(args(file, 'create', 'coordinator', 'judging-coordinator'), terminal());
  await runAccountCommand(args(file, 'create', 'operator', 'tournament-operator'), terminal());
  assert.equal(io.prompts, 2);
  assert.match(io.text, /10-128 characters.*uppercase.*lowercase.*number.*special/);
  assert.equal(io.text.includes(password), false);
  const store = await createAccountSessions({ file });
  try {
    assert.equal((await store.listAccounts()).length, 3);
    assert.equal((await store.login({ userId: 'admin', password })).account.roles[0], 'administrator');
  } finally { await store.close(); }
  const audit = await rows(file, 'SELECT * FROM account_audit');
  assert.equal(audit.length, 3);
  assert.ok(audit.every((row) => row.action === 'account-created' && row.actor === `local:${os.userInfo().username}`));
  assert.equal(JSON.stringify(await rows(file, 'SELECT * FROM accounts')).includes(password), false);
});

test('failed setup and invalid recovery do not change accounts or audit records', async (t) => {
  const file = fixture(t);
  await assert.rejects(runAccountCommand(args(file), terminal([password, replacement])), /do not match/);
  await assert.rejects(runAccountCommand(args(file), terminal(['short', 'short'])), /Password must/);
  const cancelled = terminal();
  cancelled.readPassword = async () => { throw new Error('Password entry interrupted.'); };
  await assert.rejects(runAccountCommand(args(file), cancelled), /interrupted/);
  assert.deepEqual(await rows(file, 'SELECT * FROM accounts'), []);
  assert.deepEqual(await rows(file, 'SELECT * FROM account_audit'), []);
  await runAccountCommand(args(file, 'create', 'operator', 'tournament-operator'), terminal());
  for (const user of ['operator', 'missing']) {
    const io = terminal();
    await assert.rejects(runAccountCommand(args(file, 'recover-admin', user), io), /existing administrator/);
    assert.equal(io.prompts, 0);
  }
  const duplicate = terminal();
  await assert.rejects(runAccountCommand(args(file, 'create', 'operator'), duplicate), /already exists/);
  assert.equal(duplicate.prompts, 0);
  assert.equal((await rows(file, 'SELECT * FROM account_audit')).length, 1);
  const missingFile = path.join(path.dirname(file), 'missing.db');
  await assert.rejects(runAccountCommand(args(missingFile, 'recover-admin'), terminal()), /ENOENT/);
  assert.equal(fs.existsSync(missingFile), false);
});

test('setup and recovery obey saved password policy and preserve administrator roles on failed recovery', async (t) => {
  const file = fixture(t);
  await runAccountCommand(args(file, 'create', 'admin', 'administrator,tournament-operator'), terminal());
  let store = await createAccountSessions({ file });
  try {
    const saved = await store.getPolicy();
    await store.changePolicy({ revision: saved.revision,
      policy: { ...saved.policy, passwordMinLength: 30 }, actor: 'test' });
  } finally { await store.close(); }
  await assert.rejects(runAccountCommand(args(file, 'recover-admin'), terminal()), /Password must contain 30/);
  await assert.rejects(runAccountCommand(args(file, 'create', 'coordinator', 'judging-coordinator'), terminal()),
    /Password must contain 30/);
  assert.equal((await rows(file, 'SELECT * FROM account_audit')).length, 2);
  const longer = 'An administrator recovery password of sufficient length1!';
  await runAccountCommand(args(file, 'recover-admin'), terminal([longer, longer]));
  store = await createAccountSessions({ file });
  try {
    const login = await store.login({ userId: 'admin', password: longer });
    assert.deepEqual(login.account.roles, ['administrator', 'tournament-operator']);
  } finally { await store.close(); }
});

test('administrator recovery always revokes selected sessions and cooldown, preserves others and survives restart', async (t) => {
  const file = fixture(t);
  await runAccountCommand(args(file), terminal());
  await runAccountCommand(args(file, 'create', 'second-admin'), terminal());
  let store = await createAccountSessions({ file });
  const saved = await store.getPolicy();
  await store.changePolicy({ revision: saved.revision,
    policy: { ...DEFAULT_ACCOUNT_POLICY, revokeOnPasswordReset: false }, actor: 'test' });
  const first = await store.login({ userId: 'admin', password });
  const second = await store.login({ userId: 'admin', password });
  const other = await store.login({ userId: 'second-admin', password });
  for (let attempt = 0; attempt < 5; attempt++) {
    await assert.rejects(store.login({ userId: 'admin', password: 'wrong' }), { statusCode: 401 });
  }
  await assert.rejects(store.login({ userId: 'admin', password }), { statusCode: 429 });
  await store.close();
  const io = terminal([replacement, replacement]);
  await runAccountCommand(args(file, 'recover-admin'), io);
  assert.equal(io.text.includes(replacement), false);
  store = await createAccountSessions({ file });
  try {
    assert.equal(await store.resolveSession(first.token), null);
    assert.equal(await store.resolveSession(second.token), null);
    assert.ok(await store.resolveSession(other.token));
    await assert.rejects(store.login({ userId: 'admin', password }), { statusCode: 401 });
    assert.ok(await store.login({ userId: 'admin', password: replacement }));
    const admin = (await store.listAccounts()).find((account) => account.userId === 'admin');
    await store.changeAccount({ userId: 'admin', revision: admin.revision, enabled: false, actor: 'test' });
  } finally { await store.close(); }
  await runAccountCommand(args(file, 'recover-admin'), terminal());
  store = await createAccountSessions({ file });
  try {
    const login = await store.login({ userId: 'admin', password });
    assert.equal(login.account.enabled, true);
    assert.deepEqual(login.account.roles, ['administrator']);
  } finally { await store.close(); }
  const audit = await rows(file, "SELECT * FROM account_audit WHERE action = 'administrator-recovered-sessions-revoked'");
  assert.equal(audit.length, 2);
  assert.ok(audit.every((row) => row.user_id === 'admin' && row.actor === `local:${os.userInfo().username}`));
});

test('recovery transaction rejects stale revisions and invalid audit actors without changing credentials or sessions', async (t) => {
  const file = fixture(t);
  await runAccountCommand(args(file), terminal());
  const store = await createAccountSessions({ file });
  try {
    const account = (await store.listAccounts())[0];
    const session = await store.login({ userId: 'admin', password });
    for (const changes of [{ revision: 0 }, { password: 'short' }, { actor: '' }]) {
      await assert.rejects(store.recoverAdministrator({ userId: 'admin', revision: account.revision,
        password: replacement, actor: 'test', ...changes }));
    }
    assert.deepEqual((await store.listAccounts())[0], account);
    assert.ok(await store.resolveSession(session.token));
    assert.ok(await store.login({ userId: 'admin', password }));
    assert.equal((await rows(file, 'SELECT * FROM account_audit')).length, 1);
  } finally { await store.close(); }
});
