const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const sqlite3 = require('sqlite3');
const { DEFAULT_ACCOUNT_POLICY, validateAccountPolicy } = require('./accountPolicy');

const scrypt = promisify(crypto.scrypt);
const IDLE_MS = 30 * 60 * 1000;
const ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const ROLES = ['administrator', 'judging-coordinator', 'tournament-operator'];
const HASH_OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

function invalid(message) {
  throw Object.assign(new Error(message), { statusCode: 400 });
}

function normalizeUserId(userId) {
  if (typeof userId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/.test(userId)) {
    invalid('User ID must be 3 to 64 letters, numbers, periods, underscores or hyphens, starting with a letter or number.');
  }
  return userId.toLowerCase();
}

function validateRoles(roles) {
  if (!Array.isArray(roles) || !roles.length || new Set(roles).size !== roles.length ||
      roles.some((role) => !ROLES.includes(role))) {
    invalid(`Select distinct roles from: ${ROLES.join(', ')}.`);
  }
  return [...roles].sort();
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = await scrypt(password, salt, 64, HASH_OPTIONS);
  return { salt, hash: hash.toString('hex') };
}

function validatePassword(password, policy) {
  if (typeof password !== 'string' || Array.from(password).length < policy.passwordMinLength ||
      Array.from(password).length > policy.passwordMaxLength) {
    invalid(`Password must contain ${policy.passwordMinLength} to ${policy.passwordMaxLength} characters. Spaces are allowed.`);
  }
}

