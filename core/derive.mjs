// Everything neither CLI reports. This is the part that answers "why did ten
// minutes become two hours" - loops, burn against estimate, silence, and
// claims nobody can back up. Pure functions over events; no I/O, no clock of
// their own (every `now` is passed in), so every number here is reproducible
// from a recorded run.

import { EVENT_KINDS, CLAIM_GRADES } from './events.mjs';
import { worstOverrun } from './board.mjs';

export const POSE = Object.freeze({
  TYPING: 'typing',
  THINKING: 'thinking',
  PACING: 'pacing',
  ERRAND: 'errand',   // out of the chair, carrying an order to another desk
  BLOCKED: 'blocked',
  IDLE: 'idle',
});

// Quiet is not one state. An agent waiting on a model or a long command is
// working; an agent whose last unit of work already finished is not.
export const SILENCE = Object.freeze({
  ACTIVE: 'active',
  THINKING: 'thinking',
  HUNG: 'hung',
});

const LOOP_DEFAULTS = Object.freeze({
  threshold: 3,      // repeats before diligence becomes a loop
  windowMs: 300_000, // only the last five minutes can be a live loop
});

const LOOPABLE_ACTIONS = new Set(['read', 'edit', 'run', 'search']);

const SILENCE_DEFAULTS = Object.freeze({
  thinkingMs: 45_000,  // below this, quiet is just the gap between events
  hungMs: 420_000,     // above this, quiet with nothing in flight is hung
  baselineFactor: 6,   // this many times the agent's own p90 gap is abnormal
  minSamples: 5,
});

// ------------------------------------------------------------------- loops

// A loop is the same target, the same action, repeated, WITH NOTHING TO SHOW
// FOR IT. Re-reading a file four times while the diff keeps growing is how
// work looks; re-reading it four times while the diff stands still is a loop.
// Both halves matter - counting repeats alone flags every careful agent.
export function detectLoops(events, options = {}) {
  const { threshold, windowMs } = {
    ...LOOP_DEFAULTS,
    ...(typeof options === 'number' ? { threshold: options } : options),
  };

  const tools = events.filter(isLoopableTool);
  if (tools.length === 0) return [];

  const latestTs = events[events.length - 1]?.ts ?? tools[tools.length - 1].ts;
  const since = latestTs - windowMs;
  const diffTimeline = diffPoints(events);
  const progressTimeline = progressPoints(events);

  const groups = new Map();
  for (const event of tools) {
    if (event.ts < since) continue;
    const key = loopKey(event);
    const entry = groups.get(key) ?? {
      action: event.payload.action,
      target: event.payload.target,
      occurrences: [],
    };
    entry.occurrences.push(event.ts);
    groups.set(key, entry);
  }

  const loops = [];
  for (const entry of groups.values()) {
    const run = unproductiveRun(entry.occurrences, diffTimeline, progressTimeline);
    if (run.count < threshold) continue;
    loops.push({
      action: entry.action,
      target: entry.target,
      count: run.count,
      totalCount: entry.occurrences.length,
      firstTs: run.firstTs,
      lastTs: run.lastTs,
      windowMs: run.lastTs - run.firstTs,
      diffLinesGained: run.diffGained,
      confidence: confidenceOf(run.count, threshold),
    });
  }

  return loops.sort((a, b) => b.count - a.count || b.windowMs - a.windowMs);
}

// The longest trailing streak of repeats with no diff growth and no verified
// step between them. Anchoring on the trailing end means a loop the agent has
// already broken out of stops being reported.
function unproductiveRun(occurrences, diffTimeline, progressTimeline) {
  let start = occurrences.length - 1;
  for (let i = occurrences.length - 1; i > 0; i -= 1) {
    const from = occurrences[i - 1];
    const to = occurrences[i];
    if (valueAt(diffTimeline, to) > valueAt(diffTimeline, from)) break;
    if (countBetween(progressTimeline, from, to) > 0) break;
    start = i - 1;
  }
  const firstTs = occurrences[start];
  const lastTs = occurrences[occurrences.length - 1];
  return {
    count: occurrences.length - start,
    firstTs,
    lastTs,
    diffGained: valueAt(diffTimeline, lastTs) - valueAt(diffTimeline, firstTs),
  };
}

function confidenceOf(count, threshold) {
  return Math.min(1, count / (threshold * 2));
}

