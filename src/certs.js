'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// 摄像头（getUserMedia）只在"安全上下文"里可用：https，或者 http://localhost。
// 局域网访问（比如手机连电脑的 IP）必须走 https，这里用 openssl 生成一份自签名证书，
// 缓存到用户目录，避免每次启动都重新生成。
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
        '生成自签名证书失败（需要系统装有 openssl）：' + (err.stderr ? err.stderr.toString('utf8') : err.message)
      );
    }
  }

  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

// 局域网可访问的 IPv4 地址列表，方便打印给手机等设备使用
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
