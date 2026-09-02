'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// 扩展名 -> 颜色（粒子的“元素”色）
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

// 各语言里“引用别的文件”的写法，全部只抓相对路径 import（跳过第三方包/标准库）
const IMPORT_PATTERNS = [
  /\bimport\s+(?:[^'"]+?\s+from\s+)?['"](\.[^'"]+)['"]/g, // import x from './y'
  /\brequire\(\s*['"](\.[^'"]+)['"]\s*\)/g, // require('./y')
  /\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g, // dynamic import('./y')
  /^\s*from\s+(\.+[\w.]*)\s+import\b/gm, // python: from .y import z
  /^\s*import\s+(\.+[\w.]+)/gm, // python: import .y (少见但保留)
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
  // python 风格的点号相对导入，转成路径分隔
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

// 熵：用文件被提交触碰的次数（churn）来近似"这个文件有多混乱/多常变"
function computeChurn(rootDir) {
  try {
    const out = execFileSync(
      'git',
      ['-C', rootDir, 'log', '--pretty=format:', '--name-only', '-n', '3000'],
      { maxBuffer: 1024 * 1024 * 64 }
    ).toString('utf8');
    const counts = new Map();
    for (const line of out.split('\n')) {
      const rel = line.trim();
      if (!rel) continue;
      counts.set(rel, (counts.get(rel) || 0) + 1);
    }
    return counts;
  } catch {
    return new Map();
  }
}

function build(rootDir, files, gitRepo) {
  const fileSet = new Set(files.map((f) => f.rel));
  const sizes = files.map((f) => f.size);
  const minSize = Math.min(...sizes, 0);
  const maxSize = Math.max(...sizes, 1);
  const churnMap = gitRepo ? computeChurn(rootDir) : new Map();

  const nodes = files.map((f) => ({
    id: f.rel,
    label: path.posix.basename(f.rel),
    dir: path.posix.dirname(f.rel) === '.' ? '' : path.posix.dirname(f.rel).split('/')[0],
    ext: f.ext,
    size: f.size,
    radius: Math.round(sizeToRadius(f.size, minSize, maxSize) * 10) / 10,
    color: COLOR_TABLE[f.ext] || DEFAULT_COLOR,
    degree: 0,
    churn: churnMap.get(f.rel) || 0,
  }));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

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
    if (s) s.degree += 1;
    if (t) t.degree += 1;
  }

  const maxDegree = Math.max(1, ...nodes.map((n) => n.degree));
  const maxChurn = Math.max(1, ...nodes.map((n) => n.churn));
  for (const n of nodes) {
    n.intensity = Math.round((n.degree / maxDegree) * 100) / 100; // 0..1，颜色深浅（引力质量的一部分）
    n.entropy = Math.round((n.churn / maxChurn) * 100) / 100; // 0..1，改动越频繁越"热"越无序
  }

  return { nodes, edges, maxDegree };
}

module.exports = { build, COLOR_TABLE, DEFAULT_COLOR };
