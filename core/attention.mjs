// Attention is the currency. This module holds the two rules that spend it:
// which class of event deserves a sound, and what it costs when the fleet asks
// you something and you do not answer.
//
// Pure: no clock of its own, no DOM, no audio. The room and the speaker both
// ask this module, so a chime and a dimming light always mean the same thing.

import { EVENT_KINDS } from './events.mjs';

// One cue per event CLASS, never per event. Four is the whole vocabulary: any
// more and the floor becomes noise you learn to ignore.
export const CUES = Object.freeze({
  VERIFIED: 'verified', // a step was proved
  BLOCKED: 'blocked',   // an agent stopped
  MESSAGE: 'message',   // something was said
  DECISION: 'decision', // it needs YOU
});

export function cueFor(event) {
  const payload = event?.payload ?? {};
  switch (event?.kind) {
    case EVENT_KINDS.APPROVAL:
      return payload.resolved ? null : CUES.DECISION;
    case EVENT_KINDS.BLOCKED:
      return CUES.BLOCKED;
    case EVENT_KINDS.PING:
      return payload.kind === 'verified' ? CUES.VERIFIED : null;
    case EVENT_KINDS.MESSAGE:
      // Your own steer is not news to you.
      return payload.from === 'you' ? null : CUES.MESSAGE;
    case EVENT_KINDS.RESULT:
      return payload.isError ? CUES.BLOCKED : CUES.VERIFIED;
    default:
      return null;
  }
}

// ---------------------------------------------------------------- neglect

export const NEGLECT = Object.freeze({
  graceMs: 20_000,   // below this, you are simply reading it
  fullMs: 300_000,   // five minutes unanswered is the floor at its dimmest
});

// A decision has no timestamp of its own - it is derived from history, so it
// exists the moment the derivation first says so. Remembering when that was is
// still a rule, so it is a pure reducer over a plain record rather than a
// clock hidden in the view.
export function keyOf(decision) {
  return `${decision.agentId}:${decision.kind}:${decision.approval?.id ?? ''}`;
}

// previous record + what is waiting now -> the record, with anything answered
// forgotten and anything new stamped. Same input, same output.
export function trackWaiting(previous = {}, decisions = [], now = Date.now()) {
  const next = {};
  for (const decision of decisions) {
    const key = keyOf(decision);
    next[key] = previous[key] ?? now;
  }
  return next;
}

// How far the room has been let go, 0 (nothing owed) to 1 (fully neglected).
export function neglect(waiting = {}, now = Date.now(), options = {}) {
  const { graceMs, fullMs } = { ...NEGLECT, ...options };
  const stamps = Object.values(waiting);
  if (stamps.length === 0) return { level: 0, oldestMs: 0, count: 0 };
  const oldestMs = Math.max(...stamps.map((at) => Math.max(0, now - at)));
  const span = Math.max(1, fullMs - graceMs);
  const level = clamp01((oldestMs - graceMs) / span);
  return { level, oldestMs, count: stamps.length };
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}
