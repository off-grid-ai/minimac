import {
  DELIVERY_STATE, conversationReferences, createDelivery, createMessage, createReaction,
  messageExists, normalizeContext, reactionActive,
} from '../core/conversation.mjs';

export function createConversationService({
  getEvents, emit, id, missionId, resolveMentions, resolveSkills, validateContext, validateRecipient, deliver,
}) {
  async function post({
    authorId, context, recipients = [], body = '', attachments = [], references = [],
    replyToMessageId = null, from = 'agent', wake = false,
  }) {
    const primary = normalizeContext(context, missionId());
    if (!primary) throw new Error('message context does not exist');
    if (validateContext && !validateContext(primary)) throw new Error(`${primary.kind} ${primary.id} does not exist`);
    for (const recipientId of recipients) {
      if (validateRecipient && !validateRecipient(recipientId)) throw new Error(`recipient ${recipientId} does not exist`);
    }
    if (replyToMessageId && !messageExists(getEvents(), primary, replyToMessageId)) {
      throw new Error(`no message ${replyToMessageId} in this conversation`);
    }
    const parsed = await resolveMentions(body);
    const skills = await resolveSkills((parsed.references ?? [])
      .filter((reference) => reference.kind === 'skill').map((reference) => reference.id));
    const result = createMessage({
      id: id(), authorId, context: primary, recipients, replyToMessageId, body, attachments, from,
      references: [...references, ...conversationReferences({ context: primary, parsed, attachments, skills })],
    });
    if (result.error) throw new Error(result.error);
    emit(result.event);
    const deliveries = [];
    for (const recipientId of result.message.recipients) deliveries.push(await send(result.message, recipientId, wake));
    return { ...result.message, deliveries };
  }

  async function send(message, recipientId, wake) {
    const deliveryId = id();
    const delivery = (state, error = null) => emit(createDelivery({
      id: deliveryId, authorId: message.authorId, messageId: message.id, recipientId, state, error,
    }).event);
    delivery(DELIVERY_STATE.QUEUED);
    try {
      await deliver(recipientId, conversationPrompt(message), { wake });
      delivery(DELIVERY_STATE.DELIVERED);
      return { id: deliveryId, recipientId, state: DELIVERY_STATE.DELIVERED, error: null };
    } catch (error) {
      delivery(DELIVERY_STATE.FAILED, error.message);
      return { id: deliveryId, recipientId, state: DELIVERY_STATE.FAILED, error: error.message };
    }
  }

  function react({ authorId, context, messageId, reaction }) {
    const primary = normalizeContext(context, missionId());
    if (!primary || !messageExists(getEvents(), primary, messageId)) throw new Error(`no message ${messageId}`);
    const active = !reactionActive(getEvents(), messageId, authorId, reaction);
    const result = createReaction({ id: id(), authorId, context: primary, messageId, reaction, active });
    if (result.error) throw new Error(result.error);
    emit(result.event);
    return { id: result.event.payload.id, active };
  }

  function acceptAgentOutput(event, context) {
    if (event.payload?.final !== true) return null;
    const result = createMessage({
      id: id(), authorId: event.agentId, context: normalizeContext(context, missionId()),
      recipients: event.payload?.recipients ?? [], body: event.payload?.text ?? '',
      attachments: event.payload?.attachments ?? [], references: event.payload?.references ?? [],
      from: event.payload?.from ?? 'agent', createdAt: event.ts,
    });
    if (result.error) return null;
    emit(result.event);
    return result.message;
  }

  return Object.freeze({ post, reply: post, react, acceptAgentOutput });
}

export function conversationPrompt(message) {
  return [`# Conversation`, `Context: ${message.context.kind}:${message.context.id}`,
    `From: ${message.authorId}`, '', message.body].join('\n');
}
