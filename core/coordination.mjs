import { createEvent, EVENT_KINDS } from './events.mjs';

export const ORDER_ACTION = Object.freeze({
  ASSIGN: 'assign',
  START: 'start',
  STEER: 'steer',
  GOAL: 'goal',
});

export const ESCALATION_STATE = Object.freeze({ OPEN: 'open', RESOLVED: 'resolved' });

export function coordinationKey({ action, fromAgentId, toAgentId, checkpointId = '', revision = '' }) {
  return [action, fromAgentId, toAgentId, checkpointId, revision].join(':');
}

export function createOrderEvent({
  fromAgentId, toAgentId, action, text, checkpointId = null, workerId = null,
  revision = '',
}, ts = Date.now()) {
  return createEvent(fromAgentId, EVENT_KINDS.ORDER, {
    toAgentId,
    action,
    text: String(text ?? '').trim(),
    checkpointId,
    workerId,
    key: coordinationKey({ action, fromAgentId, toAgentId, checkpointId, revision }),
  }, ts);
}

export function createEscalationEvent({
  id, fromAgentId, fromWorkerId = null, toAgentId, checkpointId = null,
  needs, why, involvedAgentId = null, receipt = '', state = ESCALATION_STATE.OPEN,
  resolution = null,
}, ts = Date.now()) {
  return createEvent(fromAgentId, EVENT_KINDS.ESCALATION, {
    id,
    fromAgentId,
    fromWorkerId,
    toAgentId,
    checkpointId,
    needs,
    why: String(why ?? '').trim(),
    involvedAgentId,
    receipt: String(receipt ?? '').trim(),
    state,
    resolution,
  }, ts);
}

export function createPeerMessageEvent({
  fromAgentId, fromWorkerId = null, toAgentId, checkpointId = null, text,
}, ts = Date.now()) {
  return createEvent(fromAgentId, EVENT_KINDS.MESSAGE, {
    fromAgentId,
    fromWorkerId,
    toAgentId,
    checkpointId,
    text: String(text ?? '').trim(),
  }, ts);
}

export function createLeaseEvent(agentId, payload, ts = Date.now()) {
  return createEvent(agentId, EVENT_KINDS.LEASE, payload, ts);
}

export function isCrosstalkEvent(event) {
  return Boolean(crosstalkDelivery(event));
}

// Every directed hero-to-hero event has one animation projection. The scene
// does not infer recipients from prose, and operator messages do not pretend
// to be conversations between heroes.
export function crosstalkDelivery(event) {
  const payload = event?.payload ?? {};
  if (event?.kind === EVENT_KINDS.ORDER) {
    return delivery(event.agentId, payload.toAgentId, payload.text);
  }
  if (event?.kind === EVENT_KINDS.ESCALATION && payload.state === ESCALATION_STATE.OPEN) {
    return delivery(payload.fromAgentId ?? event.agentId, payload.toAgentId, payload.why);
  }
  if (event?.kind === EVENT_KINDS.MESSAGE && payload.fromAgentId && payload.toAgentId) {
    return delivery(payload.fromAgentId, payload.toAgentId, payload.text);
  }
  return null;
}

function delivery(fromAgentId, toAgentId, message) {
  if (!fromAgentId || !toAgentId || fromAgentId === toAgentId || !String(message ?? '').trim()) {
    return null;
  }
  return { fromAgentId, toAgentId, message: String(message).trim() };
}

export function isBoardActivityEvent(event) {
  return [EVENT_KINDS.ORDER, EVENT_KINDS.LEASE].includes(event?.kind)
    || (event?.kind === EVENT_KINDS.STATUS && Boolean(event.payload?.checkpointId));
}

export function openEscalations(events = []) {
  const byId = new Map();
  for (const event of events) {
    if (event.kind !== EVENT_KINDS.ESCALATION || !event.payload?.id) continue;
    byId.set(event.payload.id, event.payload);
  }
  return [...byId.values()].filter((item) => item.state === ESCALATION_STATE.OPEN);
}
