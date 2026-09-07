// Checkpoints. One shared list of work, owned by nobody's context window.
//
// Everything before this was private: each hero held its own goal and its own
// self-reported flow, so nobody knew what anyone else was doing and the only
// coordination available was prose. The heroes said so themselves - "the build
// fix is one line in a file Ironman owns, not me" - and there was nowhere to
// put that sentence except a bubble.
//
// A work item is that place. It has an owner, a gate chain that must be walked
// in order, and evidence. Every dispatch carries the checkpoints; every report
// writes to them. The conversation becomes disposable and checkpoints become truth.
//
// Pure. No clock it was not handed, no I/O, no DOM.

import { GATES, GATE_STATE } from './flows.mjs';

// The order work actually passes through. A later gate cannot pass while an
// earlier one has not - that is the whole point of a chain, and it is what
// stops an agent reporting a push before anything was tested.
export const CHAIN = GATES;

export const ITEM_STATE = Object.freeze({
  OPEN: 'open',         // nobody owns it yet
  ASSIGNED: 'assigned', // owned, not started
  WORKING: 'working',   // at least one gate moving
  BLOCKED: 'blocked',   // waiting on another item, or on Mac
  PAUSED: 'paused',     // held by Mac until resumed or force-started
  DONE: 'done',         // every gate passed
  SUPERSEDED: 'superseded',
  CANCELLED: 'cancelled',
});

let seq = 0;

// Ids are short and readable because they are spoken aloud - an agent writes
// "w3" in its report and a person reads "w3" on the floor.
export function nextId(existing = []) {
  const used = new Set(existing.map((item) => item.id));
  do {
    seq += 1;
  } while (used.has(`w${seq}`));
  return `w${seq}`;
}

export function createBoard() {
  return { items: [] };
}

export function createItem({
  id, title, plan = '', outcome = '', verify = '', scope = '', owner = null,
  blockedBy = [], estimateMs = null, needs = null,
}, now = Date.now()) {
  const gates = {};
  // Only the gates this item actually needs. A docs change has no test gate,
  // and inventing one guarantees an item that can never be finished.
  //
  // An EMPTY list is not "no gates" - an item with nothing to pass is finished
  // the moment it is created, which is never what anybody meant. Treat it as
  // unspecified and give it the whole chain.
  const wanted = Array.isArray(needs) && needs.length > 0 ? needs : null;
  for (const gate of CHAIN) {
    if (!wanted || wanted.includes(gate)) gates[gate] = GATE_STATE.PENDING;
  }
  return {
    id,
    title: String(title ?? '').trim(),
    plan: String(plan ?? '').trim(),
    outcome: String(outcome ?? '').trim(),
    verify: String(verify ?? '').trim(),
    scope: String(scope ?? '').trim(),
    owner,
    gates,
    blockedBy: [...blockedBy],
    paused: false,
    lease: null,
    disposition: 'active',
    replacedBy: null,
    evidence: [],
    estimateMs,
    createdAt: now,
    closedAt: null,
  };
}

// ------------------------------------------------------------------- reading

export function itemsOf(board) {
  return board?.items ?? [];
}

export function findItem(board, id) {
  return itemsOf(board).find((item) => item.id === id) ?? null;
}

export function gatesOfItem(item) {
  return Object.keys(item?.gates ?? {});
}

// The first gate that has not passed. null once the item is finished.
export function nextGate(item) {
  for (const gate of CHAIN) {
    const state = item?.gates?.[gate];
    if (state === undefined) continue;
    if (state !== GATE_STATE.PASS) return gate;
  }
  return null;
}

export function isDone(item) {
  return nextGate(item) === null;
}

export function isClosed(item) {
  return isDone(item) || ['superseded', 'cancelled'].includes(item?.disposition);
}