// Completion events describe an outcome, not an attempt; counting them would
// double every tool call and halve the threshold.
function isLoopableTool(event) {
  const target = String(event.payload?.target ?? '');
  return (
    event.kind === EVENT_KINDS.TOOL &&
    event.payload?.phase !== 'completed' &&
    LOOPABLE_ACTIONS.has(event.payload?.action) &&
    !!target &&
    // Claude records its tool picker as `select:<tool names>`. Old runs can
    // contain these as searches, so exclude them here as well as fixing the
    // adapter. Tool discovery cannot prove that repository work is looping.
    !target.startsWith('select:')
  );
}

function loopKey(event) {
  return `${event.payload.action}:${event.payload.target}`;
}

function diffPoints(events) {
  return events
    .filter((event) => event.kind === EVENT_KINDS.DIFF && Number.isFinite(event.payload?.lines))
    .map((event) => ({ ts: event.ts, value: event.payload.lines }));
}

// Anything that counts as ground gained other than a bigger diff. Checkpoint
// gate transitions are the canonical progress record.
function progressPoints(events) {
  return events
    .filter((event) => (
      event.kind === EVENT_KINDS.PING && event.payload?.kind === 'verified'
    ) || (
      event.kind === EVENT_KINDS.STATUS
      && event.payload?.checkpointId
      && event.payload?.gateState === 'pass'
    ))
    .map((event) => event.ts);
}

function valueAt(points, ts) {
  let value = 0;
  for (const point of points) {
    if (point.ts > ts) break;
    value = point.value;
  }
  return value;
}

function countBetween(timestamps, from, to) {
  return timestamps.filter((ts) => ts > from && ts <= to).length;
}

// The Flow panel receives checkpoint projections, so this ratio grades the
// canonical checkpoint estimate against its lease-derived elapsed time.
export function burnRatio(step) {
  if (!step?.estimateMs || step.estimateMs <= 0) return null;
  return (step.actualMs ?? 0) / step.estimateMs;
}

// ----------------------------------------------------------------- silence

export function staleness(agent, now = Date.now()) {
  if (!agent?.lastEventTs) return null;
  return now - agent.lastEventTs;
}

export function eventsPerMin(events, now = Date.now(), windowMs = 60_000) {
  const since = now - windowMs;
  const recent = events.filter((event) => event.ts >= since).length;
  return (recent * 60_000) / windowMs;
}

// Thinking and hung look identical from outside: no output. They are told
// apart by two measured things - whether a unit of work is still open, and how
// this agent's own rhythm compares to the gap it is in now. Quiet with no open
// work is idle, not a request for the operator to make a decision.
export function silence(agent, events, now = Date.now(), options = {}) {
  const { thinkingMs, hungMs, baselineFactor, minSamples } = { ...SILENCE_DEFAULTS, ...options };
  const lastTs = events[events.length - 1]?.ts ?? agent?.lastEventTs ?? null;

  if (lastTs === null) {
    return { state: SILENCE.ACTIVE, quietMs: null, baselineMs: null, inFlight: false, openWork: null };
  }

  const quietMs = Math.max(0, now - lastTs);
  const baselineMs = percentileGap(events, 0.9, minSamples);
  const open = openWorkAt(events);
  const abnormal = baselineMs === null ? quietMs > thinkingMs : quietMs > baselineMs * baselineFactor;

  const state = pickSilence({ quietMs, abnormal, inFlight: !!open, thinkingMs, hungMs });
  return { state, quietMs, baselineMs, inFlight: !!open, openWork: open };
}

function pickSilence({ quietMs, abnormal, inFlight, thinkingMs, hungMs }) {
  if (quietMs < thinkingMs || !abnormal) return SILENCE.ACTIVE;
  if (inFlight && quietMs < hungMs) return SILENCE.THINKING;
  if (!inFlight && quietMs >= thinkingMs) return SILENCE.HUNG;
  return quietMs >= hungMs ? SILENCE.HUNG : SILENCE.THINKING;
}

// The agent's own rhythm: the p90 gap between its events. Measured, so a
// deliberate engine and a chatty one are judged on their own terms.
function percentileGap(events, percentile, minSamples) {
  const gaps = [];
  for (let i = 1; i < events.length; i += 1) gaps.push(events[i].ts - events[i - 1].ts);
  if (gaps.length < minSamples) return null;
  const sorted = gaps.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(percentile * sorted.length));
  return sorted[index];
}

