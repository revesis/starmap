'use strict';

const path = require('path');
const { resolveRelativePath } = require('./resolve-utils');

const extensions = ['.rs'];

// Rust's actual file-inclusion mechanism is `mod name;` (no body) — that's what pulls another
// file into the crate at all, unlike `use`, which only brings an already-mod-included item into
// scope. `mod name { ... }` (a body right there, no separate file) is deliberately NOT matched:
// requiring the `;` immediately after the name (nothing else, e.g. `{`) is what tells the two
// apart. `use` paths are a known/accepted gap here, same spirit as skipping `import static` in
// java.js — resolving `use crate::a::b::Item` needs simulating the whole module tree just to
// tell whether the last segment is itself a module or an item defined inside one, with no path
// hint either way.
const PATTERN = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm;

function extractSpecs(content) {
  const specs = [];
  PATTERN.lastIndex = 0;
  let m;
  while ((m = PATTERN.exec(content))) specs.push(m[1]);
  return specs;
}

// Where do THIS file's own submodules live? mod.rs/lib.rs/main.rs are "the directory itself is
// this module" (2018-edition-style crate roots and old-style mod.rs), so a submodule sits right
// next to them; any other file `dir/stem.rs` is itself a leaf module, so ITS submodules live one
// level down, in `dir/stem/` — mirroring how a submodule can be either `dir/stem/name.rs` or the
// old-style `dir/stem/name/mod.rs`.
function submoduleDir(fromRel) {
  const dir = path.posix.dirname(fromRel);
  const base = path.posix.basename(fromRel, '.rs');
  const parent = dir === '.' ? '' : dir;
  if (base === 'mod' || base === 'lib' || base === 'main') return parent;
  return parent ? parent + '/' + base : base;
}

function resolve(fromRel, spec, fileSet) {
  const dir = submoduleDir(fromRel);
  const pseudoFromRel = dir ? dir + '/_' : '_'; // resolveRelativePath only reads its dirname
  return resolveRelativePath(pseudoFromRel, spec, fileSet, ['.rs'], ['mod.rs']);
}

module.exports = { extensions, extractSpecs, resolve };