// Which items this one is still waiting on. An id that is not in checkpoints is
// not a dependency - it is a typo, and silently blocking forever on a typo is
// worse than ignoring it.
export function unmetDeps(board, item) {
  return (item?.blockedBy ?? [])
    .map((id) => findItem(board, id))
    .filter((dep) => dep && !isDone(dep))
    .map((dep) => dep.id);
}

export function stateOf(board, item) {
  if (item?.disposition === 'superseded') return ITEM_STATE.SUPERSEDED;
  if (item?.disposition === 'cancelled') return ITEM_STATE.CANCELLED;
  if (isDone(item)) return ITEM_STATE.DONE;
  if (item.paused) return ITEM_STATE.PAUSED;
  if (unmetDeps(board, item).length > 0) return ITEM_STATE.BLOCKED;
  if (!item.owner) return ITEM_STATE.OPEN;
  const moved = Object.values(item.gates ?? {}).some((state) => state !== GATE_STATE.PENDING);
  return moved ? ITEM_STATE.WORKING : ITEM_STATE.ASSIGNED;
}

// Can this agent legitimately work on this item right now?
export function canWork(board, item, agentId) {
  if (!item || isClosed(item)) return false;
  if (item.paused) return false;
  if (item.owner && item.owner !== agentId) return false;
  return unmetDeps(board, item).length === 0;
}

export function itemsFor(board, agentId) {
  return itemsOf(board).filter((item) => item.owner === agentId && !isClosed(item));
}

export function unowned(board) {
  return itemsOf(board).filter((item) => !item.owner && !isClosed(item));
}

// ------------------------------------------------------------------- writing

function replace(board, id, change) {
  return {
    ...board,
    items: itemsOf(board).map((item) => (item.id === id ? { ...item, ...change } : item)),
  };
}

export function addItem(board, spec, now = Date.now()) {
  const title = String(spec?.title ?? '').trim();
  if (!title) return { board, error: 'an item needs a title' };
  // The same open work, twice, is one piece of work. Engines re-send a block
  // and a re-assemble restates the plan; neither should double the checkpoints.
  const twin = itemsOf(board).find(
    (item) => !isClosed(item) && item.title === title && (item.owner ?? null) === (spec.owner ?? null),
  );
  if (twin) {
    const item = {
      ...twin,
      plan: String(spec.plan ?? twin.plan ?? '').trim(),
      outcome: String(spec.outcome ?? twin.outcome ?? '').trim(),
      verify: String(spec.verify ?? twin.verify ?? '').trim(),
      estimateMs: spec.estimateMs ?? twin.estimateMs,
      blockedBy: spec.blockedBy ?? twin.blockedBy,
    };
    return { board: replace(board, twin.id, item), item, duplicate: true };
  }
  const id = spec.id && !findItem(board, spec.id) ? spec.id : nextId(itemsOf(board));
  const item = createItem({ ...spec, id, title }, now);
  return { board: { ...board, items: [...itemsOf(board), item] }, item };
}

export function assign(board, id, owner) {
  const item = findItem(board, id);
  if (!item) return { board, error: `no item ${id}` };
  if (isClosed(item)) return { board, error: `${id} is already closed` };
  return { board: replace(board, id, { owner: owner ?? null }), item: { ...item, owner } };
}

export function compareQueueOrder(a, b) {
  const left = Number.isFinite(a.queueOrder) ? a.queueOrder : Number.MAX_SAFE_INTEGER;
  const right = Number.isFinite(b.queueOrder) ? b.queueOrder : Number.MAX_SAFE_INTEGER;
  return left - right || (a.createdAt ?? 0) - (b.createdAt ?? 0);
}

export function setPaused(board, id, paused) {
  const item = findItem(board, id);
  if (!item) return { board, error: `no item ${id}` };
  if (isClosed(item)) return { board, error: `${id} is already closed` };
  const next = { ...item, paused: Boolean(paused) };
  return { board: replace(board, id, next), item: next };
}