// A tool call that started and never completed is work in flight. So is a turn
// that has not reported a result. Everything else means the agent had nothing
// left to do, which is what makes quiet suspicious rather than patient.
function openWorkAt(events) {
  const open = new Map();
  for (const event of events) {
    if (event.kind === EVENT_KINDS.TOOL) {
      const key = loopKey(event);
      if (event.payload?.phase === 'completed') open.delete(key);
      else open.set(key, event);
      continue;
    }
    if (event.kind === EVENT_KINDS.RESULT || event.kind === EVENT_KINDS.BLOCKED) open.clear();
  }
  const last = [...open.values()].pop();
  return last ? { action: last.payload.action, target: last.payload.target, since: last.ts } : null;
}

// ------------------------------------------------------------------ claims

// A claim is only as good as the command behind it. No receipt, no grade.
export function gradeClaim(claim) {
  if (claim?.receipt && claim.receipt.trim().length > 0) {
    return claim.derivedFrom?.length ? CLAIM_GRADES.DERIVED : CLAIM_GRADES.OBSERVED;
  }
  return CLAIM_GRADES.GUESSED;
}

export function gradeClaims(claims = []) {
  const graded = claims.map((claim) => ({ ...claim, grade: gradeClaim(claim) }));
  const tally = { observed: 0, derived: 0, guessed: 0 };
  for (const claim of graded) tally[claim.grade] += 1;
  return { graded, tally };
}

// ------------------------------------------------------------------- pose

// Posture carries state, so the room is readable before a word is.
export function agentPose(agent, events, now = Date.now()) {
  if (!agent || agent.status === 'stopped') return POSE.IDLE;
  // Carrying an order outranks everything: it is the one thing in the room the
  // operator asked for directly, and it is over in a few seconds.
  if (agent.errand) return POSE.ERRAND;
  if (agent.status === 'blocked') return POSE.BLOCKED;
  // Only an agent that is actually WORKING can be looping. Reading a loop out
  // of an idle agent's history left the room pacing with a red halo while the
  // decision queue correctly said nothing needed you - the alarm and the card
  // must never disagree, because the alarm is a claim about right now.
  if (agent.status === 'running' && detectLoops(events).length > 0) return POSE.PACING;

  const quiet = silence(agent, events, now);
  if (quiet.state === SILENCE.HUNG) return POSE.IDLE;
  if (quiet.state === SILENCE.THINKING) return POSE.THINKING;
  return POSE.TYPING;
}

// One place that decides what deserves your attention, so the queue stays
// short and every card is actionable.
export function pendingDecisions(agent, events, now = Date.now(), board = null) {
  const decisions = [];
  // A stopped agent needs no decision. Loops, overruns and silence are read
  // from history, so without this a card outlives the thing it described and
  // the queue fills with work that is already over.
  if (agent.status === 'stopped' || agent.status === 'idle') return decisions;
  const loops = detectLoops(events);
  if (loops.length > 0) {
    const worst = loops[0];
    decisions.push({
      agentId: agent.id,
      kind: 'loop',
      detail: `${worst.action} ${worst.target} x${worst.count} over ${seconds(worst.windowMs)}s, diff flat`,
      actions: ['steer', 'split', 'kill'],
    });
  }

  const overrun = worstOverrun(board, agent.id, now);
  if (overrun) {
    decisions.push({
      agentId: agent.id,
      checkpointId: overrun.checkpointId,
      kind: 'overrun',
      detail: `${overrun.checkpointId} · ${overrun.title} at ${overrun.burnRatio.toFixed(1)}x estimate (${seconds(overrun.actualMs)}s of ${seconds(overrun.estimateMs)}s, active lease)`,
      actions: ['steer', 'split', 'kill'],
    });
  }

  if (agent.status === 'blocked') {
    // A blocked agent has no live turn, so steering it is prose into a void.
    // RETRY is the action that can actually clear this: it dispatches the
    // agent again, which re-opens the engine connection that failed.
    decisions.push({
      agentId: agent.id,
      kind: 'blocked',
      detail: agent.blockedReason ?? 'waiting on you',
      actions: ['retry', 'steer', 'kill'],
    });
  }

  const quiet = silence(agent, events, now);
  if (quiet.state === SILENCE.HUNG && quiet.inFlight && agent.status === 'running') {
    decisions.push({
      agentId: agent.id,
      kind: 'silent',
      detail: `no output for ${seconds(quiet.quietMs)}s while ${quiet.openWork.action} ${quiet.openWork.target ?? ''} is still open${
        quiet.baselineMs === null ? '' : ` (usual gap ${seconds(quiet.baselineMs)}s)`
      }`,
      actions: ['steer', 'kill'],
    });
  }

  return decisions;
}

function seconds(ms) {
  return Math.round((ms ?? 0) / 1000);
}
