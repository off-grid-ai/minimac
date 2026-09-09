import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStore } from '../adapters/store.mjs';

test('an explicit retry can discard a stale saved worker session', () => {
  const directory = mkdtempSync(join(tmpdir(), 'minimac-store-'));
  try {
    const store = createStore({ file: join(directory, 'test.db') });
    const runId = store.startRun('mission', '/repo');
    store.saveWorkerSession({
      id: 'coder:1', agentId: 'coder', checkpointId: 'w1.cw',
      sessionId: 'old-session', engine: 'codex', state: 'idle', startedAt: 1,
    });
    assert.equal(store.workerSessionsFor(runId).length, 1);
    store.clearWorkerSession('coder:1');
    assert.equal(store.workerSessionsFor(runId).length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
