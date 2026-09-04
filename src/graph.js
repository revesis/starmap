'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// extension -> color (the particle's "element" color)
const COLOR_TABLE = {
  '.js': '#f7df1e',
  '.jsx': '#f7df1e',
  '.mjs': '#f7df1e',
  '.cjs': '#f7df1e',
  '.ts': '#3178c6',
  '.tsx': '#3178c6',
  '.py': '#3572a5',
  '.go': '#00add8',
  '.rs': '#dea584',
  '.java': '#b07219',
  '.rb': '#701516',
  '.php': '#4f5d95',
  '.c': '#555555',
  '.h': '#555555',
  '.cpp': '#f34b7d',
  '.hpp': '#f34b7d',
  '.cc': '#f34b7d',
  '.cs': '#178600',
  '.css': '#563d7c',
  '.scss': '#c6538c',
  '.html': '#e34c26',
  '.json': '#8bc34a',
  '.md': '#9e9e9e',
  '.yml': '#cb171e',
  '.yaml': '#cb171e',
  '.sh': '#89e051',
  '.sql': '#e38c00',
  '.vue': '#41b883',
};
const DEFAULT_COLOR = '#7a7a7a';

const RESOLVABLE_EXT = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.py'];
const INDEX_NAMES = ['index.js', 'index.ts', 'index.jsx', 'index.tsx', '__init__.py'];

// "reference another file" syntax across languages — only matches relative-path
// imports (skips third-party packages / stdlib)
const IMPORT_PATTERNS = [
  /\bimport\s+(?:[^'"]+?\s+from\s+)?['"](\.[^'"]+)['"]/g, // import x from './y'
  /\brequire\(\s*['"](\.[^'"]+)['"]\s*\)/g, // require('./y')
  /\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g, // dynamic import('./y')
  /^\s*from\s+(\.+[\w.]*)\s+import\b/gm, // python: from .y import z
  /^\s*import\s+(\.+[\w.]+)/gm, // python: import .y (rare but handled)
];

function extractRelativeImports(content) {
  const specs = [];
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content))) {
      specs.push(m[1]);
    }
  }
  return specs;
}

function resolveImport(fromRel, spec, fileSet) {
  const fromDir = path.posix.dirname(fromRel);
  // Python-style dotted relative import, convert to a path separator
  let normSpec = spec;
  if (/^\.+[\w.]*$/.test(spec) && !spec.includes('/')) {
    const dots = spec.match(/^\.+/)[0].length;
    const rest = spec.slice(dots).replace(/\./g, '/');
    const up = '../'.repeat(dots - 1);
    normSpec = (dots > 1 ? up : './') + rest;
  }
  const basePath = path.posix.normalize(path.posix.join(fromDir, normSpec));

  for (const ext of RESOLVABLE_EXT) {
    const candidate = basePath + ext;
    if (fileSet.has(candidate)) return candidate;
  }
  for (const idx of INDEX_NAMES) {
    const candidate = path.posix.join(basePath, idx);
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

function sizeToRadius(size, minSize, maxSize) {
  const MIN_R = 3;
  const MAX_R = 26;
  if (maxSize === minSize) return (MIN_R + MAX_R) / 2;
  const t = (size - minSize) / (maxSize - minSize);
  return MIN_R + t * (MAX_R - MIN_R);
}

function isProbablyBinary(content) {
  return content.indexOf(String.fromCharCode(0)) !== -1;
}

// Lines added+deleted per file in the most recent commit — a cheap, "what just happened" signal
// rather than a long-term activity score. Deliberately only looks at HEAD's commit (not the
// working tree, so uncommitted edits don't count) and not further history, so this is a
// single-commit `git show --numstat` call, cheap enough to run on every rebuild with no caching
// needed. A file present as a key here (even at 0) is "touched"; everything else wasn't.
function computeLastCommitStats(rootDir) {
  const stats = new Map();
  try {
    const out = execFileSync(
      'git',
      ['-C', rootDir, 'show', '--numstat', '--pretty=format:', '-1'],
      { maxBuffer: 1024 * 1024 * 64 }
    ).toString('utf8');
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [addedStr, deletedStr, rel] = trimmed.split('\t');
      if (!rel) continue;
      // "-" means numstat couldn't diff it (binary file) — still counts as touched, just with no
      // meaningful line count
      const added = addedStr === '-' ? 0 : parseInt(addedStr, 10) || 0;
      const deleted = deletedStr === '-' ? 0 : parseInt(deletedStr, 10) || 0;
      stats.set(rel, added + deleted);
    }
  } catch {
    // no commits yet, or not a git repo — leave stats empty
  }
  return stats;
}

function build(rootDir, files, gitRepo) {
  const fileSet = new Set(files.map((f) => f.rel));
  const sizes = files.map((f) => f.size);
  const minSize = Math.min(...sizes, 0);
  const maxSize = Math.max(...sizes, 1);
  const lastCommitStats = gitRepo ? computeLastCommitStats(rootDir) : new Map();

  const nodes = files.map((f) => ({
    id: f.rel,
    label: path.posix.basename(f.rel),
    dir: path.posix.dirname(f.rel) === '.' ? '' : path.posix.dirname(f.rel).split('/')[0],
    ext: f.ext,
    size: f.size,
    radius: Math.round(sizeToRadius(f.size, minSize, maxSize) * 10) / 10,
    color: COLOR_TABLE[f.ext] || DEFAULT_COLOR,
    degree: 0,
    inDegree: 0, // how many other files import this one
    outDegree: 0, // how many other files this one imports
    touched: lastCommitStats.has(f.rel),
    changeRatio: 0, // filled in below, only for touched files
  }));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // changeRatio = what fraction of THIS file's own lines the latest commit rewrote — reading full
  // content only for the (usually small) set of touched files, regardless of repo size, so this
  // stays cheap even on a large codebase.
  for (const [rel, changedLines] of lastCommitStats) {
    const n = nodeById.get(rel);
    const f = n && files.find((file) => file.rel === rel);
    if (!f) continue; // renamed/deleted since that commit, or a numstat line we couldn't map
    try {
      const content = fs.readFileSync(f.abs, 'utf8');
      if (isProbablyBinary(content)) continue;
      const totalLines = content.split('\n').length || 1;
      n.changeRatio = Math.round(Math.min(1, changedLines / totalLines) * 100) / 100;
    } catch {
      // unreadable file — leave changeRatio at 0
    }
  }

  const edgeSet = new Set();
  const edges = [];
  const codeExts = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py']);

  for (const f of files) {
    if (!codeExts.has(f.ext)) continue;
    let content;
    try {
      content = fs.readFileSync(f.abs, 'utf8');
    } catch {
      continue;
    }
    if (isProbablyBinary(content)) continue;

    const specs = extractRelativeImports(content);
    for (const spec of specs) {
      const target = resolveImport(f.rel, spec, fileSet);
      if (!target || target === f.rel) continue;
      const key = f.rel + '=>' + target;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push({ source: f.rel, target });
    }
  }

  for (const e of edges) {
    const s = nodeById.get(e.source);
    const t = nodeById.get(e.target);
    if (s) { s.degree += 1; s.outDegree += 1; }
    if (t) { t.degree += 1; t.inDegree += 1; }
  }

  const maxDegree = Math.max(1, ...nodes.map((n) => n.degree));
  for (const n of nodes) {
    n.intensity = Math.round((n.degree / maxDegree) * 100) / 100; // 0..1, color depth (also part of gravity mass)
  }

  return { nodes, edges, maxDegree };
}

module.exports = { build, COLOR_TABLE, DEFAULT_COLOR };
