// Flow, at the altitude you are standing at.
//
// A step used to be one free-text line with a status. That is fine for one
// agent doing one thing, and useless for off-grid-ai, where a mission spans
// desktop, mobile, shared and console at once and the only question that
// matters is "which repo is the hold-up".
//
// Scope does the grouping work:
//
//   scope  - a path, "off-grid-ai/mobile/release". One field gives every
//            altitude: zoomed out is the first segment, zoomed in is the last.
// Gate state belongs to the shared board in board.mjs. A flow describes the
// user result and its delivery stage; it does not keep a second gate copy.
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
    for (const [index, segment] of path.entries()) {
      cursor.children[segment] ??= node(segment, path.slice(0, index + 1).join('/'));
      cursor = cursor.children[segment];
      addStep(cursor.totals, step);
    }
    cursor.steps.push(step);
  }
  return finish(root);
}

function node(name, path) {
  return { name, path, children: {}, steps: [], totals: blankTotals() };
}

function finish(current) {
  const children = Object.values(current.children).map(finish);
  // A parent's totals already include every descendant, added on the way down.
  return {
    name: current.name,
    path: current.path,
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
