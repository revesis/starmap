'use strict';

const { resolveRelativePath } = require('./resolve-utils');

const extensions = ['.dart'];
const RESOLVABLE_EXT = ['']; // dart imports always spell out the .dart extension already
const INDEX_NAMES = [];

// Unlike JS, a same-package relative reference is normally written *without* a leading './'
// (e.g. import 'models/user.dart';), so this can't require a dot prefix like the JS pattern —
// instead it excludes `dart:` (SDK imports, never resolvable) and requires the literal .dart
// extension. `package:` imports ARE kept (unlike before) — see resolve() below for why. `part of`
// directives are deliberately not matched (that's the reverse direction of a part file declaring
// its parent, and would just double up the same edge).
const PATTERNS = [
  /\b(?:import|export|part)\s+['"]((?!dart:)[^'"]+\.dart)['"]/g,
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

// A real Flutter/Dart app imports its own files via `package:<name>/<path>.dart`, not a relative
// path — Dart convention maps that straight to `lib/<path>.dart` in the SAME package (the `<name>`
// segment is just the pubspec.yaml package name echoed back). Rather than reading pubspec.yaml to
// confirm `<name>` matches this repo (no resolver here gets rootDir, only fileSet), just try
// `lib/<path>` directly: a genuinely external package's subpath essentially never collides with a
// file already in this repo's own lib/, so an external `package:dio/dio.dart` naturally resolves
// to nothing instead of a false match — same suffix-matching trade-off java.js/go.js already make.
function resolve(fromRel, spec, fileSet) {
  if (spec.startsWith('package:')) {
    const slash = spec.indexOf('/', 'package:'.length);
    if (slash === -1) return null;
    const candidate = 'lib/' + spec.slice(slash + 1);
    return fileSet.has(candidate) ? candidate : null;
  }
  return resolveRelativePath(fromRel, spec, fileSet, RESOLVABLE_EXT, INDEX_NAMES);
}

module.exports = { extensions, extractSpecs, resolve };
