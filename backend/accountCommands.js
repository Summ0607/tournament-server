const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { createAccountSessions, ROLES } = require('./accountSessions');

function parseArguments(args) {
  const [command, ...options] = args;
  if (!['create', 'recover-admin'].includes(command)) {
    throw new Error('Use create or recover-admin with --database and --user; create also requires --roles.');
  }
  const allowed = command === 'create' ? ['--database', '--user', '--roles'] : ['--database', '--user'];
  const values = {};
  for (let index = 0; index < options.length; index += 2) {
    const name = options[index], value = options[index + 1];
    if (!allowed.includes(name) || Object.hasOwn(values, name) ||
        !value || value.startsWith('--')) {
      throw new Error('Invalid command options. Password arguments are not accepted.');
    }
    values[name] = value;
  }
  if (allowed.some((name) => !values[name])) throw new Error(`Required options: ${allowed.join(', ')}.`);
  if (!path.isAbsolute(values['--database'])) throw new Error('An absolute account database path is required.');
  const roles = values['--roles']?.split(',');
  if (roles && (new Set(roles).size !== roles.length || roles.some((role) => !ROLES.includes(role)))) {
    throw new Error(`Select distinct comma-separated roles from: ${ROLES.join(', ')}.`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/.test(values['--user'])) {
    throw new Error('Invalid user ID.');
  }
  return { command, file: values['--database'], userId: values['--user'].toLowerCase(), roles };
}

function readHiddenPassword(prompt, input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new Error('Password entry requires an interactive terminal; redirected input is not accepted.'));
  }
  return new Promise((resolve, reject) => {
    let password = '';
    const wasRaw = Boolean(input.isRaw), wasPaused = input.isPaused();
    function finish(error) {
      input.removeListener('keypress', onKey);
      input.removeListener('end', onEnd);
      input.removeListener('close', onEnd);
      input.removeListener('error', onError);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
      output.write('\n');
      const value = password;
      password = '';
      if (error) reject(error);
      else resolve(value);
    }
    function onEnd() { finish(new Error('Password entry interrupted. No account changes were made.')); }
    function onError() { finish(new Error('Password terminal failed. No account changes were made.')); }
    function onKey(text, key = {}) {
      if (key.ctrl && ['c', 'd'].includes(key.name)) return onEnd();
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') {
        password = Array.from(password).slice(0, -1).join('');
      } else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text)) {
        password += text;
        if (password.length > 512) finish(new Error('Password input is too long.'));
      }
    }
    readline.emitKeypressEvents(input);
    input.on('keypress', onKey);
    input.once('end', onEnd);
    input.once('close', onEnd);
    input.once('error', onError);
    input.setRawMode(true);
    output.write(prompt);
    input.resume();
  });
}

async function runAccountCommand(args, { input = process.stdin, output = process.stdout,
  readPassword = (prompt) => readHiddenPassword(prompt, input, output) } = {}) {
  const options = parseArguments(args);
  if (!input.isTTY || !output.isTTY) throw new Error('Account commands require an interactive terminal.');
  // Recovery must never accidentally initialize a different, empty database.
  if (options.command === 'recover-admin' && !fs.statSync(options.file).isFile()) {
    throw new Error('Recovery requires an existing account database file.');
  }
  const actor = `local:${os.userInfo().username}`;
  const store = await createAccountSessions({ file: options.file });
  let password, confirmation;
  try {
    const accounts = await store.listAccounts();
    const selected = accounts.find((account) => account.userId === options.userId);
    if (options.command === 'create' && selected) throw new Error('User ID already exists.');
    if (options.command === 'recover-admin' && !selected?.roles.includes('administrator')) {
      throw new Error('Select an existing administrator account.');
    }
    output.write(`${options.command === 'create' ? 'Creating account' : 'Recovering administrator'}: ${options.userId}\n`);
    password = await readPassword('New password (hidden): ');
    confirmation = await readPassword('Confirm password (hidden): ');
    if (password !== confirmation) throw new Error('Passwords do not match. No account changes were made.');
    if (options.command === 'create') {
      await store.createAccount({ userId: options.userId, roles: options.roles, password, actor });
      output.write('Account created and audited.\n');
    } else {
      await store.recoverAdministrator({ userId: options.userId, revision: selected.revision, password, actor });
      output.write('Administrator reset and enabled; sessions revoked, login cooldown cleared, and recovery audited.\n');
    }
  } finally {
    password = confirmation = undefined;
    await store.close();
  }
}

if (require.main === module) {
  runAccountCommand(process.argv.slice(2)).catch((error) => {
    console.error(`Account command failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArguments, readHiddenPassword, runAccountCommand };
