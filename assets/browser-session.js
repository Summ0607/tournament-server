(function () {
  'use strict';
  const originalFetch = window.fetch.bind(window);
  const audience = /^\/audience-monitor(?:\/(?:index\.html)?|\.html)?$/.test(new URL(location.href).pathname);
  let session = null, pendingLogin = null, resolveLogin = null, dialog, message, user, password, submit;
  let lastActivity = 0, checking = false, recovering = false;
  const domReady = new Promise((resolve) => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resolve, { once: true });
    else resolve();
  });
  function canView(view) { return Boolean(session?.allowedViews.includes(view)); }
  function applyPermissions() {
    document.querySelectorAll('[data-nav-id], [data-auth-view]').forEach((node) => {
      const view = node.getAttribute('data-nav-id') || node.getAttribute('data-auth-view');
      node.hidden = !canView(view);
    });
    [...document.querySelectorAll('[data-nav-group]')].reverse().forEach((button) => {
      const children = document.getElementById(button.getAttribute('aria-controls'));
      button.hidden = Boolean(children) && ![...children.querySelectorAll('[data-nav-id]')].some((item) => !item.hidden);
    });
    const workspace = document.body.dataset.authWorkspace;
    if (workspace) {
      document.querySelectorAll('body > :not(#browserSessionBar):not(#browserLoginDialog)').forEach((node) => {
        node.inert = !canView(workspace);
      });
      if (!canView(workspace)) notify('Your current roles no longer permit this workspace. Edits remain here, but access is blocked. Use Home to open a permitted workspace.');
    }
    document.getElementById('browserIdentity').textContent = session
      ? `${session.account.userId} - ${session.account.roles.map((role) => session.roleLabels[role]).join(', ')}`
      : 'Sign-in required';
    window.dispatchEvent(new CustomEvent('browser-permissions-changed'));
  }
  async function account(endpoint, body) {
    const response = await originalFetch(`/api/account${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: {
        ...(audience ? { 'X-Tournament-Audience': 'true' } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': session?.csrfToken || '' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) throw Object.assign(new Error(data?.error || 'Account request failed.'), { status: response.status });
    return data;
  }
  function notify(text) {
    document.getElementById('browserSessionNotice').textContent = text;
  }
  function verifySessionVersion(next) {
    if (!Array.isArray(next.allowedViews) || !next.roleLabels || typeof next.homePath !== 'string') {
      throw new Error('The server is still running older code than this page. Stop all three server windows, run .\\launch-surfaces.ps1, then reload. Your password may already have been accepted; do not reset it for this message.');
    }
    return next;
  }
  async function requireLogin(reason) {
    await domReady;
    if (pendingLogin) return pendingLogin;
    recovering = true;
    pendingLogin = new Promise((resolve) => { resolveLogin = resolve; });
    user.value = session?.account.userId || '';
    user.readOnly = Boolean(session);
    password.value = '';
    message.textContent = reason || 'Sign in to continue. Your unsaved edits remain on this page. Password fields are cleared; nothing is stored as a draft.';
    document.querySelectorAll('input[type="password"]').forEach((input) => { input.value = ''; });
    dialog.showModal();
    (user.value ? password : user).focus();
    return pendingLogin;
  }
  async function refreshSession() {
    const next = verifySessionVersion(await account('/session'));
    if (session && next.account.userId !== session.account.userId) {
      await requireLogin('A different account signed in in another tab. Reauthenticate as the original user to keep editing this page.');
      return;
    }
    session = next;
    applyPermissions();
  }
  async function initialize() {
    await domReady;
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = '/assets/browser-session.css'; document.head.append(link);
    const bar = document.createElement('aside');
    bar.id = 'browserSessionBar';
    bar.innerHTML = '<span id="browserIdentity">Checking session...</span><a href="/">Home</a><button type="button" id="browserSignOut">Sign out</button><span id="browserSessionNotice" role="status" aria-live="polite"></span>';
    document.body.prepend(bar);
    dialog = document.createElement('dialog');
    dialog.id = 'browserLoginDialog';
    dialog.setAttribute('aria-labelledby', 'browserLoginTitle');
    dialog.innerHTML = '<h2 id="browserLoginTitle">Sign in to continue</h2><p id="browserLoginMessage" role="status" aria-live="polite"></p><form id="browserLoginForm"><label>User ID<input id="browserLoginUser" autocomplete="username" required maxlength="64"></label><label>Password<input id="browserLoginPassword" type="password" autocomplete="current-password" required maxlength="128"></label><button type="submit" id="browserLoginSubmit">Sign in</button></form>';
    document.body.append(dialog);
    message = document.getElementById('browserLoginMessage');
    user = document.getElementById('browserLoginUser');
    password = document.getElementById('browserLoginPassword');
    submit = document.getElementById('browserLoginSubmit');
    dialog.addEventListener('cancel', (event) => event.preventDefault());
    document.getElementById('browserLoginForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      try {
        await account('/login', { userId: user.value, password: password.value });
        const next = verifySessionVersion(await account('/session'));
        if (session && next.account.userId !== session.account.userId) throw new Error('Sign in as the original account to resume this page.');
        if (!session) {
          window.top.location.replace(next.homePath);
          return;
        }
        session = next;
        lastActivity = Date.now();
        applyPermissions();
        dialog.close();
        recovering = false;
        const resolve = resolveLogin;
        pendingLogin = resolveLogin = null;
        resolve();
        notify('Signed in. Unsaved edits were retained. Review and save again; failed changes are never replayed automatically.');
      } catch (error) { message.textContent = error.message; }
      finally { password.value = ''; submit.disabled = false; }
    });
    document.getElementById('browserSignOut').addEventListener('click', async () => {
      if (!window.confirm('Sign out and leave this page? Unsaved edits will be discarded if you leave.')) return;
      try {
        await account('/logout', {});
        location.assign('/account/login');
      } catch (error) { notify(`Unable to sign out: ${error.message}`); }
    });
    try { await refreshSession(); }
    catch (error) { await requireLogin(error.status === 401 ? undefined : `Unable to check session: ${error.message}`); }
  }
  const ready = initialize();
  window.BrowserSession = { ready, canView, get homePath() { return session?.homePath || '/'; } };
  window.fetch = async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    if (url.origin !== location.origin || url.pathname.startsWith('/api/account/')) return originalFetch(input, options);
    await ready;
    if (pendingLogin) await pendingLogin;
    const request = new Request(input, options);
    const read = ['GET', 'HEAD'].includes(request.method);
    const headers = new Headers(request.headers);
    if (audience) headers.set('X-Tournament-Audience', 'true');
    if (!read) {
      headers.set('X-CSRF-Token', session.csrfToken);
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    }
    const secured = new Request(request, {
      headers, credentials: 'same-origin',
      ...(!read && request.body === null ? { body: '{}' } : {})
    });
    const response = await originalFetch(secured);
    if (response.status === 401) {
      // Never replay mutations: an expired save must be reviewed and retried explicitly.
      if (read) {
        await requireLogin();
        const retried = await originalFetch(secured);
        if (retried.status === 401) notify('The session is still unavailable. This read was retried once; sign in again before continuing.');
        return retried;
      }
      void requireLogin();
      notify('This change was NOT saved: sign in, review your edits, then save again.');
    } else if (response.status === 403) {
      notify('Permission or session verification failed. Your edit remains on this page. Check your roles or refresh session details before trying again.');
      try { await refreshSession(); }
      catch (error) {
        if (error.status === 401) void requireLogin();
        else notify(`Unable to refresh session: ${error.message}`);
      }
    }
    return response;
  };
  async function activity(event) {
    if (audience || !event.isTrusted || !session || recovering || Date.now() - lastActivity < 60000) return;
    lastActivity = Date.now();
    try { await account('/activity', {}); }
    catch (error) {
      if (error.status === 401) void requireLogin();
      else notify(`Unable to refresh session: ${error.message}`);
    }
  }
  document.addEventListener('pointerdown', activity);
  document.addEventListener('keydown', activity);
  setInterval(async () => {
    if (!session || recovering || checking) return;
    checking = true;
    try { await refreshSession(); }
    catch (error) {
      if (error.status === 401) void requireLogin();
      else notify(`Unable to check session: ${error.message}`);
    } finally { checking = false; }
  }, 30000);
})();
