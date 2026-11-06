const net = require('node:net');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const SURFACES = ['pre', 'monitoring', 'adminProgress'];

function openHome() {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Start-Process -FilePath $env:TOURNAMENT_HOME_URL -ErrorAction Stop'],
    { windowsHide: true }, (error) => error ? reject(error) : resolve());
  });
}
function minimizeConsole() {
  if (!process.env.TOURNAMENT_CONSOLE_PID) return Promise.resolve();
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -Namespace Tournament -Name Window -MemberDefinition \'[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindowAsync(System.IntPtr hWnd, int nCmdShow); ' +
      '[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern bool FreeConsole(); ' +
      '[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern bool AttachConsole(uint processId); ' +
      '[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();\'; ' +
      '[Tournament.Window]::FreeConsole() | Out-Null; ' +
      'if (![Tournament.Window]::AttachConsole([uint32]$env:TOURNAMENT_CONSOLE_PID)) { throw "Unable to attach to the service console." }; ' +
      '$handle = [Tournament.Window]::GetConsoleWindow(); ' +
      'if ($handle -eq [IntPtr]::Zero) { throw "Service console window was not found." }; ' +
      '[Tournament.Window]::ShowWindowAsync($handle, 6) | Out-Null'],
    { windowsHide: true }, (error) => error ? reject(error) : resolve());
  });
}

function readMessages(socket, receive) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (data) => {
    buffer += data;
    if (buffer.length > 16384) { socket.destroy(); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); }
      catch { socket.destroy(); return; }
      if (!message || typeof message !== 'object') { socket.destroy(); return; }
      receive(message);
    }
  });
}
function send(socket, message) {
  if (socket && !socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

function startServiceGroup({ endpoint, token, surface, onRestart, onState,
  launchHome = openHome, minimize = minimizeConsole, openOnStart = false,
  restartTimeoutMs = 120000, reconnectMs = 500 }) {
  if (!endpoint || !token || !SURFACES.includes(surface)) throw new Error('Invalid managed service group configuration.');
  let stopped = false, client, retry, server, deadline;
  let generation = '', ready = false, authenticated = false, restarting = false, completing = false, lastError = '';
  let initialHome = openOnStart;
  const peers = new Map(), sockets = new Set();
  function snapshot() {
    return { restartAvailable: SURFACES.every((name) => peers.get(name)?.ready) && !restarting && !completing,
      restarting, services: SURFACES.map((name) => ({ name, ready: Boolean(peers.get(name)?.ready) })),
      message: lastError || (restarting ? 'Restarting all three services...'
        : SURFACES.every((name) => peers.get(name)?.ready)
          ? 'All three services are ready. Restart opens Tournament Management home.'
          : 'Waiting for all three services. Start them together using launch-surfaces.ps1.') };
  }
  function broadcastState() {
    for (const peer of peers.values()) send(peer.socket, { type: 'state', ...snapshot() });
  }
  async function completeRestart() {
    if ((!restarting && !initialHome) || completing || !SURFACES.every((name) => peers.get(name)?.ready)) return;
    completing = true;
    initialHome = false;
    clearTimeout(deadline);
    try { await launchHome(); }
    catch (error) {
      lastError = `All services restarted, but opening the home browser failed: ${error.message}`;
      console.error(lastError);
    }
    restarting = false;
    completing = false;
    broadcastState();
  }
  if (surface === 'pre') {
    server = net.createServer((socket) => {
      sockets.add(socket);
      let name;
      const authenticationDeadline = setTimeout(() => socket.destroy(), 5000);
      socket.on('error', (error) => console.error('Service group connection failed:', error.message));
      socket.on('close', () => {
        clearTimeout(authenticationDeadline);
        sockets.delete(socket);
        if (name && peers.get(name)?.socket === socket) { peers.delete(name); broadcastState(); }
      });
      readMessages(socket, (message) => {
        if (!name) {
          if (message.type !== 'hello' || message.token !== token || !SURFACES.includes(message.surface) ||
              peers.has(message.surface)) { socket.destroy(); return; }
          clearTimeout(authenticationDeadline);
          name = message.surface;
          peers.set(name, { socket, ready: false });
          send(socket, { type: 'generation', generation });
          broadcastState();
        } else if (message.type === 'ready' && message.generation === generation) {
          peers.get(name).ready = true;
          broadcastState();
          void completeRestart();
        } else if (message.type === 'not-ready') {
          peers.get(name).ready = false;
          broadcastState();
        } else if (message.type === 'restart') {
          if (!snapshot().restartAvailable) {
            send(socket, { type: 'state', ...snapshot(), message: 'Restart refused: all three services must be ready.' });
            return;
          }
          restarting = true;
          lastError = '';
          generation = crypto.randomUUID();
          for (const peer of peers.values()) peer.ready = false;
          broadcastState();
          for (const peer of peers.values()) send(peer.socket, { type: 'restart', generation });
          deadline = setTimeout(() => {
            lastError = 'Restart timed out waiting for all three services. Check their command windows; do not launch duplicates.';
            console.error(lastError);
            restarting = false;
            broadcastState();
          }, restartTimeoutMs);
        }
      });
    });
    server.on('error', (error) => {
      console.error('Service group coordinator failed:', error);
      onState({ restartAvailable: false, restarting: false, message: `Service group unavailable: ${error.message}` });
    });
    server.listen(endpoint);
  }
  function connect() {
    if (stopped) return;
    client = net.createConnection(endpoint);
    client.on('connect', () => send(client, { type: 'hello', token, surface }));
    client.on('error', (error) => {
      if (!['ENOENT', 'ECONNREFUSED', 'EPIPE'].includes(error.code)) console.error('Service group unavailable:', error.message);
    });
    client.on('close', () => {
      authenticated = false;
      onState({ restartAvailable: false, restarting: false, message: 'Service group disconnected. Waiting for the launcher coordinator.' });
      if (!stopped) retry = setTimeout(connect, reconnectMs);
    });
    readMessages(client, (message) => {
      if (message.type === 'generation') {
        authenticated = true;
        generation = message.generation;
        if (ready) send(client, { type: 'ready', generation });
      } else if (message.type === 'state') onState(message);
      else if (message.type === 'restart') {
        generation = message.generation;
        ready = false;
        Promise.resolve(minimize()).catch((error) => console.error('Unable to minimize service window:', error.message))
          .finally(() => { if (!stopped) onRestart(); });
      }
    });
  }
  connect();
  return {
    markReady() { ready = true; if (authenticated) send(client, { type: 'ready', generation }); },
    markUnavailable() { ready = false; if (authenticated) send(client, { type: 'not-ready' }); },
    requestRestart() { send(client, { type: 'restart' }); },
    stop() {
      stopped = true;
      clearTimeout(retry);
      clearTimeout(deadline);
      client.destroy();
      for (const socket of sockets) socket.destroy();
      if (server) server.close();
    }
  };
}
module.exports = { startServiceGroup, SURFACES };
