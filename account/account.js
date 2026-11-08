(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const policyDefinitions = [
    ['userIdMinLength', 'User ID minimum length', 3, 64],
    ['userIdMaxLength', 'User ID maximum length', 3, 64],
    ['passwordMinLength', 'Password minimum length', 10, 128],
    ['passwordMaxLength', 'Password maximum length', 64, 128],
    ['idleTimeoutMinutes', 'Idle timeout (minutes)', 5, 120],
    ['absoluteTimeoutHours', 'Absolute session duration (hours)', 1, 24],
    ['failureThreshold', 'Failed-login threshold', 3, 10],
    ['failureWindowMinutes', 'Failed-login window (minutes)', 1, 60],
    ['cooldownMinutes', 'Login cooldown (minutes)', 1, 60],
    ['allowConcurrentSessions', 'Allow concurrent sessions'],
    ['logoutAllSessions', 'Sign out all sessions on logout'],
    ['revokeOnPasswordReset', 'Revoke sessions on password reset'],
    ['revokeOnRoleChange', 'Revoke sessions on role change']
  ];
  const view = location.pathname === '/account/login' ? 'login'
    : location.pathname === '/account/profile' ? 'profile'
      : location.pathname === '/account/settings' ? 'settings' : 'users';
  let session = null, csrfToken = '', accounts = [], selected = null, savedPolicy = null, editorUserId = '';
  let userDirty = false, policyDirty = false, busy = false, lastActivity = 0;
  let usersLoaded = false, policyLoaded = false;
  function status(message, error = false) {
    $('status').textContent = message;
    $('status').dataset.error = String(error);
    $('status').hidden = !message;
  }
  function clearPasswords() {
    for (const id of ['loginPassword', 'userPassword', 'confirmPassword']) $(id).value = '';
    validatePasswords();
  }
  function validatePasswords() {
    const mismatch = $('userPassword').value !== $('confirmPassword').value;
    const message = mismatch ? 'New passwords do not match.' : '';
    $('confirmPassword').setCustomValidity(message);
    $('confirmPassword').setAttribute('aria-invalid', String(mismatch));
    $('passwordMismatch').textContent = message;
    $('passwordMismatch').hidden = !mismatch;
    return !mismatch;
  }
  function userSaveStatus(message) {
    $('userSaveStatus').textContent = message;
    $('userSaveStatus').hidden = !message;
  }
  function renderSession() {
    const admin = session?.account.roles.includes('administrator');
    $('loginPanel').hidden = Boolean(session);
    $('sessionPanel').hidden = !session;
    $('usersPanel').hidden = !admin || view !== 'users';
    $('policyPanel').hidden = !admin || view !== 'settings';
    $('sessionDetails').textContent = session
      ? `Signed in as ${session.account.userId} (${session.account.roles.map((role) => session.roleLabels?.[role] || role).join(', ')}).`
      : '';
    $('adminNotice').hidden = !admin || view !== 'settings';
    document.querySelectorAll('[data-admin-link]').forEach((link) => { link.hidden = !admin; });
    if (session) $('accountHome').href = session.homePath;
  }
  function signedOut(message) {
    session = null;
    csrfToken = '';
    clearPasswords();
    userSaveStatus('');
    if ((userDirty || policyDirty) && editorUserId) {
      $('loginUser').value = editorUserId;
      $('loginUser').readOnly = true;
    }
    renderSession();
    status(message, true);
  }
  async function request(endpoint, { method = 'GET', body } = {}) {
    const response = await fetch(`/api/account${endpoint}`, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      if (response.status === 401 && endpoint !== '/login') {
        signedOut(session || editorUserId
          ? 'Your session expired or was revoked. Unsaved edits are retained on this page; sign in again. Password fields were cleared.'
          : '');
      }
      const error = new Error(data?.error || `Account request failed (${response.status}).`);
      error.status = response.status;
      error.sessionExpired = response.status === 401 && endpoint !== '/login';
      throw error;
    }
    return data;
  }
  async function run(callback) {
    if (busy) return;
    busy = true;
    document.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    try { await callback(); }
    catch (error) {
      if (!error.sessionExpired) status(error.message, true);
      if (error.status === 409) status(`${error.message} Your draft has been kept. Reload the latest data before reapplying your changes.`, true);
    } finally {
      busy = false;
      document.querySelectorAll('button').forEach((button) => { button.disabled = false; });
    }
  }
  async function checkSession() {
    const next = await request('/session');
    if ((userDirty || policyDirty) && editorUserId && next.account.userId !== editorUserId) {
      signedOut('A different account signed in in another tab. Sign in as the original user to resume these unsaved edits.');
      throw Object.assign(new Error('Sign in as the original user to resume these edits.'), { status: 401, sessionExpired: true });
    }
    session = next;
    editorUserId = next.account.userId;
    $('loginUser').readOnly = false;
    csrfToken = next.csrfToken;
    renderSession();
    return next;
  }
  function canDiscard(dirty) {
    return !busy && (!dirty || window.confirm('Discard unsaved account edits?'));
  }
  window.canLeaveAccountPage = () => canDiscard(userDirty || policyDirty);
  window.addEventListener('beforeunload', (event) => {
    if (view === 'login') return;
    if (!userDirty && !policyDirty && !busy) return;
    event.preventDefault();
    event.returnValue = '';
  });
  document.querySelectorAll('nav a').forEach((link) => link.addEventListener('click', (event) => {
    if (!window.canLeaveAccountPage()) event.preventDefault();
    else { userDirty = false; policyDirty = false; }
  }));
  const policyGroups = [
    ['Identifiers and passwords', 'New/reset passwords require uppercase (A-Z), lowercase (a-z), a number (0-9), and a special character. Spaces do not count as special characters. Existing passwords still work. Email delivery and self-service recovery are not enabled.', ['userIdMinLength', 'userIdMaxLength', 'passwordMinLength', 'passwordMaxLength']],
    ['Browser sessions', 'Background refreshes do not count as activity. The standalone read-only Audience Monitor allows 12 hours from sign-in without interaction; editable workspaces retain these idle and absolute deadlines.', ['idleTimeoutMinutes', 'absoluteTimeoutHours', 'allowConcurrentSessions', 'logoutAllSessions']],
    ['Failed sign-in protection', 'Repeated failures cause a cooldown. A separate per-source limit is configured in the private HTTPS configuration.', ['failureThreshold', 'failureWindowMinutes', 'cooldownMinutes']],
    ['Revoking existing sessions', 'Disabled accounts always lose access. When role-change revocation is off, each request still checks current permissions.', ['revokeOnPasswordReset', 'revokeOnRoleChange']]
  ];
  const policyContainers = new Map();
  for (const [title, help, keys] of policyGroups) {
    const fieldset = document.createElement('fieldset');
    const legend = document.createElement('legend'); legend.textContent = title;
    const description = document.createElement('p'); description.textContent = help;
    fieldset.append(legend, description);
    $('policyFields').append(fieldset);
    for (const key of keys) policyContainers.set(key, fieldset);
  }
  for (const [key, title, min, max] of policyDefinitions) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.id = `policy-${key}`;
    input.type = min === undefined ? 'checkbox' : 'number';
    if (min !== undefined) {
      input.min = String(min); input.max = String(max); input.step = '1'; input.required = true;
    }
    label.append(document.createTextNode(title), input);
    policyContainers.get(key).append(label);
  }
  function renderPolicy() {
    for (const [key, , min] of policyDefinitions) {
      const input = $(`policy-${key}`);
      if (min === undefined) input.checked = savedPolicy.policy[key];
      else input.value = savedPolicy.policy[key];
    }
    policyDirty = false;
    $('passwordHelp').textContent = `Passwords: ${savedPolicy.policy.passwordMinLength}-${savedPolicy.policy.passwordMaxLength} characters, including uppercase (A-Z), lowercase (a-z), number (0-9), and a special character. Spaces are allowed but do not count as special characters. User IDs: ${savedPolicy.policy.userIdMinLength}-${savedPolicy.policy.userIdMaxLength} characters.`;
  }
  async function loadPolicy() {
    savedPolicy = await request('/policy');
    policyLoaded = true;
    renderPolicy();
  }
  function resetUser() {
    selected = null;
    $('userForm').reset();
    $('userId').disabled = false;
    $('userEnabled').disabled = true;
    $('userEnabled').checked = true;
    $('userFormTitle').textContent = 'Add user';
    validatePasswords();
    userSaveStatus('');
    userDirty = false;
  }
  function editUser(account) {
    if (!canDiscard(userDirty)) return;
    resetUser();
    selected = account;
    $('userId').value = account.userId;
    $('userId').disabled = true;
    $('userEnabled').disabled = false;
    $('userEnabled').checked = account.enabled;
    $('roles').querySelectorAll('input').forEach((input) => { input.checked = account.roles.includes(input.value); });
    $('userFormTitle').textContent = `Edit ${account.userId}`;
  }
  async function loadUsers() {
    const data = await request('/users');
    accounts = data.users;
    usersLoaded = true;
    $('users').replaceChildren();
    for (const account of accounts) {
      const row = document.createElement('tr');
      for (const text of [account.userId, account.roles.map((role) => session.roleLabels?.[role] || role).join(', '), account.enabled ? 'Enabled' : 'Disabled']) {
        const cell = document.createElement('td');
        cell.textContent = text;
        row.append(cell);
      }
      const cell = document.createElement('td');
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = 'Edit';
      button.addEventListener('click', () => editUser(account));
      cell.append(button); row.append(cell); $('users').append(row);
    }
  }
  async function loadAdministration() {
    if (view === 'login') {
      const requested = new URLSearchParams(location.search).get('returnTo') || '';
      const local = /^\/(?!\/)/.test(requested) && !/[\\\x00-\x20]/.test(requested);
      const target = new URL(local ? requested : session.homePath, location.origin);
      location.replace(target.origin === location.origin && !target.pathname.startsWith('/account')
        ? `${target.pathname}${target.search}${target.hash}` : session.homePath);
      return;
    }
    if (view === 'profile') { status('Signed in. Use Home to open your permitted workspace.'); return; }
    if (!session.account.roles.includes('administrator')) {
      status('Signed in. Administrator permission is required for Users and User Account Settings.', true);
      return;
    }
    if (!policyLoaded) await loadPolicy();
    if (!usersLoaded && view === 'users') await loadUsers();
    status(view === 'users' ? '' : 'Account administration ready. Browser role permissions apply to all tournaments.');
  }
  $('loginForm').addEventListener('submit', (event) => {
    event.preventDefault();
    run(async () => {
      try {
        await request('/login', { method: 'POST', body: { userId: $('loginUser').value, password: $('loginPassword').value } });
        await checkSession();
        lastActivity = Date.now();
        await loadAdministration();
      } finally { $('loginPassword').value = ''; }
    });
  });
  $('logout').addEventListener('click', () => {
    if (!canDiscard(userDirty || policyDirty)) return;
    run(async () => {
      await request('/logout', { method: 'POST', body: {} });
      resetUser(); policyDirty = false; policyLoaded = false; usersLoaded = false;
      editorUserId = '';
      $('loginUser').readOnly = false;
      signedOut('Signed out.');
    });
  });
  $('userForm').addEventListener('input', () => {
    userDirty = true;
    userSaveStatus('');
    validatePasswords();
  });
  $('policyForm').addEventListener('input', () => { policyDirty = true; });
  $('newUser').addEventListener('click', () => { if (canDiscard(userDirty)) resetUser(); });
  $('refreshUsers').addEventListener('click', () => {
    if (canDiscard(userDirty)) run(async () => { await loadUsers(); resetUser(); status('Users reloaded.'); });
  });
  $('refreshPolicy').addEventListener('click', () => {
    if (canDiscard(policyDirty)) run(async () => { await loadPolicy(); status('Settings reloaded.'); });
  });
  $('userForm').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!validatePasswords()) {
      $('confirmPassword').reportValidity();
      return;
    }
    userSaveStatus('');
    run(async () => {
      const password = $('userPassword').value;
      if (!selected && !password) throw new Error('A password is required for a new account.');
      const roles = [...$('roles').querySelectorAll('input:checked')].map((input) => input.value);
      if (!roles.length) throw new Error('Select at least one role.');
      const body = selected
        ? { revision: selected.revision, roles, enabled: $('userEnabled').checked }
        : { userId: $('userId').value, roles };
      if (password) body.password = password;
      const data = await request(selected ? `/users/${encodeURIComponent(selected.userId)}` : '/users',
        { method: selected ? 'PUT' : 'POST', body });
      selected = data.account;
      userDirty = false;
      clearPasswords();
      $('userId').disabled = true;
      $('userEnabled').disabled = false;
      $('userFormTitle').textContent = `Edit ${selected.userId}`;
      status('');
      userSaveStatus('User saved.');
      try { await checkSession(); }
      catch (error) {
        if (!error.sessionExpired) throw error;
        status('User saved. Your session was revoked by this change. Sign in again.', true);
        return;
      }
      await loadUsers();
    });
  });
  $('policyForm').addEventListener('submit', (event) => {
    event.preventDefault();
    run(async () => {
      const policy = Object.fromEntries(policyDefinitions.map(([key, , min]) => {
        const input = $(`policy-${key}`);
        return [key, min === undefined ? input.checked : Number(input.value)];
      }));
      const changed = policyDefinitions.some(([key]) => savedPolicy.policy[key] !== policy[key]);
      if (changed && !window.confirm('Save these settings and sign out ALL browser sessions, including yours?')) return;
      savedPolicy = await request('/policy', { method: 'PUT', body: { revision: savedPolicy.revision, policy } });
      renderPolicy();
      if (changed) {
        signedOut('Settings saved. All browser sessions were revoked. Sign in again.');
      } else status('Settings unchanged. Sessions were not revoked.');
    });
  });
  async function activity(event) {
    if (!event.isTrusted || !session || busy || Date.now() - lastActivity < 60000) return;
    lastActivity = Date.now();
    try { await request('/activity', { method: 'POST', body: {} }); }
    catch (error) { if (error.status !== 401) status(`Unable to refresh session: ${error.message}`, true); }
  }
  document.addEventListener('pointerdown', activity);
  document.addEventListener('keydown', activity);
  setInterval(async () => {
    if (!session || busy) return;
    try { await checkSession(); }
    catch (error) { if (error.status !== 401) status(`Unable to check session: ${error.message}`, true); }
  }, 30000);
  $('pageTitle').textContent = view === 'settings' ? 'User Account Settings'
    : view === 'login' ? 'Sign in' : view === 'profile' ? 'Your Account' : 'Users';
  resetUser();
  run(async () => { await checkSession(); await loadAdministration(); });
})();