// Queue order is part of the shared checkpoint record. Moving an item swaps it
// with the next unfinished item. Completed work keeps its historical place.
export function moveItem(board, id, direction, fixedIds = []) {
  const items = itemsOf(board);
  const fixed = new Set(fixedIds);
  const open = items
    .filter((item) => !isClosed(item) && !fixed.has(item.id))
    .sort(compareQueueOrder);
  const from = open.findIndex((item) => item.id === id);
  if (from < 0) return { board, error: `no open item ${id}` };
  const to = Math.max(0, Math.min(open.length - 1, from + Math.sign(direction)));
  if (from === to) return { board, items };
  [open[from], open[to]] = [open[to], open[from]];
  const queueOrder = new Map(open.map((item, index) => [item.id, index]));
  const moved = items.map((item) => queueOrder.has(item.id)
    ? { ...item, queueOrder: queueOrder.get(item.id) }
    : item);
  return { board: { ...board, items: moved }, items: moved };
}

// Edit one checkpoint in place. Re-planning must not make a duplicate, and a
// dependency edit must keep gate receipts that still apply.
export function revise(board, id, change = {}) {
  const item = findItem(board, id);
  if (!item) return { board, error: `no item ${id}` };
  if (isClosed(item)) return { board, error: `${id} is already closed` };
  const next = { ...item };
  for (const field of ['title', 'plan', 'outcome', 'verify', 'scope']) {
    if (change[field] !== undefined) next[field] = String(change[field]).trim();
  }
  for (const field of ['owner', 'estimateMs', 'lease']) {
    if (change[field] !== undefined) next[field] = change[field];
  }
  if (change.blockedBy !== undefined) next.blockedBy = [...change.blockedBy];
  if (change.needs !== undefined) {
    const wanted = Array.isArray(change.needs) && change.needs.length > 0
      ? change.needs
      : CHAIN;
    next.gates = Object.fromEntries(wanted.map((gate) => [
      gate,
      item.gates?.[gate] ?? GATE_STATE.PENDING,
    ]));
  }
  return { board: replace(board, id, next), item: next };
}

export function closeItem(board, id, disposition, replacedBy = null, now = Date.now()) {
  const item = findItem(board, id);
  if (!item) return { board, error: `no item ${id}` };
  if (!['superseded', 'cancelled'].includes(disposition)) {
    return { board, error: `unknown checkpoint disposition: ${disposition}` };
  }
  if (disposition === 'superseded' && !findItem(board, replacedBy)) {
    return { board, error: `${id} needs a valid replacement checkpoint` };
  }
  const next = { ...item, disposition, replacedBy, closedAt: now, paused: false, lease: null };
  const items = itemsOf(board).map((candidate) => {
    if (candidate.id === id) return next;
    if (!(candidate.blockedBy ?? []).includes(id)) return candidate;
    const blockedBy = disposition === 'superseded'
      ? [...new Set(candidate.blockedBy.map((dependency) => dependency === id ? replacedBy : dependency))]
      : candidate.blockedBy.filter((dependency) => dependency !== id);
    return { ...candidate, blockedBy };
  });
  return { board: { ...board, items }, item: next };
}

// Move one gate. This is where the chain is ENFORCED: a gate cannot pass while
// an earlier gate on the same item has not, and a pass needs a receipt. That
// single rule is what stops an agent reporting a push over untested code.
export function advance(
  board,
  { id, gate, state, receipt = '', by = null, canManage = false },
  now = Date.now(),
) {
  const item = findItem(board, id);
  if (!item) return { board, error: `no item ${id}` };
  if (isClosed(item)) return { board, error: `${id} is already closed` };
  if (!(gate in (item.gates ?? {}))) return { board, error: `${id} has no ${gate} gate` };
  if (!Object.values(GATE_STATE).includes(state)) return { board, error: `${state} is not a gate state` };
  if (item.owner && by && item.owner !== by && !canManage) {
    return { board, error: `${id} belongs to ${item.owner}` };
  }

  const blocked = unmetDeps(board, item);
  if (blocked.length > 0 && state !== GATE_STATE.FAIL) {
    return { board, error: `${id} is waiting on ${blocked.join(', ')}` };
  }

  if (state === GATE_STATE.PASS) {
    if (!receipt.trim()) return { board, error: `${gate} cannot pass without a receipt` };
    const earlier = CHAIN.slice(0, CHAIN.indexOf(gate))
      .filter((name) => name in item.gates)
      .filter((name) => item.gates[name] !== GATE_STATE.PASS);
    if (earlier.length > 0) {
      return { board, error: `${gate} cannot pass before ${earlier.join(', ')}` };
    }
  }

  const gates = { ...item.gates, [gate]: state };
  const evidence = receipt.trim()
    ? [...item.evidence, { gate, state, receipt: receipt.trim(), by, at: now }]
    : item.evidence;
  const next = { ...item, gates, evidence };
  return {
    board: replace(board, id, { gates, evidence, closedAt: isDone(next) ? now : null }),
    item: next,
  };
}

