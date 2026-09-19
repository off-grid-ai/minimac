import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decisionBubbleKey,
  dismiss,
  errandBubbleKey,
  eventBubbleKey,
  isDismissed,
  restoreDismissed,
  serializeDismissed,
} from '../core/bubbles.mjs';

const first = { agentId: 'coder', kind: 'tool', ts: 100, payload: {} };
const second = { agentId: 'tester', kind: 'claim', ts: 101, payload: {} };

test('closing one bubble preserves every other bubble', () => {
  const closed = dismiss(new Set(), [eventBubbleKey(first)]);

  assert.equal(isDismissed(closed, eventBubbleKey(first)), true);
  assert.equal(isDismissed(closed, eventBubbleKey(second)), false);
});

test('a newer line has a new key and remains visible', () => {
  const closed = dismiss(new Set(), [eventBubbleKey(first)]);
  const newer = { ...first, ts: 102 };

  assert.notEqual(eventBubbleKey(newer), eventBubbleKey(first));
  assert.equal(isDismissed(closed, eventBubbleKey(newer)), false);
});

test('closing every visible key closes every bubble', () => {
  const keys = [eventBubbleKey(first), eventBubbleKey(second)];
  const closed = dismiss(new Set(), keys);

  assert.equal(keys.every((key) => isDismissed(closed, key)), true);
});

test('closed bubbles remain closed after stored state is restored', () => {
  const key = eventBubbleKey(first);
  const restored = restoreDismissed(serializeDismissed(dismiss(new Set(), [key])));

  assert.equal(isDismissed(restored, key), true);
});

test('each replayed walk has a separate bubble identity', () => {
  const walk = { key: 'coder->tester:verify', queuedAt: 100 };
  assert.notEqual(errandBubbleKey(walk), errandBubbleKey({ ...walk, queuedAt: 200 }));
});

test('a decision keeps its supplied identity', () => {
  assert.equal(decisionBubbleKey({ key: 'coder:blocked:w2' }), 'decision:coder:blocked:w2');
});

test('invalid stored state fails open', () => {
  assert.deepEqual([...restoreDismissed('{bad')], []);
});
