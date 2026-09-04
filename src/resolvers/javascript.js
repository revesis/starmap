'use strict';

const { resolveRelativePath } = require('./resolve-utils');

const extensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
const RESOLVABLE_EXT = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json'];
const INDEX_NAMES = ['index.js', 'index.ts', 'index.jsx', 'index.tsx'];

// Only matches relative-path imports (skips third-party packages) — a bare specifier like
// 'react' never starts with a dot, so it's excluded by construction rather than an allowlist.
const PATTERNS = [
  /\bimport\s+(?:[^'"]+?\s+from\s+)?['"](\.[^'"]+)['"]/g, // import x from './y'
  /\brequire\(\s*['"](\.[^'"]+)['"]\s*\)/g, // require('./y')
  /\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g, // dynamic import('./y')
];

function extractSpecs(content) {
  const specs = [];
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content))) specs.push(m[1]);
  }
  return specs;
}

function resolve(fromRel, spec, fileSet) {
  return resolveRelativePath(fromRel, spec, fileSet, RESOLVABLE_EXT, INDEX_NAMES);
}

module.exports = { extensions, extractSpecs, resolve };
