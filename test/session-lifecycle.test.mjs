import test from 'node:test';
import assert from 'node:assert/strict';

import { isCurrentSessionEvent } from '../core/session-lifecycle.mjs';

test('a late event from an old launch is rejected', () => {
  const worker = {
    sessionId: null, resumeSessionId: null, engine: 'codex', launchId: 'new-launch',
  };
  assert.equal(isCurrentSessionEvent(worker, {
    sessionId: 'old-session', engine: 'codex', launchId: 'old-launch',
  }), false);
  assert.equal(isCurrentSessionEvent(worker, {
    sessionId: 'new-session', engine: 'codex', launchId: 'new-launch',
  }), true);
});
