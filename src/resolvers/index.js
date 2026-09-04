'use strict';

// Each resolver owns one language's "what does this file reference" logic: its own regex
// patterns (extractSpecs) and its own path resolution quirks (resolve) — e.g. Python's dotted
// imports or Dart's extension-always-included, no-leading-dot style. Adding a new language means
// adding one file here, not extending a shared pattern/resolution pair that has to special-case
// every language it already knows about.
const resolvers = [
  require('./javascript'),
  require('./python'),
  require('./dart'),
];

const byExt = new Map();
for (const resolver of resolvers) {
  for (const ext of resolver.extensions) byExt.set(ext, resolver);
}

module.exports = { byExt };