// ------------------------------------------------------------------ velocity

// Gate-completion rate. This is the only honest measure of speed here: an
// agent can talk for an hour and pass nothing, and this says so.
export function progress(board) {
  let total = 0;
  let passed = 0;
  let failed = 0;
  for (const item of itemsOf(board).filter((candidate) => candidate.disposition !== 'superseded'
    && candidate.disposition !== 'cancelled')) {
    for (const state of Object.values(item.gates ?? {})) {
      total += 1;
      if (state === GATE_STATE.PASS) passed += 1;
      if (state === GATE_STATE.FAIL) failed += 1;
    }
  }
  const items = itemsOf(board);
  return {
    gates: total,
    passed,
    failed,
    percent: total > 0 ? Math.round((passed / total) * 100) : null,
    items: items.filter((item) => item.disposition !== 'superseded'
      && item.disposition !== 'cancelled').length,
    done: items.filter((item) => !['superseded', 'cancelled'].includes(item.disposition)
      && isDone(item)).length,
    unowned: unowned(board).length,
  };
}

// ------------------------------------------------------------- for a prompt

// Checkpoints as an agent should read them: what is mine, what is waiting on me,
// and what everyone else is holding. Short on purpose - it rides on every
// message, so checkpoints that cost a page will not be read twice.
export function boardBrief(board, agentId = null) {
  const items = itemsOf(board).filter((item) => !isClosed(item));
  if (items.length === 0) return null;

  const line = (item) => {
    const gate = nextGate(item);
    const blocked = unmetDeps(board, item);
    const bits = [
      `- ${item.id}  ${item.title}`,
      item.plan ? `      plan: ${item.plan}` : null,
      item.outcome ? `      outcome: ${item.outcome}` : null,
      item.verify ? `      verify: ${item.verify}` : null,
      item.scope ? `      where: ${item.scope}` : null,
      `      owner: ${item.owner ?? 'UNASSIGNED'}`,
      item.paused ? '      paused by Mac' : null,
      item.lease?.workerId ? `      worker: ${item.lease.workerId} [${item.lease.state}]` : null,
      gate ? `      next gate: ${gate}` : '      finished',
      blocked.length ? `      waiting on: ${blocked.join(', ')}` : null,
    ];
    return bits.filter(Boolean).join('\n');
  };

  const mine = agentId ? items.filter((item) => item.owner === agentId && !isDone(item)) : [];
  const rest = items.filter((item) => !mine.includes(item));

  return [
    '# Checkpoints',
    '',
    'This is the shared truth. Read it before you act and report against it.',
    ...(mine.length ? ['', '## Yours', '', ...mine.map(line)] : []),
    ...(rest.length ? ['', '## Everyone else', '', ...rest.map(line)] : []),
    '',
    'Rules:',
    '- Work only on items you own. If something needs doing on an item you do '
    + 'not own, escalate - do not reach into it.',
    '- Gates pass in order and only with the command that proved them.',
    '- An item waiting on another item does not start. Say so and stop.',
  ].join('\n');
}
