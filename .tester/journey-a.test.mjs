// Journey A acceptance harness. Read-only over core/errands.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createQueue, enqueue, advance, canWalk, waypointFor, speaker, spoken,
  ERRAND, PHASE_MS,
} from '../core/errands.mjs';
import * as errands from '../core/errands.mjs';

const spots = { thor: { x: 0, z: 0 }, ironman: { x: 4, z: 2 } };
const spotOf = (id) => spots[id] ?? null;
const msg = { eventId: 'event-1', heroId: 'thor', toId: 'ironman', message: 'ship it' };
const T = 1_000_000;
// run the active errand to completion and return the queue at rest
function settle(q, t0) {
  let t = t0, out = q;
  for (const p of [ERRAND.GOING, ERRAND.TALKING, ERRAND.BACK]) {
    t += PHASE_MS[p] + 1;
    out = advance(out, t);
  }
  return { q: out, t };
}

test('A1 sender leaves the chair at once', () => {
  const q = enqueue(createQueue(), msg, T);
  assert.equal(q.active.heroId, 'thor');
  assert.equal(q.active.phase, ERRAND.GOING);
});

test('A2 sender stands beside the desk, never inside it', () => {
  const q = enqueue(createQueue(), msg, T);
  const at = waypointFor(q, 'thor', spotOf);
  assert.ok(Number.isFinite(at.x) && Number.isFinite(at.z), 'waypoint is a real spot');
  assert.notDeepEqual(at, spots.ironman);
  assert.ok(Math.hypot(at.x - spots.ironman.x, at.z - spots.ironman.z) > 0.5);
  assert.equal(speaker(q, null), null, 'silent while crossing');
});

test('A3 exactly one bubble on arrival, naming receiver and message', () => {
  let q = enqueue(createQueue(), msg, T);
  q = advance(q, T + PHASE_MS[ERRAND.GOING]);
  assert.equal(q.active.phase, ERRAND.TALKING);
  assert.equal(speaker(q, null), 'thor');
  assert.deepEqual(spoken(q, null), {
    agentId: 'thor', toId: 'ironman', text: 'ship it', key: 'event-1', queuedAt: T,
  });
  assert.ok(PHASE_MS[ERRAND.TALKING] >= 2000, 'stays long enough to read');
});

test('A4 bubble closes and sender goes home', () => {
  let q = enqueue(createQueue(), msg, T);
  let t = T + PHASE_MS[ERRAND.GOING];
  q = advance(q, t); t += PHASE_MS[ERRAND.TALKING];
  q = advance(q, t);
  assert.equal(q.active.phase, ERRAND.BACK);
  assert.equal(speaker(q, null), null, 'no bubble over an empty chair');
  assert.equal(waypointFor(q, 'thor', spotOf), null, 'heads for own seat');
  const done = advance(q, t + PHASE_MS[ERRAND.BACK]);
  assert.equal(done.active, null);
});

test('A5 a second message waits its turn', () => {
  let q = enqueue(createQueue(), msg, T);
  q = enqueue(q, {
    eventId: 'event-2', heroId: 'ironman', toId: 'thor', message: 'on it',
  }, T + 10);
  assert.equal(q.pending.length, 1);
  assert.equal(q.active.heroId, 'thor', 'only one crosses the floor');
  const s = settle(q, T);
  assert.equal(s.q.active, null, 'one beat of stillness');
  const next = advance(s.q, s.t + 1);
  assert.equal(next.active.heroId, 'ironman');
});

test('A6 same message again mid-walk does nothing', () => {
  let q = enqueue(createQueue(), msg, T);
  const again = enqueue(q, { ...msg }, T + 500);
  assert.equal(again.pending.length, 0);
  assert.equal(again.active.since, q.active.since, 'one walk, not two');
});

test('A7 a new event with the same message replays after the room is still', () => {
  let q = enqueue(createQueue(), msg, T);
  const s = settle(q, T);
  assert.equal(s.q.active, null, 'room is still');
  const replay = enqueue(s.q, { ...msg, eventId: 'event-3' }, s.t + 5000);
  assert.notEqual(replay.active, null, 'a repeated instruction must be seen again');
});

test('A8 pointing at an agent wins over the walking speaker', () => {
  let q = enqueue(createQueue(), msg, T);
  q = advance(q, T + PHASE_MS[ERRAND.GOING]);
  assert.equal(speaker(q, 'ironman'), 'ironman', 'hover wins');
  assert.equal(spoken(q, 'ironman'), null, 'hovered agent shows its own line');
  assert.equal(speaker(q, null), 'thor', 'pointer away restores the speaker');
  assert.equal(q.active.phase, ERRAND.TALKING, 'walk keeps running underneath');
});

test('A9 a stopped agent can be pulled out of the walk', () => {
  let q = enqueue(createQueue(), msg, T);
  q = advance(q, T + PHASE_MS[ERRAND.GOING]);
  const cancel = errands.cancelFor ?? errands.abort ?? errands.dropAgent ?? errands.cancel;
  assert.equal(typeof cancel, 'function', 'no way to stop a walk mid-floor');
  const after = cancel(q, 'thor');
  assert.equal(waypointFor(after, 'thor', spotOf), null, 'returns to its chair');
  assert.equal(speaker(after, null), null, 'bubble closes');
});

test('unactable messages are never queued', () => {
  assert.equal(canWalk({ heroId: 'a', toId: 'a', message: 'x' }), false);
  assert.equal(canWalk({ heroId: 'a', toId: 'b', message: '  ' }), false);
});
