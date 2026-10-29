const { fork } = require('node:child_process');
const path = require('node:path');

function startSupervisor({ serverPath = path.join(__dirname, 'group-server.js'), args = process.argv.slice(2),
  spawn = fork } = {}) {
  let stopping = false;
  let child;

  function launch() {
    let restartRequested = false;
    child = spawn(serverPath, args, {
      cwd: __dirname,
      env: { ...process.env, TOURNAMENT_MANAGED_SERVER: '1' },
      stdio: ['inherit', 'inherit', 'inherit', 'ipc']
    });
    child.on('message', (message) => {
      if (message && message.type === 'restart-ready') restartRequested = true;
    });
    child.on('error', (error) => {
      console.error('Unable to launch tournament server:', error);
      process.exitCode = 1;
    });
    child.on('exit', (code, signal) => {
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
    if (child && child.connected) child.send({ type: 'shutdown' });
  }

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  launch();
  return { stop };
}

if (require.main === module) startSupervisor();

module.exports = { startSupervisor };
