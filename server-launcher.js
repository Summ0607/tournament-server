const { fork } = require('node:child_process');
const path = require('node:path');
const { startServiceGroup } = require('./backend/serviceGroup');

function startSupervisor({ serverPath = path.join(__dirname, 'group-server.js'), args = process.argv.slice(2),
  spawn = fork, groupConfig = process.env.TOURNAMENT_SERVICE_GROUP
    ? { endpoint: process.env.TOURNAMENT_SERVICE_GROUP, token: process.env.TOURNAMENT_SERVICE_TOKEN,
      surface: process.env.TOURNAMENT_SURFACE, openOnStart: process.env.TOURNAMENT_OPEN_HOME === '1' } : null } = {}) {
  let stopping = false;
  let child;
  let group, groupState;

  function launch() {
    let restartRequested = false;
    child = spawn(serverPath, args, {
      cwd: __dirname,
      env: { ...process.env, TOURNAMENT_MANAGED_SERVER: '1' },
      stdio: ['inherit', 'inherit', 'inherit', 'ipc']
    });
    child.on('message', (message) => {
      if (message && message.type === 'restart-ready') restartRequested = true;
      if (message?.type === 'server-ready' && group) {
        group.markReady();
        if (groupState) child.send({ type: 'services-state', state: groupState });
      }
      if (message?.type === 'restart-services' && group) group.requestRestart();
    });
    child.on('error', (error) => {
      if (group) group.markUnavailable();
      console.error('Unable to launch tournament server:', error);
      process.exitCode = 1;
    });
    child.on('exit', (code, signal) => {
      if (group) group.markUnavailable();
      if (!stopping && restartRequested && code === 0) {
        console.log('Restarting tournament server...');
        launch();
      } else if (!stopping) {
        console.error(`Tournament server exited (${signal || code}); not restarting automatically.`);
        process.exitCode = code || 1;
      }
    });
  }

  function stop() {
    stopping = true;
    if (group) group.stop();
    if (child && child.connected) child.send({ type: 'shutdown' });
  }

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  launch();
  if (groupConfig) group = startServiceGroup({ ...groupConfig,
    onRestart: () => { if (child?.connected) child.send({ type: 'restart' }); },
    onState: (state) => {
      groupState = state;
      if (child?.connected) child.send({ type: 'services-state', state });
    }
  });
  return { stop };
}

if (require.main === module) startSupervisor();

module.exports = { startSupervisor };
