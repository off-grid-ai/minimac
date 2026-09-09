import { createEvent, EVENT_KINDS } from './events.mjs';

export const CONTEXT_KIND = Object.freeze({
  MISSION: 'mission', CHECKPOINT: 'checkpoint', DECISION: 'decision',
});

export const DELIVERY_STATE = Object.freeze({
  QUEUED: 'queued', DELIVERED: 'delivered', FAILED: 'failed', STALE: 'stale',
});

export const REFERENCE_KIND = Object.freeze({
  HERO: 'hero', CHECKPOINT: 'checkpoint', WORK_UNIT: 'work-unit', DECISION: 'decision',
  FILE: 'file', SKILL: 'skill', MESSAGE: 'message', ATTACHMENT: 'attachment',
});

export const REACTIONS = Object.freeze({
  acknowledge: { symbol: '✅', label: 'acknowledged' },
  watching: { symbol: '👀', label: 'investigating' },
  question: { symbol: '?', label: 'needs clarification' },
  blocked: { symbol: '⛔', label: 'blocked or disagrees' },
});

export function normalizeContext(context, missionId = null) {
  const kind = context?.kind ?? CONTEXT_KIND.MISSION;
  if (!Object.values(CONTEXT_KIND).includes(kind)) return null;
  const id = String(context?.id ?? missionId ?? '').trim();
  return id ? { kind, id } : null;
}

export function referenceKey(reference) {
  return `${reference?.kind ?? ''}:${reference?.id ?? ''}`;
}

export function normalizeReferences(references = []) {
  const values = new Map();
  for (const reference of references) {
    if (!Object.values(REFERENCE_KIND).includes(reference?.kind)
      || !String(reference?.id ?? '').trim()) continue;
    const value = { kind: String(reference.kind), id: String(reference.id) };
    if (reference.label) value.label = String(reference.label);
    values.set(referenceKey(value), value);
  }
  return [...values.values()];
}

export function createMessage({
  id, authorId, context, recipients = [], replyToMessageId = null, body = '',
  attachments = [], references = [], from = 'agent', createdAt = Date.now(),
}) {
  const primary = normalizeContext(context);
  if (!id || !authorId || !primary) return { error: 'a message needs id, author, and context' };
  if (!String(body).trim() && attachments.length === 0) return { error: 'a message needs text or an attachment' };
  const message = {
    id: String(id), authorId: String(authorId), context: primary,
    recipients: [...new Set(recipients.filter(Boolean).map(String))],
    replyToMessageId: replyToMessageId ? String(replyToMessageId) : null,
    body: String(body), attachments: [...attachments], references: normalizeReferences([
      ...references,
      replyToMessageId ? { kind: REFERENCE_KIND.MESSAGE, id: String(replyToMessageId) } : null,
    ].filter(Boolean)),
    from, createdAt,
  };
  return { message, event: createEvent(message.authorId, EVENT_KINDS.CONVERSATION_MESSAGE, { message }, createdAt) };
}

export function createReaction({ id, authorId, context, messageId, reaction, active = true, createdAt = Date.now() }) {
  if (!REACTIONS[reaction]) return { error: `unknown reaction: ${reaction}` };
  const primary = normalizeContext(context);
  if (!id || !authorId || !primary || !messageId) return { error: 'a reaction needs message context' };
  return { event: createEvent(authorId, EVENT_KINDS.REACTION, {
    id: String(id), context: primary, messageId: String(messageId), reaction, active: active === true,
  }, createdAt) };
}

export function createDelivery({ id, authorId, messageId, recipientId, state, error = null, createdAt = Date.now() }) {
  if (!Object.values(DELIVERY_STATE).includes(state)) return { error: `unknown delivery state: ${state}` };
  return { event: createEvent(authorId, EVENT_KINDS.DELIVERY, { id, messageId, recipientId, state, error }, createdAt) };
}

export function messageContext(event) { return event?.payload?.message?.context ?? null; }

