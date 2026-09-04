'use strict';

const extensions = ['.java'];

// Java imports are fully-qualified package paths (e.g. import com.example.foo.Bar;), not a path
// relative to the importing file — so unlike every other resolver here, this can't reuse
// resolve-utils' relative path-join logic. Instead the dotted name becomes a path suffix
// (com/example/foo/Bar.java) matched against the end of every file in the repo, since we don't
// know — and don't try to infer — the project's actual source root (src/main/java/, src/, or
// none at all for a flat layout). `import static` and wildcard (`import com.example.*;`) imports
// are skipped: the former's last segment could be a class or a member with no way to tell without
// real symbol resolution, and the latter names a whole package, not one file.
const PATTERN = /^\s*import\s+(?!static\s)([\w.]+)\s*;/gm;

function extractSpecs(content) {
  const specs = [];
  PATTERN.lastIndex = 0;
  let m;
  while ((m = PATTERN.exec(content))) {
    if (m[1].endsWith('.*')) continue;
    specs.push(m[1]);
  }
  return specs;
}

function resolve(fromRel, spec, fileSet) {
  const suffix = spec.replace(/\./g, '/') + '.java';
  for (const candidate of fileSet) {
    if (candidate === fromRel) continue;
    if (candidate === suffix || candidate.endsWith('/' + suffix)) return candidate;
  }
  return null;
}

module.exports = { extensions, extractSpecs, resolve };
