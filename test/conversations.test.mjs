import test from 'node:test';
import assert from 'node:assert/strict';

import { createConversationService } from '../application/conversations.mjs';

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
