// Flow, at the altitude you are standing at.
//
// A step used to be one free-text line with a status. That is fine for one
// agent doing one thing, and useless for off-grid-ai, where a mission spans
// desktop, mobile, shared and console at once and the only question that
// matters is "which repo is the hold-up".
//
// Two ideas do all the work:
//
//   scope  - a path, "off-grid-ai/mobile/release". One field gives every
//            altitude: zoomed out is the first segment, zoomed in is the last.
//   gates  - a FIXED vocabulary, so "test" means the same for every agent in
//            every repo and can be compared at a glance across a row.
//
// Rolling up is then just prefix grouping, and a parent's gate is the worst of
// its children's - one failing test anywhere is a failing test for the group.
//
// Pure. No DOM, no clock it was not handed, no I/O.

// The gates, in the order work actually passes through them. Fixed on purpose:
// a vocabulary each agent invents cannot be compared across repos.
export const GATES = Object.freeze(['coding', 'wiring', 'lint', 'test', 'commits', 'push']);

export const GATE_STATE = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  RUNNING: 'running',
  PENDING: 'pending',
});

// Worst wins. A group with one failure is a failing group, however much else
// passed - the whole point is that a green summary can never hide a red child.
const SEVERITY = Object.freeze({ fail: 0, running: 1, pending: 2, pass: 3 });

export function worstGate(states = []) {
  let worst = null;
  for (const state of states) {
    if (!state) continue;
    if (worst === null || SEVERITY[state] < SEVERITY[worst]) worst = state;
  }
  return worst;
}

// The status ladder still says how far the WORK is; the gates say what has
// been proved. Reading the ladder into the first two gates keeps one source of
// truth: an agent that reports "wired" has said coding and wiring are done.
const LADDER = Object.freeze({
  coded: { coding: GATE_STATE.PASS, wiring: GATE_STATE.RUNNING },
  wired: { coding: GATE_STATE.PASS, wiring: GATE_STATE.PASS },
  verified: { coding: GATE_STATE.PASS, wiring: GATE_STATE.PASS },
});

export function gatesOf(step) {
  const out = {};
  for (const gate of GATES) out[gate] = GATE_STATE.PENDING;
  Object.assign(out, LADDER[step?.status] ?? {});
  // An explicit gate from the agent always outranks what the ladder implied.
  for (const [gate, state] of Object.entries(step?.gates ?? {})) {
    if (GATES.includes(gate) && Object.values(GATE_STATE).includes(state)) out[gate] = state;
  }
  return out;
}

// A step with no scope belongs to the run itself, not to a repo. Naming that
// explicitly beats inventing a repo it was never in.
export const UNSCOPED = 'this run';

export function scopeOf(step) {
  const raw = typeof step?.scope === 'string' ? step.scope.trim() : '';
  return raw ? raw.replace(/^\/+|\/+$/g, '') : UNSCOPED;
}

function blankTotals() {
  return { estimateMs: 0, actualMs: 0, steps: 0, done: 0 };
}

function addStep(totals, step) {
  totals.steps += 1;
  if (step?.status === 'verified') totals.done += 1;
  if (Number.isFinite(step?.estimateMs) && step.estimateMs > 0) {
    totals.estimateMs += step.estimateMs;
    totals.actualMs += step.actualMs ?? 0;
  }
}

function addTotals(into, from) {
  into.estimateMs += from.estimateMs;
  into.actualMs += from.actualMs;
  into.steps += from.steps;
  into.done += from.done;
}

// Build the tree. Every node - group, repo, feature - has the same shape as a
// step row, so one renderer draws all of them.
export function rollup(steps = []) {
  const root = node('', '');
  for (const step of steps) {
    const path = scopeOf(step).split('/').filter(Boolean);
    let cursor = root;
    addStep(cursor.totals, step);
    cursor.gateStates.push(gatesOf(step));
    for (const [index, segment] of path.entries()) {
      cursor.children[segment] ??= node(segment, path.slice(0, index + 1).join('/'));
      cursor = cursor.children[segment];
      addStep(cursor.totals, step);
      cursor.gateStates.push(gatesOf(step));
    }
    cursor.steps.push(step);
  }
  return finish(root);
}

function node(name, path) {
  return { name, path, children: {}, steps: [], gateStates: [], totals: blankTotals() };
}

function finish(current) {
  const gates = {};
  for (const gate of GATES) {
    gates[gate] = worstGate(current.gateStates.map((set) => set[gate])) ?? GATE_STATE.PENDING;
  }
  const children = Object.values(current.children).map(finish);
  // A parent's totals already include every descendant, added on the way down.
  return {
    name: current.name,
    path: current.path,
    gates,
    steps: current.steps,
    children,
    totals: current.totals,
    ratio: current.totals.estimateMs > 0
      ? current.totals.actualMs / current.totals.estimateMs
      : null,
    percentDone: current.totals.steps > 0
      ? Math.round((current.totals.done / current.totals.steps) * 100)
      : null,
  };
}

// What is LEFT. His question is never "how long" alone - it is "how much
// longer, and what is left", so the answer has to carry both.
export function remaining(steps = []) {
  const open = steps.filter((step) => step?.status !== 'verified');
  let estimateMs = 0;
  let actualMs = 0;
  for (const step of open) {
    if (!Number.isFinite(step?.estimateMs) || step.estimateMs <= 0) continue;
    estimateMs += step.estimateMs;
    actualMs += step.actualMs ?? 0;
  }
  return {
    steps: open.length,
    total: steps.length,
    percentDone: steps.length > 0
      ? Math.round(((steps.length - open.length) / steps.length) * 100)
      : null,
    // Time still owed on the steps that are not finished. Never negative: a
    // step already past its estimate owes nothing more that anyone can trust.
    leftMs: Math.max(0, estimateMs - actualMs),
  };
}
