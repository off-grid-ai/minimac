import { REACTIONS, reactionsForMessage } from '../core/conversation.mjs';
import { renderMarkdown } from './markdown.mjs';
import { createControlButton, createRelativeTime } from './controls.mjs';

export function renderThread(root, messages, { agents = {}, events = [], onReply, onReact, onOpen } = {}) {
  if (!messages.length) {
    const empty = document.createElement('p');
    empty.className = 'conversation-empty';
    empty.textContent = 'No messages yet.';
    root.replaceChildren(empty);
    return;
  }
  root.replaceChildren(...groupMessages(messages).map((group) => renderMessageGroup(group, {
    agents, events, onReply, onReact, onOpen,
  })));
}

export function renderMessageGroup(messages, options = {}) {
  const group = document.createElement('section');
  group.className = 'conversation-group';
  const author = messages[0].from === 'you' ? 'You'
    : options.agents[messages[0].authorId]?.label ?? messages[0].authorId;
  const head = document.createElement('header');
  head.className = 'conversation-group-head';
  head.append(text('span', author), createRelativeTime(messages[0].createdAt));
  group.append(head, ...messages.map((message) => renderMessage(message, options)));
  return group;
}

export function renderMessage(message, { events = [], onReply, onReact, onOpen } = {}) {
  const article = document.createElement('article');
  article.className = 'conversation-message';
  article.dataset.messageId = message.id;
  if (message.replyToMessageId) article.dataset.replyTo = message.replyToMessageId;
  const body = document.createElement('div');
  body.className = 'conversation-body md';
  body.innerHTML = renderMarkdown(message.body);
  article.append(body);
  if (message.attachments.length) article.append(renderAttachments(message.attachments));
  if (message.references.length) article.append(renderReferences(message.references, onOpen));
  const actions = document.createElement('div');
  actions.className = 'conversation-actions';
  if (onReply) {
    const reply = createControlButton('↩');
    reply.classList.add('is-icon');
    reply.setAttribute('aria-label', `Reply to ${message.authorId}`);
    reply.title = 'Reply';
    reply.onclick = () => onReply(message);
    actions.append(reply);
  }
  const active = reactionsForMessage(events, message.id);
  for (const [key, reaction] of Object.entries(REACTIONS)) {
    const actors = active[key] ?? [];
    if (!actors.length) continue;
    const button = createControlButton(`${reaction.symbol}${actors.length ? ` ${actors.length}` : ''}`);
    button.title = reaction.label;
    button.disabled = !onReact;
    if (onReact) button.onclick = () => onReact(message, key);
    actions.append(button);
  }
  if (actions.childElementCount) article.append(actions);
  return article;
}

export function renderAttachments(files) {
  const row = document.createElement('div');
  row.className = 'conversation-attachments';
  for (const file of files) {
    const link = document.createElement('a');
    link.className = 'conversation-attachment';
    link.href = `/attachment?path=${encodeURIComponent(file.path)}`;
    link.target = '_blank';
    link.rel = 'noreferrer';
    if (String(file.type ?? '').startsWith('image/')) {
      const image = document.createElement('img');
      image.src = link.href;
      image.alt = file.name ?? 'Attached image';
      image.loading = 'lazy';
      link.append(image);
    } else link.textContent = file.name ?? 'Attachment';
    row.append(link);
  }
  return row;
}

export function renderReferences(references, onOpen) {
  const row = document.createElement('nav');
  row.className = 'conversation-references';
  for (const reference of references.filter((value) => value.kind !== 'attachment')) {
    const chip = createControlButton(referenceLabel(reference));
    chip.onclick = () => onOpen?.(reference);
    row.append(chip);
    if (reference.kind === 'checkpoint') {
      const thread = createControlButton('');
      thread.classList.add('is-icon', 'conversation-thread-link');
      thread.setAttribute('aria-label', `Open ${reference.id} thread`);
      thread.title = 'Open thread';
      thread.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5h10v7H7l-3 2v-2H3z"/></svg>';
      thread.onclick = () => onOpen?.(reference);
      row.append(thread);
    }
  }
  return row;
}

export function renderComposer() {
  const footer = document.createElement('footer');
  footer.className = 'conversation-composer';
  return footer;
}

function groupMessages(messages) {
  const groups = [];
  for (const message of messages) {
    const current = groups.at(-1);
    if (current?.[0].authorId === message.authorId) current.push(message);
    else groups.push([message]);
  }
  return groups;
}

function referenceLabel(reference) {
  if (reference.kind === 'hero') return `@${reference.label ?? reference.id}`;
  if (reference.kind === 'checkpoint') return `#${reference.label ?? reference.id}`;
  if (reference.kind === 'skill') return `/${reference.label ?? reference.id}`;
  return reference.label ?? reference.id;
}

function text(tag, value) {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}
