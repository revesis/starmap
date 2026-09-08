'use strict';

const { resolveRelativePath } = require('./resolve-utils');

const extensions = ['.html', '.htm'];
// Script tags reference their target as a plain relative path (browsers don't extension-search or
// index-resolve), but resolveRelativePath's fallback passes are harmless no-ops here since the
// verbatim join always matches first for a well-formed page.
const RESOLVABLE_EXT = [''];
const INDEX_NAMES = [];

// Only <script src="...">, not <link>/<img>/etc — this repo's own index.html loading app.js et al.
// is the motivating case (plain script tags, load order encoded in document order, no bundler).
// Skips absolute URLs (http(s):, protocol-relative //, and root-relative /path) since those aren't
// local repo files resolveRelativePath could ever match.
const SCRIPT_SRC = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;

function extractSpecs(content) {
  const specs = [];
  let m;
  SCRIPT_SRC.lastIndex = 0;
  while ((m = SCRIPT_SRC.exec(content))) {
    const spec = m[1];
    if (/^(?:[a-z]+:)?\/\//i.test(spec) || spec.startsWith('/') || spec.startsWith('data:')) continue;
    specs.push(spec);
  }
  return specs;
}

function resolve(fromRel, spec, fileSet) {
  return resolveRelativePath(fromRel, spec, fileSet, RESOLVABLE_EXT, INDEX_NAMES);
}

module.exports = { extensions, extractSpecs, resolve };
