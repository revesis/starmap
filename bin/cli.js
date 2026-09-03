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
        'starmap — render the current directory\'s code as a particle cosmos',
        '',
        'Usage: starmap [dir] [--port 4550] [--https]',
        '',
        '  --https  Serve HTTPS with a self-signed cert (needed for the camera',
        '           gesture feature when accessed from another device over LAN)',
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
      console.log(`✨ starmap is scanning: ${rootDir}`);
      console.log(`🌌 Open locally: https://localhost:${args.port}`);
      for (const addr of listLanAddresses()) {
        console.log(`📱 Open from a LAN device: https://${addr}:${args.port}`);
      }
      console.log('⚠️  Self-signed cert — your browser will warn it\'s unsafe, just click through');
    });
  } else {
    const server = createServer(rootDir);
    server.listen(args.port, () => {
      console.log(`✨ starmap is scanning: ${rootDir}`);
      console.log(`🌌 Open in your browser: http://localhost:${args.port}`);
      console.log('   (camera gestures need https or localhost; add --https for LAN access)');
    });
  }
}

main();
