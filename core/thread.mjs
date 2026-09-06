// One agent's conversation, as a person reads it: their words, your steers and
// the work they did between them, in the order it happened.
//
// This is a RULE, not a rendering detail - what belongs in a thread and how a
// line is worded is the same answer wherever the thread is shown - so it lives
// here, and it asks core/readable.mjs for every word. Nothing in this file
// knows about the DOM, three.js or the clock.

import { EVENT_KINDS } from './events.mjs';
import { describeEvent, plainText, shortenDetail } from './readable.mjs';

export const TURN = Object.freeze({
  SAID: 'said',       // prose from the agent
  STEER: 'steer',     // prose from you
  WORKED: 'worked',   // a tool call, said in a few words
  CLAIMED: 'claimed', // an assertion, with or without its receipt
  BLOCKED: 'blocked', // it stopped and needs something
  ASKED: 'asked',     // it is parked on a permission question
  DONE: 'done',       // a final report
});

// The turns that carry meaning even when the thread is long. Work lines are
// filler: they say the agent is alive, and they are the first thing dropped.
const SUBSTANTIAL = new Set([TURN.SAID, TURN.STEER, TURN.CLAIMED, TURN.BLOCKED, TURN.ASKED, TURN.DONE]);

const MIN_PROSE = 3; // a one-word "ok" is not a turn worth a bubble

// events -> turns. `limit` caps the thread; work lines give way first, so a
// busy agent's actual sentences are never pushed out by its own shell noise.
export function agentThread(events = [], { limit = 60 } = {}) {
  const turns = [];
  for (const event of events) {
    const turn = turnOf(event);
    if (turn) turns.push(turn);
  }
  if (turns.length <= limit) return turns;

  const keep = new Set();
  // Newest first: take every substantial turn, then backfill with work.
  for (let i = turns.length - 1; i >= 0 && keep.size < limit; i -= 1) {
    if (SUBSTANTIAL.has(turns[i].kind)) keep.add(i);
  }
  for (let i = turns.length - 1; i >= 0 && keep.size < limit; i -= 1) keep.add(i);
  return turns.filter((_, index) => keep.has(index));
}

// The one open question on this thread, or null. The desk needs it to know
// whether to show answer buttons; the queue already renders the same payload.
export function openQuestion(events = []) {
  const resolved = new Set();
  let open = null;
  for (const event of events) {
    if (event.kind !== EVENT_KINDS.APPROVAL) continue;
    if (event.payload?.resolved) resolved.add(event.payload.id);
    else open = event.payload;
  }
  return open && !resolved.has(open.id) ? open : null;
}

function turnOf(event) {
  const payload = event?.payload ?? {};
  const at = event?.ts ?? 0;

  if (event?.kind === EVENT_KINDS.MESSAGE) {
    const body = String(payload.text ?? '');
    if (plainText(body).length < MIN_PROSE) return null;
    return payload.from === 'you'
      ? { at, kind: TURN.STEER, mine: true, text: body, markdown: true }
      : { at, kind: TURN.SAID, mine: false, text: body, markdown: true };
  }

  if (event?.kind === EVENT_KINDS.TOOL) {
    if (payload.phase === 'completed') return null;
    return {
      at,
      kind: TURN.WORKED,
      mine: false,
      text: describeEvent(event),
      full: String(payload.target ?? ''),
    };
  }

  if (event?.kind === EVENT_KINDS.CLAIM) {
    const receipt = payload.receipt ? String(payload.receipt) : '';
    return {
      at,
      kind: TURN.CLAIMED,
      mine: false,
      text: plainText(payload.text),
      note: receipt || 'no command behind this',
      backed: Boolean(receipt),
    };
  }

  if (event?.kind === EVENT_KINDS.BLOCKED) {
    return { at, kind: TURN.BLOCKED, mine: false, text: shortenDetail(payload.reason), full: String(payload.reason ?? '') };
  }

  if (event?.kind === EVENT_KINDS.APPROVAL && !payload.resolved) {
    return { at, kind: TURN.ASKED, mine: false, text: shortenDetail(payload.summary), full: String(payload.detail ?? '') };
  }

  if (event?.kind === EVENT_KINDS.RESULT) {
    const body = String(payload.text ?? payload.summary ?? '');
    if (plainText(body).length < MIN_PROSE) return null;
    return { at, kind: TURN.DONE, mine: false, text: body, markdown: true };
  }

  return null;
}
