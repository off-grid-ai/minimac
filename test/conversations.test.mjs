import test from 'node:test';
import assert from 'node:assert/strict';

import { createConversationService } from '../application/conversations.mjs';
import { conversationOf, createDelivery, DELIVERY_STATE } from '../core/conversation.mjs';
import { createEvent, EVENT_KINDS } from '../core/events.mjs';

test('a hero mention becomes a recipient and wakes that hero', async () => {
  const events = [];
  const deliveries = [];
  const service = createConversationService({
    getEvents: () => events,
    emit: (event) => events.push(event),
    id: (() => { let id = 0; return () => `id-${++id}`; })(),
    missionId: () => '110',
    resolveMentions: async () => ({ references: [{ kind: 'hero', id: 'minimac' }] }),
    resolveSkills: async () => [],
    resolveRecipients: ({ recipients }) => recipients,
    validateRecipient: (id) => id === 'minimac',
    deliver: async (recipientId, prompt, options) => deliveries.push({ recipientId, prompt, options }),
  });

  const message = await service.post({
    authorId: 'you',
    context: { kind: 'mission', id: '110' },
    body: '@thor please wake up',
    wake: true,
    from: 'you',
  });

  assert.deepEqual(message.recipients, ['minimac']);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].recipientId, 'minimac');
  assert.equal(deliveries[0].options.wake, true);

  service.acceptAgentOutput(createEvent('minimac', EVENT_KINDS.ENGINE_OUTPUT, {
    text: 'I am awake.', final: true, replyToMessageId: message.id,
  }, 100), { kind: 'mission', id: '110' });
  assert.equal(
    conversationOf(events).delivery[`${message.id}:minimac`].state,
    DELIVERY_STATE.READ,
  );
});

test('an explicit recipient and a mentioned hero are both kept once', async () => {
  const events = [];
  const service = createConversationService({
    getEvents: () => events,
    emit: (event) => events.push(event),
    id: () => 'message-1',
    missionId: () => '110',
    resolveMentions: async () => ({ references: [{ kind: 'hero', id: 'minimac' }] }),
    resolveSkills: async () => [],
    resolveRecipients: ({ recipients }) => recipients,
    deliver: async () => {},
  });

  const message = await service.post({
    authorId: 'you', context: { kind: 'mission', id: '110' },
    recipients: ['coder', 'minimac'], body: '@thor review this', wake: true,
  });
  assert.deepEqual(message.recipients, ['coder', 'minimac']);
});

test('a normal recipient stop preserves delivered state', () => {
  const delivery = createDelivery({
    id: 'delivery-1', authorId: 'you', messageId: 'message-1',
    recipientId: 'coder', state: DELIVERY_STATE.DELIVERED, createdAt: 10,
  }).event;
  const stopped = createEvent('coder', EVENT_KINDS.STATUS, {
    state: 'stopped', reason: 'session ended',
  }, 20);
  assert.equal(
    conversationOf([delivery, stopped]).delivery['message-1:coder'].state,
    DELIVERY_STATE.DELIVERED,
  );
});
