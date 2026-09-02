'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// The camera (getUserMedia) only works in a "secure context": https, or http://localhost.
// LAN access (e.g. a phone hitting the machine's IP) must go over https, so we generate a
// self-signed cert with openssl here and cache it in the user's home dir to avoid
// regenerating it on every startup.
function ensureSelfSignedCert() {
  const dir = path.join(os.homedir(), '.cache', 'starmap');
  fs.mkdirSync(dir, { recursive: true });
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');

  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    try {
      execFileSync(
        'openssl',
        [
          'req', '-x509', '-newkey', 'rsa:2048',
          '-keyout', keyPath, '-out', certPath,
          '-days', '825', '-nodes',
          '-subj', '/CN=starmap',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );
    } catch (err) {
      throw new Error(
        'Failed to generate self-signed cert (requires openssl on the system): ' +
          (err.stderr ? err.stderr.toString('utf8') : err.message)
      );
    }
  }

  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

// LAN-reachable IPv4 addresses, so we can print one for phones and other devices to use
function listLanAddresses() {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  return addrs;
}

module.exports = { ensureSelfSignedCert, listLanAddresses };
