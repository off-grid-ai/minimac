// The walkover queue.
//
// When Thor gives somebody their orders, he gets up and walks over and says it.
// One errand at a time, however many are waiting - a room where four heroes
// cross the floor at once is a screensaver, not information. Waiting orders
// queue, and the room works through them in the order they were given.
//
// An errand is one event: who walks, where to, and what they say.
//
// Pure. It is handed a clock and returns the next state; it never reads one,
// never touches the DOM, and never knows what a three.js scene is.

export const ERRAND = Object.freeze({
  GOING: 'going',     // out of the chair, crossing the floor
  TALKING: 'talking', // standing at the desk, saying it
  BACK: 'back',       // returning to their own seat
});

// Long enough to read the bubble, short enough that a queue of six does not
// become a coffee break.
export const PHASE_MS = Object.freeze({
  [ERRAND.GOING]: 2200,
  [ERRAND.TALKING]: 2600,
  [ERRAND.BACK]: 1800,
});

const ORDER = [ERRAND.GOING, ERRAND.TALKING, ERRAND.BACK];

export function createQueue() {
  return { active: null, pending: [], seen: [] };
}

// An errand nobody can act out is not queued: a hero cannot walk to themselves,
// and a message with nothing in it has nothing to say.
export function canWalk(errand) {
  return Boolean(
    errand?.eventId && errand?.heroId && errand?.toId
      && errand.heroId !== errand.toId && errand.message?.trim(),
  );
}

export function enqueue(queue, errand, now = Date.now()) {
  if (!canWalk(errand)) return queue;
  // One durable event produces one walk, even when live delivery repeats it.
  // A later event with the same words remains a different walk.
  const key = String(errand.eventId);
  if (queue.seen.includes(key)) return queue;

  const item = { ...errand, key, queuedAt: now };
  const seen = [...queue.seen, key].slice(-40); // remember recent orders only
  if (!queue.active) {
    return { ...queue, seen, active: { ...item, phase: ERRAND.GOING, since: now } };
  }
  return { ...queue, seen, pending: [...queue.pending, item] };
}

// Taking a hero off duty cancels every walk they would carry. The next queued
// hero starts on a later tick, after the cancelled hero is back at their seat.
export function cancelFor(queue, heroId) {
  const active = queue.active?.heroId === heroId ? null : queue.active;
  const pending = queue.pending.filter((item) => item.heroId !== heroId);
  if (active === queue.active && pending.length === queue.pending.length) return queue;

  const retainedKeys = new Set([
    ...(active ? [active.key] : []),
    ...pending.map((item) => item.key),
  ]);
  return {
    ...queue,
    active,
    pending,
    seen: queue.seen.filter((key) => retainedKeys.has(key)),
  };
}

// Move the clock forward. Returns the same object when nothing changed, so a
// caller can cheaply tell whether the room needs redrawing.
export function advance(queue, now = Date.now()) {
  if (!queue.active) {
    if (queue.pending.length === 0) return queue;
    const [next, ...rest] = queue.pending;
    return { ...queue, active: { ...next, phase: ERRAND.GOING, since: now }, pending: rest };
  }

  const { phase, since } = queue.active;
  if (now - since < PHASE_MS[phase]) return queue;

  const nextPhase = ORDER[ORDER.indexOf(phase) + 1];
  if (nextPhase) {
    return { ...queue, active: { ...queue.active, phase: nextPhase, since: now } };
  }
  // Home again. The next errand starts on the following tick, so there is
  // always one beat of stillness between two walks.
  return {
    ...queue,
    active: null,
  };
}

// Everything waiting, for the caller that wants to show a backlog.
export function depth(queue) {
  return queue.pending.length + (queue.active ? 1 : 0);
}

// Where this agent should be standing right now, in world terms, or null when
// they belong in their own chair. `spotOf` is handed in so this stays pure.
export function waypointFor(queue, agentId, spotOf) {
  const active = queue.active;
  if (!active || active.heroId !== agentId) return null;
  if (active.phase === ERRAND.BACK) return null; // walking home is just going to their seat
  const target = spotOf(active.toId);
  if (!target) return null;
  // Stand beside the desk, not inside it.
  return { x: target.x + 0.85, z: target.z + 0.35 };
}

// Whose bubble the room should show. Exactly one, and hover always wins: if you
// point at somebody, that is who you are asking about, walk or no walk.
export function speaker(queue, hoveredId = null) {
  if (hoveredId) return hoveredId;
  const active = queue.active;
  if (!active) return null;
  // Only while they are actually saying it. A hero crossing the floor in
  // silence, then speaking on arrival, reads as delivery rather than noise.
  return active.phase === ERRAND.TALKING ? active.heroId : null;
}

// What that bubble says.
export function spoken(queue, hoveredId = null) {
  if (hoveredId) return null; // a hovered agent shows its own latest line
  const active = queue.active;
  if (!active || active.phase !== ERRAND.TALKING) return null;
  return {
    agentId: active.heroId,
    toId: active.toId,
    text: active.message,
    key: active.key,
    queuedAt: active.queuedAt,
  };
}
