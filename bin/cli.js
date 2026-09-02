#!/usr/bin/env node
'use strict';

const path = require('path');
const https = require('https');
const { createServer, createRequestHandler } = require('../src/server');
const { ensureSelfSignedCert, listLanAddresses } = require('../src/certs');

function parseArgs(argv) {
  const args = { dir: '.', port: 4550, https: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') {
      args.port = parseInt(argv[++i], 10);
    } else if (a === '--https') {
      args.https = true;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else {
      rest.push(a);
    }
  }
  if (rest[0]) args.dir = rest[0];
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      [
        'starmap — 把当前目录的代码渲染成一片星云',
        '',
        '用法: starmap [目录] [--port 4550] [--https]',
        '',
        '  --https  用自签名证书起 HTTPS（手机等设备通过局域网 IP 访问时，',
        '           摄像头手势功能需要安全上下文，必须用这个）',
      ].join('\n')
    );
    return;
  }

  const rootDir = path.resolve(process.cwd(), args.dir);

  if (args.https) {
    let certs;
    try {
      certs = ensureSelfSignedCert();
    } catch (err) {
      console.error('✗ ' + err.message);
      process.exit(1);
    }
    const server = https.createServer(certs, createRequestHandler(rootDir));
    server.listen(args.port, () => {
      console.log(`✨ starmap 正在扫描: ${rootDir}`);
      console.log(`🌌 本机打开: https://localhost:${args.port}`);
      for (const addr of listLanAddresses()) {
        console.log(`📱 局域网设备打开: https://${addr}:${args.port}`);
      }
      console.log('⚠️  自签名证书，浏览器会提示不安全，选择"继续访问"即可');
    });
  } else {
    const server = createServer(rootDir);
    server.listen(args.port, () => {
      console.log(`✨ starmap 正在扫描: ${rootDir}`);
      console.log(`🌌 在浏览器打开: http://localhost:${args.port}`);
      console.log('   （摄像头手势功能需要 https 或 localhost；局域网访问请加 --https）');
    });
  }
}

main();
