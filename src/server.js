'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { URL } = require('url');

const { scan } = require('./scan');
const { build } = require('./graph');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function safeResolveRel(rootDir, rel) {
  if (typeof rel !== 'string' || rel.length === 0) return null;
  const abs = path.resolve(rootDir, rel);
  const relCheck = path.relative(rootDir, abs);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) return null;
  return abs;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const abs = path.join(PUBLIC_DIR, rel);
  if (!abs.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(abs, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(abs);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function createRequestHandler(rootDir) {
  let cached = null;
  function getGraph() {
    if (!cached) {
      const { gitRepo, files } = scan(rootDir);
      cached = { gitRepo, ...build(rootDir, files, gitRepo) };
    }
    return cached;
  }

  return (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/graph') {
      sendJson(res, 200, getGraph());
      return;
    }

    if (url.pathname === '/api/refresh' && req.method === 'POST') {
      cached = null;
      sendJson(res, 200, getGraph());
      return;
    }

    if (url.pathname === '/api/diff') {
      const rel = url.searchParams.get('file');
      const abs = safeResolveRel(rootDir, rel);
      if (!abs) {
        sendJson(res, 400, { error: 'invalid file' });
        return;
      }
      execFile('git', ['-C', rootDir, 'diff', '--', rel], (err1, diffOut) => {
        execFile(
          'git',
          ['-C', rootDir, 'log', '--oneline', '-n', '20', '--', rel],
          (err2, logOut) => {
            execFile(
              'git',
              ['-C', rootDir, 'status', '--porcelain', '--', rel],
              (err3, statusOut) => {
                sendJson(res, 200, {
                  file: rel,
                  diff: err1 ? null : diffOut.toString('utf8'),
                  log: err2 ? null : logOut.toString('utf8'),
                  status: err3 ? null : statusOut.toString('utf8'),
                });
              }
            );
          }
        );
      });
      return;
    }

    if (url.pathname === '/api/file') {
      const rel = url.searchParams.get('file');
      const abs = safeResolveRel(rootDir, rel);
      if (!abs) {
        sendJson(res, 400, { error: 'invalid file' });
        return;
      }
      fs.readFile(abs, 'utf8', (err, data) => {
        if (err) {
          sendJson(res, 404, { error: 'not found or not text' });
          return;
        }
        const MAX = 200000;
        sendJson(res, 200, {
          file: rel,
          content: data.length > MAX ? data.slice(0, MAX) + '\n...(truncated)' : data,
          truncated: data.length > MAX,
        });
      });
      return;
    }

    serveStatic(req, res, url.pathname);
  };
}

function createServer(rootDir) {
  return http.createServer(createRequestHandler(rootDir));
}

module.exports = { createServer, createRequestHandler };
