const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function createHttpsFixture(root) {
  const openssl = process.env.OPENSSL_PATH || (process.platform === 'win32'
    ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl');
  const run = (args) => execFileSync(openssl, args, { stdio: 'pipe' });
  const file = (name) => path.join(root, name);
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=Test Root CA', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-keyout', file('ca-key.pem'), '-out', file('ca.pem')]);
  run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=tourn-svr.home.arpa',
    '-addext', 'subjectAltName=DNS:tourn-svr.home.arpa,IP:192.168.4.42',
    '-addext', 'basicConstraints=critical,CA:FALSE', '-addext', 'extendedKeyUsage=serverAuth',
    '-keyout', file('key.pem'), '-out', file('server.csr')]);
  run(['x509', '-req', '-in', file('server.csr'), '-CA', file('ca.pem'), '-CAkey', file('ca-key.pem'),
    '-CAcreateserial', '-days', '1', '-copy_extensions', 'copy', '-out', file('cert.pem')]);
  const config = { hostname: 'tourn-svr.home.arpa', ipAddress: '192.168.4.42',
    keyFile: file('key.pem'), certFile: file('cert.pem'), caFile: file('ca.pem'),
    accountDatabase: file('accounts.db'), sourceLimit: { maxAttempts: 50, windowMs: 900000 } };
  const configFile = file('server.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  return { config, configFile };
}
module.exports = { createHttpsFixture };
