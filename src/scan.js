'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HARD_IGNORE_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn']);

function isGitRepo(rootDir) {
  try {
    execFileSync('git', ['-C', rootDir, 'rev-parse', '--is-inside-work-tree'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

// Get the file list via git: tracked files + untracked files not excluded by .gitignore
function listFilesViaGit(rootDir) {
  const out = execFileSync(
    'git',
    ['-C', rootDir, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { maxBuffer: 1024 * 1024 * 64 }
  ).toString('utf8');
  return out.split('\0').filter(Boolean);
}

// Fallback when there's no git: manual recursion, only excluding a few common heavy dirs
function listFilesViaWalk(rootDir) {
  const results = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (HARD_IGNORE_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        results.push(path.relative(rootDir, path.join(dir, entry.name)));
      }
    }
  }
  walk(rootDir);
  return results;
}

function scan(rootDir) {
  const gitRepo = isGitRepo(rootDir);
  const relFiles = gitRepo ? listFilesViaGit(rootDir) : listFilesViaWalk(rootDir);

  const files = [];
  for (const rel of relFiles) {
    const abs = path.join(rootDir, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue; // e.g. a tracked file that's been deleted locally
    }
    if (!stat.isFile()) continue;
    files.push({
      rel: rel.split(path.sep).join('/'),
      abs,
      size: stat.size,
      ext: path.extname(rel).toLowerCase(),
    });
  }
  return { gitRepo, files };
}

module.exports = { scan };