function sessionDigest(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function publicAccount(row) {
  return { userId: row.user_id, roles: JSON.parse(row.roles), enabled: Boolean(row.enabled), revision: row.revision };
}

// Only trusted local setup code may call account mutation methods directly.
// Web handlers must enforce administrator authorization before calling them.
async function createAccountSessions({ file, now = Date.now }) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('An absolute account database path is required.');
  const root = fs.realpathSync(path.resolve(__dirname, '..'));
  function requirePrivatePath(candidate) {
    const relative = path.relative(root, candidate);
    if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
      throw new Error('Account database must be outside the web-served repository directory.');
    }
  }
  requirePrivatePath(path.resolve(file));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  requirePrivatePath(fs.realpathSync(path.dirname(file)));
  if (fs.existsSync(file)) requirePrivatePath(fs.realpathSync(file));
  const db = await new Promise((resolve, reject) => {
    const database = new sqlite3.Database(file, (error) => error ? reject(error) : resolve(database));
  });
  db.configure('busyTimeout', 5000);
  const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (error) { error ? reject(error) : resolve(this); });
  });
  const get = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
  });
  const all = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
  });
  const closeDatabase = () => new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  try {
    await run('PRAGMA foreign_keys = ON');
    await run(`CREATE TABLE IF NOT EXISTS accounts (
      user_id TEXT PRIMARY KEY, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
      roles TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
      revision INTEGER NOT NULL DEFAULT 1
    )`);
    await run(`CREATE TABLE IF NOT EXISTS browser_sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(user_id),
      account_revision INTEGER NOT NULL, created_at INTEGER NOT NULL, last_activity INTEGER NOT NULL
    )`);
    await run(`CREATE TABLE IF NOT EXISTS account_audit (
      id INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL, action TEXT NOT NULL,
      actor TEXT NOT NULL, user_id TEXT NOT NULL
    )`);
    await run(`CREATE TABLE IF NOT EXISTS login_attempts (
      account_key TEXT PRIMARY KEY, window_started INTEGER NOT NULL,
      failures INTEGER NOT NULL, blocked_until INTEGER NOT NULL
    )`);
    await run(`CREATE TABLE IF NOT EXISTS account_policy (
      id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, settings TEXT NOT NULL
    )`);
    await run('INSERT OR IGNORE INTO account_policy(id, revision, settings) VALUES (1, 1, ?)',
      [JSON.stringify(DEFAULT_ACCOUNT_POLICY)]);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    await closeDatabase();
    throw error;
  }

  let queue = Promise.resolve(), closed = false;
  function transaction(callback) {
    if (closed) return Promise.reject(new Error('Account database is closed.'));
    const result = queue.then(async () => {
      await run('BEGIN IMMEDIATE');
      try {
        const value = await callback();
        await run('COMMIT');
        return value;
      } catch (error) {
        try { await run('ROLLBACK'); }
        catch (rollbackError) { console.error('Unable to roll back account database transaction:', rollbackError); }
        throw error;
      }
    });
    // Keep subsequent operations usable after a rejected operation; callers
    // still receive the original rejection through result.
    queue = result.then(() => undefined, () => undefined);
    return result;
  }
  function audit(action, actor, userId) {
    if (typeof actor !== 'string' || !actor.trim() || actor.length > 100) invalid('An audit actor is required.');
    return run('INSERT INTO account_audit(timestamp, action, actor, user_id) VALUES (?, ?, ?, ?)',
      [now(), action, actor, userId]);
  }
  async function passwordMatches(password, account) {
    const candidate = await hashPassword(password, account.password_salt);
    const expected = Buffer.from(account.password_hash, 'hex');
    const actual = Buffer.from(candidate.hash, 'hex');
    if (expected.length !== 64) throw new Error('Invalid saved password hash.');
    return crypto.timingSafeEqual(actual, expected);
  }
  async function readPolicy() {
    const row = await get('SELECT revision, settings FROM account_policy WHERE id = 1');
    if (!row) throw new Error('Saved account policy is missing.');
    return { revision: row.revision, policy: validateAccountPolicy(JSON.parse(row.settings)) };
  }
  async function resolveSession(token, activity = false) {
    const { policy } = await readPolicy();
    const idleMs = policy.idleTimeoutMinutes * 60 * 1000;
    const absoluteMs = policy.absoluteTimeoutHours * 60 * 60 * 1000;
    if (typeof activity !== 'boolean') invalid('Activity must be true or false.');
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
    const digest = sessionDigest(token);
    const row = await get(`SELECT a.*, s.created_at, s.last_activity, s.account_revision
      FROM browser_sessions s JOIN accounts a ON a.user_id = s.user_id WHERE s.token_hash = ?`, [digest]);
    if (!row) return null;
    const timestamp = now();
    if (!row.enabled || row.account_revision !== row.revision ||
        timestamp >= row.created_at + absoluteMs || timestamp >= row.last_activity + idleMs) {
      await run('DELETE FROM browser_sessions WHERE token_hash = ?', [digest]);
      return null;
    }
    if (activity) await run('UPDATE browser_sessions SET last_activity = ? WHERE token_hash = ?', [timestamp, digest]);
    return { account: publicAccount(row), expiresAt: row.created_at + absoluteMs,
      idleExpiresAt: (activity ? timestamp : row.last_activity) + idleMs };
  }
  async function administratorActor(authorizationToken, actor) {
    if (authorizationToken === undefined) return actor;
    const session = await resolveSession(authorizationToken);
    if (!session) throw Object.assign(new Error('Sign in to continue.'), { statusCode: 401 });
    if (!session.account.roles.includes('administrator')) {
      throw Object.assign(new Error('Administrator permission is required.'), { statusCode: 403 });
    }
    return session.account.userId;
  }

  return {
    getPolicy(authorizationToken) {
      return transaction(async () => {
        await administratorActor(authorizationToken);
        return readPolicy();
      });
    },
    changePolicy({ revision, policy, actor, authorizationToken }) {
      return transaction(async () => {
        actor = await administratorActor(authorizationToken, actor);
        const saved = await readPolicy();
        if (revision !== saved.revision) {
          throw Object.assign(new Error('Account policy changed. Reload before saving.'), { statusCode: 409 });
        }
        policy = validateAccountPolicy(policy);
        if (JSON.stringify(policy) === JSON.stringify(saved.policy)) return saved;
        await run('UPDATE account_policy SET revision = revision + 1, settings = ? WHERE id = 1',
          [JSON.stringify(policy)]);
        await run('DELETE FROM browser_sessions');
        await run('DELETE FROM login_attempts');
        await audit('account-policy-changed-sessions-revoked', actor, '*');
        return readPolicy();
      });
    },
    createAccount({ userId, password, roles, actor, authorizationToken }) {
      return transaction(async () => {
        actor = await administratorActor(authorizationToken, actor);
        const { policy } = await readPolicy();
        userId = normalizeUserId(userId);
        if (userId.length < policy.userIdMinLength || userId.length > policy.userIdMaxLength) {
          invalid(`User ID must contain ${policy.userIdMinLength} to ${policy.userIdMaxLength} characters.`);
        }
        validatePassword(password, policy);
        roles = validateRoles(roles);
        if (await get('SELECT user_id FROM accounts WHERE user_id = ?', [userId])) {
          throw Object.assign(new Error('User ID already exists.'), { statusCode: 409 });
        }
        const passwordData = await hashPassword(password);
        await run('INSERT INTO accounts(user_id, password_salt, password_hash, roles, enabled) VALUES (?, ?, ?, ?, 1)',
          [userId, passwordData.salt, passwordData.hash, JSON.stringify(roles)]);
        await audit('account-created', actor, userId);
        return publicAccount(await get('SELECT * FROM accounts WHERE user_id = ?', [userId]));
      });
    },
    changeAccount({ userId, revision, roles, enabled, password, actor, authorizationToken }) {
      return transaction(async () => {
        actor = await administratorActor(authorizationToken, actor);
        const { policy } = await readPolicy();
        userId = normalizeUserId(userId);
        const account = await get('SELECT * FROM accounts WHERE user_id = ?', [userId]);
        if (!account) throw Object.assign(new Error('Account not found.'), { statusCode: 404 });
        if (revision !== account.revision) {
          throw Object.assign(new Error('Account changed. Reload before saving.'), { statusCode: 409 });
        }
        if (roles === undefined && enabled === undefined && password === undefined) invalid('An account change is required.');
        const nextRoles = roles === undefined ? JSON.parse(account.roles) : validateRoles(roles);
        const nextEnabled = enabled === undefined ? Boolean(account.enabled) : enabled;
        if (typeof nextEnabled !== 'boolean') invalid('Enabled must be true or false.');
        if (account.enabled && JSON.parse(account.roles).includes('administrator') &&
            (!nextEnabled || !nextRoles.includes('administrator'))) {
          const others = await all('SELECT roles FROM accounts WHERE enabled = 1 AND user_id <> ?', [userId]);
          if (!others.some((row) => JSON.parse(row.roles).includes('administrator'))) {
            throw Object.assign(new Error('Cannot remove the last enabled administrator.'), { statusCode: 409 });
          }
        }
        let passwordData = { salt: account.password_salt, hash: account.password_hash };
        if (password !== undefined) {
          validatePassword(password, policy);
          passwordData = await hashPassword(password);
        }
        await run(`UPDATE accounts SET password_salt = ?, password_hash = ?, roles = ?, enabled = ?,
          revision = revision + 1 WHERE user_id = ?`,
        [passwordData.salt, passwordData.hash, JSON.stringify(nextRoles), Number(nextEnabled), userId]);
        const rolesChanged = JSON.stringify(nextRoles) !== account.roles;
        const revoke = !nextEnabled || password !== undefined && policy.revokeOnPasswordReset ||
          rolesChanged && policy.revokeOnRoleChange;
        if (revoke) await run('DELETE FROM browser_sessions WHERE user_id = ?', [userId]);
        else await run('UPDATE browser_sessions SET account_revision = ? WHERE user_id = ?',
          [account.revision + 1, userId]);
        await audit(revoke ? 'account-changed-sessions-revoked' : 'account-changed', actor, userId);
        return publicAccount(await get('SELECT * FROM accounts WHERE user_id = ?', [userId]));
      });
    },
    async login({ userId, password }) {
      const result = await transaction(async () => {
        const { policy } = await readPolicy();
        const failureWindowMs = policy.failureWindowMinutes * 60 * 1000;
        const cooldownMs = policy.cooldownMinutes * 60 * 1000;
        const idleMs = policy.idleTimeoutMinutes * 60 * 1000;
        const absoluteMs = policy.absoluteTimeoutHours * 60 * 60 * 1000;
        const validInput = typeof userId === 'string' && typeof password === 'string' &&
          password.length <= 512 && /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/.test(userId);
        const accountKey = sessionDigest(validInput ? userId.toLowerCase() : 'invalid-input');
        const timestamp = now();
        await run('DELETE FROM login_attempts WHERE window_started <= ? AND blocked_until <= ?',
          [timestamp - failureWindowMs, timestamp]);
        let attempts = await get('SELECT * FROM login_attempts WHERE account_key = ?', [accountKey]);
        if (attempts && timestamp < attempts.blocked_until) {
          return { error: Object.assign(new Error('Too many login attempts. Try again shortly.'),
            { statusCode: 429, retryAfterSeconds: Math.ceil((attempts.blocked_until - timestamp) / 1000) }) };
        }
        if (attempts && (attempts.blocked_until > 0 || timestamp >= attempts.window_started + failureWindowMs)) {
          attempts = null;
        }
        const account = validInput ? await get('SELECT * FROM accounts WHERE user_id = ?', [userId.toLowerCase()]) : null;
        // Unknown users take the same hashing path and return the same response.
        const matches = await passwordMatches(validInput ? password : '', account || {
          password_salt: '00000000000000000000000000000000', password_hash: '00'.repeat(64)
        });
        if (!account || !matches || !account.enabled) {
          const failures = (attempts ? attempts.failures : 0) + 1;
          await run(`INSERT OR REPLACE INTO login_attempts(account_key, window_started, failures, blocked_until)
            VALUES (?, ?, ?, ?)`, [accountKey, attempts ? attempts.window_started : timestamp,
            failures, failures >= policy.failureThreshold ? timestamp + cooldownMs : 0]);
          return { error: Object.assign(new Error('Invalid user ID or password.'), { statusCode: 401 }) };
        }
        await run('DELETE FROM login_attempts WHERE account_key = ?', [accountKey]);
        await run('DELETE FROM browser_sessions WHERE created_at <= ? OR last_activity <= ?',
          [timestamp - absoluteMs, timestamp - idleMs]);
        if (!policy.allowConcurrentSessions) {
          await run('DELETE FROM browser_sessions WHERE user_id = ?', [account.user_id]);
        }
        const token = crypto.randomBytes(32).toString('hex');
        await run(`INSERT INTO browser_sessions(token_hash, user_id, account_revision, created_at, last_activity)
          VALUES (?, ?, ?, ?, ?)`, [sessionDigest(token), account.user_id, account.revision, timestamp, timestamp]);
        return { token, account: publicAccount(account), expiresAt: timestamp + absoluteMs };
      });
      // Commit failed-attempt counters before surfacing the rejected login.
      if (result.error) throw result.error;
      return result;
    },
    resolveSession(token, { activity = false } = {}) {
      return transaction(() => resolveSession(token, activity));
    },
    logout(token) {
      return transaction(async () => {
        if (typeof token === 'string' && TOKEN_PATTERN.test(token)) {
          const { policy } = await readPolicy();
          if (policy.logoutAllSessions) {
            await run(`DELETE FROM browser_sessions WHERE user_id = (
              SELECT user_id FROM browser_sessions WHERE token_hash = ?)`, [sessionDigest(token)]);
          } else await run('DELETE FROM browser_sessions WHERE token_hash = ?', [sessionDigest(token)]);
        }
      });
    },
    listAccounts(authorizationToken) {
      return transaction(async () => {
        await administratorActor(authorizationToken);
        return (await all('SELECT * FROM accounts ORDER BY user_id')).map(publicAccount);
      });
    },
    async close() {
      if (closed) throw new Error('Account database is already closed.');
      closed = true;
      await queue;
      await closeDatabase();
    }
  };
}

module.exports = { createAccountSessions, IDLE_MS, ABSOLUTE_MS, ROLES };
