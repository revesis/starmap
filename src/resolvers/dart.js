'use strict';

const { resolveRelativePath } = require('./resolve-utils');

const extensions = ['.dart'];
const RESOLVABLE_EXT = ['']; // dart imports always spell out the .dart extension already
const INDEX_NAMES = [];

// Unlike JS, a same-package relative reference is normally written *without* a leading './'
// (e.g. import 'models/user.dart';), so this can't require a dot prefix like the JS pattern —
// instead it excludes the two non-relative schemes (package:, dart:) and requires the literal
// .dart extension. `part of` directives are deliberately not matched (that's the reverse
// direction of a part file declaring its parent, and would just double up the same edge).
const PATTERNS = [
  /\b(?:import|export|part)\s+['"]((?!package:)(?!dart:)[^'"]+\.dart)['"]/g,
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