export function applyConversationEvent(projection = {}, event) {
  const next = {
    messages: [...(projection.messages ?? [])],
    reactions: { ...(projection.reactions ?? {}) },
    delivery: { ...(projection.delivery ?? {}) },
  };
  if (event?.kind === EVENT_KINDS.CONVERSATION_MESSAGE && event.payload?.message
    && !next.messages.some((message) => message.id === event.payload.message.id)) {
    next.messages.push(event.payload.message);
  }
  if (event?.kind === EVENT_KINDS.REACTION) {
    const payload = event.payload ?? {};
    next.reactions[payload.messageId] = { ...(next.reactions[payload.messageId] ?? {}) };
    next.reactions[payload.messageId][payload.reaction] = {
      ...(next.reactions[payload.messageId][payload.reaction] ?? {}),
      [event.agentId]: payload.active === true,
    };
  }
  if (event?.kind === EVENT_KINDS.DELIVERY) {
    const payload = event.payload ?? {};
    next.delivery[`${payload.messageId}:${payload.recipientId}`] = payload;
  }
  return next;
}

export function conversationOf(events = []) {
  const projection = events.reduce(applyConversationEvent, { messages: [], reactions: {}, delivery: {} });
  const deliveries = Object.values(projection.delivery);
  return {
    ...projection,
    messages: projection.messages.map((message) => ({
      ...message,
      deliveries: deliveries.filter((delivery) => delivery.messageId === message.id),
    })),
  };
}

export function messagesForContext(events, context) {
  const primary = normalizeContext(context);
  if (!primary) return [];
  return conversationOf(events).messages
    .filter((message) => referenceKey(message.context) === referenceKey(primary))
    .sort((left, right) => left.createdAt - right.createdAt);
}

export function messagesForThread(events, context, rootMessageId) {
  const messages = messagesForContext(events, context);
  const included = new Set([String(rootMessageId)]);
  for (const message of messages) {
    if (included.has(message.replyToMessageId)) included.add(message.id);
  }
  return messages.filter((message) => included.has(message.id));
}

export function messagesForHero(events, heroId) {
  return conversationOf(events).messages.filter((message) =>
    message.authorId === heroId || message.recipients.includes(heroId)
    || message.references.some((reference) => reference.kind === REFERENCE_KIND.HERO && reference.id === heroId));
}

export function reactionsForMessage(events, messageId) {
  const active = conversationOf(events).reactions[messageId] ?? {};
  return Object.fromEntries(Object.keys(REACTIONS).map((reaction) => [reaction,
    Object.entries(active[reaction] ?? {}).filter(([, value]) => value).map(([actor]) => actor)]));
}

export function messageExists(events, context, messageId) {
  return messagesForContext(events, context).some((message) => message.id === messageId);
}

export function reactionActive(events, messageId, actorId, reaction) {
  return reactionsForMessage(events, messageId)[reaction]?.includes(actorId) ?? false;
}

export function threadSummary(events, context) {
  const messages = messagesForContext(events, context);
  return {
    count: messages.length,
    replyCount: messages.filter((message) => message.replyToMessageId).length,
    participants: [...new Set(messages.flatMap((message) => [message.authorId, ...message.recipients]))],
    latestAt: messages.at(-1)?.createdAt ?? null,
  };
}

export function conversationReferences({ context, parsed, attachments = [], skills = [] }) {
  return normalizeReferences([
    ...(parsed?.references ?? []).filter((reference) => reference.kind !== 'skill'),
    ...skills.map((skill) => ({ kind: 'skill', id: skill.id, label: skill.label })),
    ...attachments.map((file) => ({ kind: 'attachment', id: file.path, label: file.name })),
  ].filter(Boolean));
}

export function messageContent(message) {
  const references = (message.references ?? [])
    .filter((reference) => reference.kind !== REFERENCE_KIND.ATTACHMENT)
    .map((reference) => `- ${reference.kind}:${reference.id}`);
  const attachments = (message.attachments ?? [])
    .map((file) => `- ${file.path} (${file.type ?? 'file'}, ${file.name ?? 'attachment'})`);
  return [
    String(message.body ?? '').trim(),
    references.length ? `References:\n${references.join('\n')}` : null,
    attachments.length ? `Attachments:\n${attachments.join('\n')}` : null,
  ].filter(Boolean).join('\n\n');
}
