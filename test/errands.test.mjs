import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ERRAND,
  advance,
  cancelFor,
  createQueue,
  enqueue,
  speaker,
  spoken,
  waypointFor,
} from '../core/errands.mjs';

const walk = { eventId: 'event-1', heroId: 'coder', toId: 'tester', message: 'Please verify this.' };

for (const phase of Object.values(ERRAND)) {
  test(`stopping a walking agent during ${phase} returns them home without a bubble`, () => {
    const queued = enqueue(createQueue(), walk, 100);
    const inPhase = { ...queued, active: { ...queued.active, phase, since: 100 } };

    const stopped = cancelFor(inPhase, 'coder');

    assert.equal(stopped.active, null);
    assert.equal(waypointFor(stopped, 'coder', () => ({ x: 1, z: 2 })), null);
    assert.equal(speaker(stopped), null);
    assert.equal(spoken(stopped), null);
  });
}

test('stopping an agent removes their waiting walks and preserves queue order', () => {
  let queue = enqueue(createQueue(), walk, 100);
  queue = enqueue(queue, {
    eventId: 'event-2', heroId: 'reviewer', toId: 'tester', message: 'Review this.',
  }, 101);
  queue = enqueue(queue, {
    eventId: 'event-3', heroId: 'coder', toId: 'reviewer', message: 'One more.',
  }, 102);

  const stopped = cancelFor(queue, 'coder');

  assert.equal(stopped.active, null);
  assert.deepEqual(stopped.pending.map((item) => item.heroId), ['reviewer']);
  assert.equal(advance(stopped, 103).active.heroId, 'reviewer');
});

test('stopping an unrelated agent keeps the same queue state', () => {
  const queue = enqueue(createQueue(), walk, 100);
  assert.equal(cancelFor(queue, 'reviewer'), queue);
});
