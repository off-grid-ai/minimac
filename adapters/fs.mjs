// Repository lookup for the composer: which files exist, which skills are
// installed, and whether a folder is a usable working directory.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const run = promisify(execFile);

export function createRepoIndex() {
  const cache = new Map(); // repo -> { files, at }
  const TTL_MS = 15_000;

  async function files(repo) {
    const hit = cache.get(repo);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.files;
    const list = await gitFiles(repo);
    cache.set(repo, { files: list, at: Date.now() });
    return list;
  }

  return {
    async search(repo, query, limit = 20) {
      const all = await files(repo);
      if (!query) return all.slice(0, limit);
      return rank(all, query).slice(0, limit);
    },

    async skills(repo) {
      const roots = [
        join(repo, '.claude', 'skills'),
        join(repo, '.claude', 'commands'),
        join(homedir(), '.claude', 'skills'),
        join(homedir(), '.claude', 'commands'),
      ];
      const found = new Set();
      for (const root of roots) {
        for (const name of await entries(root)) found.add(name);
      }
      return [...found].sort();
    },

    // A path typed or pasted into the composer is meant as a file. Only paths
    // that actually exist are treated as such; the rest stays prose.
    async existingPaths(text) {
      const candidates = String(text ?? '').match(/(?:^|\s)(\/[^\n]*?\.[A-Za-z0-9]{1,6})(?=\s|$)/g) ?? [];
      const found = [];
      for (const raw of candidates) {
        const path = raw.trim();
        const info = await stat(path).catch(() => null);
        if (info?.isFile()) found.push(path);
      }
      return found;
    },

    // Browsing is server-side because the browser cannot hand a real path to a
    // process. Directories only - files are irrelevant when choosing a root.
    async dirs(path) {
      const here = path && path !== '~' ? path : homedir();
      const items = await readdir(here, { withFileTypes: true }).catch(() => []);
      const children = items
        .filter((item) => item.isDirectory() && !item.name.startsWith('.'))
        .map((item) => item.name)
        .sort((a, b) => a.localeCompare(b));
      return { path: here, parent: dirname(here), home: homedir(), children };
    },

    // A folder is usable when it exists and git can see it, because worktree
    // isolation and file claims both depend on that.
    async check(dir) {
      try {
        const info = await stat(dir);
        if (!info.isDirectory()) return { ok: false, reason: 'not a directory' };
      } catch {
        return { ok: false, reason: 'does not exist' };
      }
      try {
        await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir });
        cache.delete(dir);
        return { ok: true, git: true };
      } catch {
        return { ok: true, git: false };
      }
    },
  };
}

async function gitFiles(repo) {
  try {
    const { stdout } = await run('git', ['ls-files'], { cwd: repo, maxBuffer: 16 * 1024 * 1024 });
    return stdout.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function entries(dir) {
  try {
    const items = await readdir(dir, { withFileTypes: true });
    return items
      .filter((item) => item.isDirectory() || item.name.endsWith('.md'))
      .map((item) => item.name.replace(/\.md$/, ''));
  } catch {
    return [];
  }
}

// Subsequence match, scored so that a hit in the filename beats one in the
// path and an earlier, tighter match wins.
function rank(list, query) {
  const needle = query.toLowerCase();
  const scored = [];
  for (const path of list) {
    const score = scoreOf(path.toLowerCase(), needle, path);
    if (score !== null) scored.push({ path, score });
  }
  scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length);
  return scored.map((entry) => entry.path);
}

function scoreOf(haystack, needle, original) {
  let index = 0;
  let first = -1;
  let last = -1;
  for (const char of needle) {
    index = haystack.indexOf(char, index);
    if (index === -1) return null;
    if (first === -1) first = index;
    last = index;
    index += 1;
  }
  const spread = last - first;
  const inName = original.slice(original.lastIndexOf('/') + 1).toLowerCase().includes(needle);
  return spread + first * 0.5 - (inName ? 50 : 0);
}
