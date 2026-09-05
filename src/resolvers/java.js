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

// Spring (and JSR-330) dependency injection wires a collaborator by TYPE alone — no import is
// required at all when the two classes share a package, so `import`-only scanning misses those
// edges entirely. These two patterns catch the two DI shapes: an @Autowired/@Inject/@Resource
// field, and an @Autowired constructor whose parameters are the injected dependencies. Only the
// annotation immediately above the field/constructor is matched (one line of `@Foo(...)` in
// between, e.g. a `@Qualifier` stacked below `@Autowired`, is tolerated; anything further is a
// known/accepted gap, same spirit as skipping `import static`/wildcard imports above). The
// captured type is a short (unqualified) class name in the common case — `resolve()` below
// suffix-matches it against every file in the repo the same way it does a fully-qualified import,
// so no separate resolution path is needed for it.
const FIELD_INJECT = /@(?:Autowired|Inject|Resource)\b(?:\([^)]*\))?\s*\n?(?:\s*@\w+(?:\([^)]*\))?\s*\n?)*\s*(?:private|protected|public)?\s*(?:final\s+)?([\w.]+)\s*(?:<\s*([\w.]+)[^>]*>)?\s*(?:\[\])?\s+\w+\s*[;=]/g;
const CONSTRUCTOR_INJECT = /@Autowired\b(?:\([^)]*\))?\s*\n?(?:\s*@\w+(?:\([^)]*\))?\s*\n?)*\s*(?:public|private|protected)?\s*\w+\s*\(([^)]*)\)\s*\{/g;

function paramType(param) {
  const cleaned = param.replace(/@\w+(?:\([^)]*\))?/g, '').trim();
  const m = cleaned.match(/^([\w.]+)\s*(?:<\s*([\w.]+)[^>]*>)?\s*(?:\[\])?\s+\w+$/);
  if (!m) return null;
  return m[2] || m[1];
}

const PRIMITIVE_LIKE = new Set([
  'String', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'Byte', 'Short', 'Character',
  'Object', 'List', 'Map', 'Set', 'Collection', 'Optional', 'int', 'long', 'double', 'float',
  'boolean', 'byte', 'short', 'char',
]);

function extractSpecs(content) {
  const specs = [];
  PATTERN.lastIndex = 0;
  let m;
  while ((m = PATTERN.exec(content))) {
    if (m[1].endsWith('.*')) continue;
    specs.push(m[1]);
  }

  FIELD_INJECT.lastIndex = 0;
  while ((m = FIELD_INJECT.exec(content))) {
    const type = m[2] || m[1];
    if (!PRIMITIVE_LIKE.has(type)) specs.push(type);
  }

  CONSTRUCTOR_INJECT.lastIndex = 0;
  while ((m = CONSTRUCTOR_INJECT.exec(content))) {
    for (const raw of m[1].split(',')) {
      const param = raw.trim();
      if (!param) continue;
      const type = paramType(param);
      if (type && !PRIMITIVE_LIKE.has(type)) specs.push(type);
    }
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
