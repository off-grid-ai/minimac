import { createEvent, EVENT_KINDS } from './events.mjs';

export const REACTIONS = Object.freeze({
  acknowledge: { symbol: '✅', label: 'acknowledged' },
  watching: { symbol: '👀', label: 'investigating' },
  question: { symbol: '?', label: 'needs clarification' },
  blocked: { symbol: '⛔', label: 'blocked or disagrees' },
});

export function checkpointOf(event) {
  return event?.payload?.checkpointId ?? null;
}

export function messageIdOf(event) {
  if (event?.payload?.messageId) return event.payload.messageId;
  if (!event?.agentId || !Number.isFinite(event?.ts)) return null;
  return `${event.agentId}:${event.ts}:${event.kind}`;
}

export function checkpointMessageExists(events, checkpointId, messageId) {
  return events.some((event) =>
    checkpointOf(event) === checkpointId
    && messageIdOf(event) === messageId
    && event.kind !== EVENT_KINDS.REACTION);
}

export function createCheckpointMessage({
  id, checkpointId, agentId, text = '', from = 'you', attachments = [],
  replyToId = null, references = [], now = Date.now(),
}) {
  return createEvent(agentId, EVENT_KINDS.MESSAGE, {
    messageId: id,
    checkpointId,
    replyToId,
    text: String(text ?? ''),
    from,
    attachments,
    references,
  }, now);
}

export function createReaction({
  id, checkpointId, agentId, messageId, reaction, actorId, active, now = Date.now(),
}) {
  if (!REACTIONS[reaction]) return { error: `unknown reaction: ${reaction}` };
  return {
    event: createEvent(agentId, EVENT_KINDS.REACTION, {
      reactionId: id,
      checkpointId,
      messageId,
      reaction,
      actorId,
      active: active === true,
    }, now),
  };
}

export function checkpointThread(events, checkpointId) {
  const visibleKinds = new Set([
    EVENT_KINDS.MESSAGE,
    EVENT_KINDS.ORDER,
    EVENT_KINDS.ESCALATION,
    EVENT_KINDS.CLAIM,
    EVENT_KINDS.BLOCKED,
    EVENT_KINDS.APPROVAL,
    EVENT_KINDS.PING,
    EVENT_KINDS.REACTION,
  ]);
  const related = events
    .filter((event) => checkpointOf(event) === checkpointId && visibleKinds.has(event.kind))
    .sort((left, right) => left.ts - right.ts);
  const reactions = new Map();
  for (const event of related) {
    if (event.kind !== EVENT_KINDS.REACTION || !event.payload?.messageId) continue;
    const key = `${event.payload.messageId}:${event.payload.reaction}`;
    const actors = reactions.get(key) ?? new Set();
    if (event.payload.active) actors.add(event.payload.actorId);
    else actors.delete(event.payload.actorId);
    reactions.set(key, actors);
  }
  return related
    .filter((event) => event.kind !== EVENT_KINDS.REACTION)
    .map((event) => {
      const messageId = messageIdOf(event);
      const counts = {};
      const actors = {};
      for (const reaction of Object.keys(REACTIONS)) {
        const values = [...(reactions.get(`${messageId}:${reaction}`) ?? [])];
        counts[reaction] = values.length;
        actors[reaction] = values;
      }
      return { ...event, reactions: counts, reactionActors: actors };
    });
}

export function reactionActive(events, checkpointId, messageId, actorId, reaction) {
  let active = false;
  for (const event of events) {
    if (event.kind !== EVENT_KINDS.REACTION || checkpointOf(event) !== checkpointId) continue;
    if (event.payload?.messageId !== messageId || event.payload?.actorId !== actorId) continue;
    if (event.payload?.reaction === reaction) active = event.payload.active === true;
  }
  return active;
}

export function conversationReferences({ checkpointId, parsed, attachments = [] }) {
  return [
    checkpointId ? { kind: 'checkpoint', id: checkpointId } : null,
    ...(parsed?.agents ?? []).map((id) => ({ kind: 'agent', id })),
    ...(parsed?.files ?? []).map((id) => ({ kind: 'file', id })),
    ...(parsed?.skills ?? []).map((id) => ({ kind: 'skill', id })),
    ...attachments.map((file) => ({ kind: 'attachment', id: file.path, label: file.name })),
  ].filter(Boolean);
}
