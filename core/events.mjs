// The one shared event shape. Every adapter normalizes into this and nothing
// above the port ever sees an engine-specific message.

export const EVENT_KINDS = Object.freeze({
  STATUS: 'status',     // lifecycle: started, thinking, finished
  PLAN: 'plan',         // the agent's declared flow steps
  TOOL: 'tool',         // a tool call: read, edit, run
  DIFF: 'diff',         // lines changed so far
  MESSAGE: 'message',   // assistant prose
  CLAIM: 'claim',       // a factual assertion, with or without a receipt
  PING: 'ping',         // bounded inter-agent signal
  BLOCKED: 'blocked',   // needs a human or another agent
  RESULT: 'result',     // final schema-validated report
  APPROVAL: 'approval', // permission request awaiting a decision
  PRAYER: 'prayer',     // the agent asking for the room's attention itself
  ORDER: 'order',       // Thor assigning or steering one Avenger
  ESCALATION: 'escalation', // one structured worker request to Thor
  LEASE: 'lease',       // warning, extension or expiry for one work unit
  FLOW: 'flow',         // the mission-owned user flow contract changed
});

export const CLAIM_GRADES = Object.freeze({
  OBSERVED: 'observed', // a command produced it
  DERIVED: 'derived',   // computed from observed values
  GUESSED: 'guessed',   // neither
});

export const PING_KINDS = Object.freeze({
  CLAIMING: 'claiming',
  RELEASED: 'released',
  BLOCKED_ON: 'blocked-on',
  VERIFIED: 'verified',
  BROKE: 'broke',
});

export function createEvent(agentId, kind, payload = {}, ts = Date.now()) {
  return { agentId, ts, kind, payload };
}

export function isEvent(value) {
  return (
    !!value &&
    typeof value.agentId === 'string' &&
    typeof value.ts === 'number' &&
    Object.values(EVENT_KINDS).includes(value.kind)
  );
}

// Events are kept in a bounded ring so a long run cannot grow without limit.
export function appendEvent(events, event, cap = 5000) {
  const next = events.length >= cap ? events.slice(events.length - cap + 1) : events.slice();
  next.push(event);
  return next;
}

export function eventsFor(events, agentId) {
  return events.filter((e) => e.agentId === agentId);
}

// ------------------------------------------------------- blocked & approval
//
// Every engine has its own word for "I cannot go on without you": Codex sends
// a JSON-RPC request it will not answer itself, Claude fails the tool call and
// lists the denial in its result. Both land here, in one shape, so the floor
// shows one kind of card and the decision queue has one thing to render.

export const APPROVAL_KINDS = Object.freeze({
  COMMAND: 'command',       // run this shell command
  FILE_CHANGE: 'fileChange',// write these files
  PERMISSION: 'permission', // widen the sandbox
  TOOL: 'tool',             // an external tool wants an answer
  QUESTION: 'question',     // the agent is asking you something
});

export const BLOCKED_REASONS = Object.freeze({
  APPROVAL: 'approval',   // waiting on a permission decision
  INPUT: 'input',         // waiting on an answer
  ERROR: 'error',         // the engine stopped and cannot continue
  DEPENDENCY: 'dependency', // waiting on another agent's claim or artifact
});

// One approval, whatever asked for it. `id` is the token the adapter needs to
// answer; `decisions` is what the human may choose.
export function createApprovalEvent(agentId, approval, ts = Date.now()) {
  return createEvent(
    agentId,
    EVENT_KINDS.APPROVAL,
    {
      id: approval.id ?? null,
      approvalKind: approval.approvalKind ?? APPROVAL_KINDS.COMMAND,
      summary: approval.summary ?? '',
      detail: approval.detail ?? '',
      cwd: approval.cwd ?? null,
      paths: approval.paths ?? [],
      decisions: (approval.decisions ?? ['accept', 'decline']).map(asDecision),
      engine: approval.engine ?? null,
    },
    ts,
  );
}

// `reason` is the sentence a human reads on the decision card; `category` is
// the machine's word for it. Keeping both means the queue stays readable and
// the taxonomy stays exact - one field could not be honest about both.
// A decision is two things at once: the exact value the engine must receive
// back, and a word a human can press. Codex offers both plain strings and
// whole objects (an execpolicy amendment is a decision), so a bare string list
// could not carry them. One list of pairs carries both without the UI ever
// having to understand what an execpolicy amendment is.
export function asDecision(decision) {
  if (decision && typeof decision === 'object' && 'value' in decision) return decision;
  const value = decision;
  return { value, label: decisionLabel(value) };
}

const DECISION_LABELS = Object.freeze({
  accept: 'approve',
  acceptForSession: 'approve for this session',
  decline: 'decline',
  cancel: 'cancel the turn',
});

function decisionLabel(value) {
  if (typeof value === 'string') return DECISION_LABELS[value] ?? value;
  const key = Object.keys(value ?? {})[0] ?? 'decide';
  return DECISION_LABELS[key] ?? humanise(key);
}

function humanise(key) {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
}

export function createBlockedEvent(agentId, blocked, ts = Date.now()) {
  return createEvent(
    agentId,
    EVENT_KINDS.BLOCKED,
    {
      category: blocked.category ?? BLOCKED_REASONS.INPUT,
      reason: blocked.reason ?? 'waiting on you',
      approvalId: blocked.approvalId ?? null,
      sessionId: blocked.sessionId ?? null,
      workerId: blocked.workerId ?? null,
      since: ts,
    },
    ts,
  );
}

// An approval that has been answered. It is an APPROVAL event, not a STATUS,
// because the card the floor put up IS an approval - the same kind, the same
// `id`, now carrying the decision. A queue keyed on approvalId can clear it
// without knowing anything new, and a replayed run shows the decision next to
// the request that earned it. A STATUS would have hidden it in a payload that
// already means five other things.
export function createApprovalResolvedEvent(agentId, resolution, ts = Date.now()) {
  return createEvent(
    agentId,
    EVENT_KINDS.APPROVAL,
    {
      id: resolution.id ?? null,
      resolved: true,
      decision: resolution.decision ?? 'accept',
      by: resolution.by ?? 'you', // 'you' pressed a button, 'steer' typed prose
      summary: resolution.summary ?? '',
      engine: resolution.engine ?? null,
    },
    ts,
  );
}

// A steer is the human's answer. This is the one place that reads intent out of
// free text, so every adapter decides the same way.
const DENY = /\b(no|deny|denied|decline|reject|don'?t|do not|stop|cancel|abort|refuse)\b/i;

export function decisionFromText(text) {
  if (typeof text !== 'string' || text.trim() === '') return 'accept';
  return DENY.test(text) ? 'decline' : 'accept';
}
