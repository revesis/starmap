'use strict';

const extensions = ['.go'];

// Go imports use a fully-qualified module import path (e.g. "myproject/pkg/foo" or
// "github.com/user/repo/pkg/foo"), not a path relative to the importing file, and they name a
// whole *package* — a directory, since several .go files can share one package — not a single
// file. Like java.js, this can't reuse resolve-utils' relative path-join logic. Rather than
// reading go.mod to strip the real module prefix, it tries progressively shorter suffixes of the
// import path against the repo's directories (longest first, so a more specific match wins), and
// once a directory matches, picks one representative .go file inside it — the same "one file
// stands in for a directory" idea resolve-utils gets from INDEX_NAMES for JS/Python, just found
// differently since Go has no single conventional filename to look for.
const SINGLE_IMPORT = /^\s*import\s+(?:\w+\s+)?"([^"]+)"/gm;
const IMPORT_BLOCK = /import\s*\(([\s\S]*?)\)/g;
const BLOCK_LINE = /(?:^|\n)\s*(?:\w+\s+)?"([^"]+)"/g;

function extractSpecs(content) {
  const specs = [];
  IMPORT_BLOCK.lastIndex = 0;
  let m;
  while ((m = IMPORT_BLOCK.exec(content))) {
    BLOCK_LINE.lastIndex = 0;
    let lm;
    while ((lm = BLOCK_LINE.exec(m[1]))) specs.push(lm[1]);
  }
  SINGLE_IMPORT.lastIndex = 0;
  while ((m = SINGLE_IMPORT.exec(content))) specs.push(m[1]);
  return specs;
}

// resolve() runs once per import statement, but the fileSet it's given is the same object for
// every call within one scan — cache each one's directory -> [.go files] index instead of
// rebuilding it per import.
const dirCache = new WeakMap();
function goFilesByDir(fileSet) {
  let index = dirCache.get(fileSet);
  if (index) return index;
  index = new Map();
  for (const rel of fileSet) {
    if (!rel.endsWith('.go')) continue;
    const slash = rel.lastIndexOf('/');
    const dir = slash === -1 ? '' : rel.slice(0, slash);
    let arr = index.get(dir);
    if (!arr) index.set(dir, (arr = []));
    arr.push(rel);
  }
  dirCache.set(fileSet, index);
  return index;
}

function resolve(fromRel, spec, fileSet) {
  const index = goFilesByDir(fileSet);
  const segments = spec.split('/');
  // Longest suffix first (never the empty/root directory — that would make every unresolved
  // import spuriously land on whatever's at the repo root)
  for (let i = 0; i < segments.length; i++) {
    const dir = segments.slice(i).join('/');
    const files = index.get(dir);
    if (!files) continue;
    const candidates = files.filter((f) => f !== fromRel);
    if (!candidates.length) continue;
    const nonTest = candidates.filter((f) => !f.endsWith('_test.go'));
    const pool = (nonTest.length ? nonTest : candidates).slice().sort();
    return pool[0];
  }
  return null;
}

module.exports = { extensions, extractSpecs, resolve };
