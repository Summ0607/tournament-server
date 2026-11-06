const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const { X509Certificate } = require('node:crypto');
const { SURFACE_PORTS } = require('./surfacePorts');

const HTTPS_PORTS = SURFACE_PORTS;

function requirePrivateFile(file, rootDir = path.resolve(__dirname, '..')) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) {
    throw new Error('HTTPS configuration and key/certificate paths must be absolute.');
  }
  const resolved = fs.realpathSync(file);
  const relative = path.relative(fs.realpathSync(rootDir), resolved);
  if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
    throw new Error('HTTPS configuration and keys/certificates must be outside the web-served repository.');
  }
  if (!fs.statSync(resolved).isFile()) throw new Error(`Not a private file: ${file}`);
  return resolved;
}

function loadHttpsConfig(file) {
  if (!file) throw new Error('HTTPS configuration is required. Run setup-https.ps1 and set TOURNAMENT_HTTPS_CONFIG, or use launch-surfaces.ps1. HTTP-only startup is no longer supported.');
  const config = JSON.parse(fs.readFileSync(requirePrivateFile(file), 'utf8'));
  const keys = ['hostname', 'ipAddress', 'keyFile', 'certFile', 'caFile', 'accountDatabase', 'sourceLimit'];
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).some((key) => !keys.includes(key)) ||
      keys.some((key) => !Object.hasOwn(config, key))) {
    throw new Error('HTTPS configuration has missing or unknown fields.');
  }
  if (typeof config.hostname !== 'string' ||
      !/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(config.hostname) ||
      require('node:net').isIP(config.hostname) || require('node:net').isIP(config.ipAddress) !== 4) {
    throw new Error('HTTPS configuration requires a DNS hostname and an IPv4 address.');
  }
  if (typeof config.accountDatabase !== 'string' || !path.isAbsolute(config.accountDatabase)) {
    throw new Error('An absolute external account database path is required.');
  }
  const limit = config.sourceLimit;
  if (!limit || Object.keys(limit).some((key) => !['maxAttempts', 'windowMs'].includes(key)) ||
      !Number.isSafeInteger(limit.maxAttempts) || limit.maxAttempts < 1 ||
      !Number.isSafeInteger(limit.windowMs) || limit.windowMs < 1000) {
    throw new Error('An explicit source login rate limit is required in HTTPS configuration.');
  }
  const key = fs.readFileSync(requirePrivateFile(config.keyFile));
  const cert = fs.readFileSync(requirePrivateFile(config.certFile));
  const ca = fs.readFileSync(requirePrivateFile(config.caFile));
  const serverCertificate = new X509Certificate(cert);
  const rootCertificate = new X509Certificate(ca);
  const now = Date.now();
  for (const certificate of [serverCertificate, rootCertificate]) {
    if (now < Date.parse(certificate.validFrom) || now >= Date.parse(certificate.validTo)) {
      throw new Error('HTTPS certificate is not currently valid. Renew certificates before starting.');
    }
  }
  if (serverCertificate.ca || !rootCertificate.ca || !rootCertificate.verify(rootCertificate.publicKey) ||
      !serverCertificate.verify(rootCertificate.publicKey) ||
      !serverCertificate.checkHost(config.hostname, { subject: 'never' }) ||
      !serverCertificate.checkIP(config.ipAddress)) {
    throw new Error('HTTPS certificate must be signed by the configured Root CA and cover the configured DNS name and IP.');
  }
  const options = { key, cert, minVersion: 'TLSv1.2' };
  tls.createSecureContext(options);
  return { ...config, options, certificateExpiresAt: serverCertificate.validTo };
}

function httpsOrigins(config, surface) {
  return [config.hostname, config.ipAddress].map((host) => `https://${host}:${HTTPS_PORTS[surface]}`);
}

module.exports = { HTTPS_PORTS, requirePrivateFile, loadHttpsConfig, httpsOrigins };
