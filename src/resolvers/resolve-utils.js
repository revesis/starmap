'use strict';

const path = require('path');

// Generic "relative spec -> an existing file in the repo" resolution, shared by every language
// resolver below: try the spec verbatim, then with each resolvable extension appended (for
// languages like JS where the extension is often omitted), then as an index/init file inside a
// directory of that name.
function resolveRelativePath(fromRel, spec, fileSet, resolvableExt, indexNames) {
  const fromDir = path.posix.dirname(fromRel);
  const basePath = path.posix.normalize(path.posix.join(fromDir, spec));

  for (const ext of resolvableExt) {
    const candidate = basePath + ext;
    if (fileSet.has(candidate)) return candidate;
  }
  for (const idx of indexNames) {
    const candidate = path.posix.join(basePath, idx);
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

module.exports = { resolveRelativePath };
