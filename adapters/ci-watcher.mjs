// Hosted CI is external state, not Avenger work. This watcher observes it
// without taking a worker slot and reports only a changed failing check set.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export function pullRequestNumbers(text) {
  const numbers = new Set();
  const source = String(text ?? '');
  for (const match of source.matchAll(/\b(?:PR|pull request)\s*#?(\d+)\b/gi)) {
    numbers.add(Number(match[1]));
  }
  return [...numbers];
}

export function createCiWatcher({ repo, intervalMs = 30_000, context, onFailures }) {
  let timer = null;
  let busy = false;
  const signatures = new Map();

  async function readChecks(number) {
    try {
      const { stdout } = await execute('gh', [
        'pr', 'checks', String(number), '--json', 'name,state,bucket,link',
      ], { cwd: repo, timeout: 20_000, maxBuffer: 1_000_000 });
      return JSON.parse(stdout || '[]');
    } catch (error) {
      try { return JSON.parse(error?.stdout || '[]'); } catch { return []; }
    }
  }

  async function poll() {
    if (busy) return;
    busy = true;
    try {
      const snapshot = context();
      const text = [snapshot.mission, ...(snapshot.items ?? []).flatMap((item) => [
        item.title, item.outcome, item.scope,
      ])].join('\n');
      for (const number of pullRequestNumbers(text)) {
        const checks = await readChecks(number);
        const failures = checks.filter((check) =>
          check.bucket === 'fail' || ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'].includes(check.state));
        const signature = failures.map((check) => `${check.name}:${check.state}`).sort().join('|');
        const previous = signatures.get(number);
        signatures.set(number, signature);
        if (signature && signature !== previous) await onFailures({ number, failures, initial: previous === undefined });
      }
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (timer) return;
      void poll();
      timer = setInterval(() => void poll(), intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    poll,
  };
}
