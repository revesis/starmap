'use strict';

const { resolveRelativePath } = require('./resolve-utils');

const extensions = ['.py'];
const RESOLVABLE_EXT = ['', '.py'];
const INDEX_NAMES = ['__init__.py'];

const PATTERNS = [
  /^\s*from\s+(\.+[\w.]*)\s+import\b/gm, // from .y import z
  /^\s*import\s+(\.+[\w.]+)/gm, // import .y (rare but handled)
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

// Python's dotted relative import ("..models.user" or ".utils") isn't a path yet — leading dots
// count levels up, and dots between names are path separators — so it needs converting before
// the generic path-join resolution in resolve-utils can run on it.
function normalizeSpec(spec) {
  if (!/^\.+[\w.]*$/.test(spec) || spec.includes('/')) return spec;
  const dots = spec.match(/^\.+/)[0].length;
  const rest = spec.slice(dots).replace(/\./g, '/');
  const up = '../'.repeat(dots - 1);
  return (dots > 1 ? up : './') + rest;
}

function resolve(fromRel, spec, fileSet) {
  return resolveRelativePath(fromRel, normalizeSpec(spec), fileSet, RESOLVABLE_EXT, INDEX_NAMES);
}

module.exports = { extensions, extractSpecs, resolve };
