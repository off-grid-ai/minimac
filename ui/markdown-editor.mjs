// One editable Markdown surface. The DOM is the draft: shortcuts change its
// structure, and sending serialises that same structure back to Markdown.
// There is no hidden textarea or second preview state to reconcile.

import { activeMention } from '../core/mentions.mjs';
import { renderMarkdown } from './markdown.mjs';

const INLINE_SHORTCUTS = [
  { match: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/, tag: 'a', text: 1, href: 2 },
  { match: /\*\*([^*\n]+)\*\*$/, tag: 'strong', text: 1 },
  { match: /~~([^~\n]+)~~$/, tag: 'del', text: 1 },
  { match: /`([^`\n]+)`$/, tag: 'code', text: 1 },
  { match: /(?:^|\s)\*([^*\n]+)\*$/, tag: 'em', text: 1, leadingSpace: true },
];

export function createMarkdownEditor(root) {
  const rich = root?.isContentEditable === true;

  function value() {
    return rich ? toMarkdown(root) : String(root?.value ?? '');
  }

  function setValue(markdown) {
    if (!rich) {
      root.value = markdown ?? '';
      return;
    }
    root.innerHTML = markdown ? renderMarkdown(markdown) : '';
  }

  function setPlaceholder(text) {
    if (rich) root.dataset.placeholder = text;
    else root.placeholder = text;
  }

  function focus() {
    root.focus();
  }

  function caretToEnd() {
    if (!rich) {
      root.selectionStart = root.value.length;
      root.selectionEnd = root.value.length;
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function mention() {
    if (!rich) return activeMention(root.value, root.selectionStart);
    const selection = getSelection();
    const node = selection?.anchorNode;
    if (!selection?.isCollapsed || node?.nodeType !== Node.TEXT_NODE || !root.contains(node)) return null;
    const found = activeMention(node.data, selection.anchorOffset);
    return found ? { ...found, node } : null;
  }

  function replaceMention(found, replacement) {
    if (!rich) return false;
    if (!found?.node?.isConnected) return false;
    const range = document.createRange();
    range.setStart(found.node, found.start);
    range.setEnd(found.node, found.end);
    range.deleteContents();
    const text = document.createTextNode(replacement);
    range.insertNode(text);
    range.setStartAfter(text);
    range.collapse(true);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function atHistoryEdge(direction) {
    if (!rich) {
      if (root.selectionStart !== root.selectionEnd) return false;
      if (!root.value.includes('\n')) return true;
      if (direction < 0) return root.selectionStart <= root.value.indexOf('\n');
      return root.selectionStart > root.value.lastIndexOf('\n');
    }
    const selection = getSelection();
    if (!selection?.isCollapsed || !root.contains(selection.anchorNode)) return false;
    const before = document.createRange();
    before.selectNodeContents(root);
    before.setEnd(selection.anchorNode, selection.anchorOffset);
    const offset = before.toString().length;
    const text = root.innerText;
    if (!text.includes('\n')) return true;
    return direction < 0 ? offset <= text.indexOf('\n') : offset > text.lastIndexOf('\n');
  }

  function formatInput() {
    if (!rich) return;
    if (applyBlockShortcut(root)) return;
    applyInlineShortcut(root);
  }

  function paste(event) {
    if (!rich || event.clipboardData?.files?.length) return false;
    const text = event.clipboardData?.getData('text/plain');
    if (!text) return false;
    event.preventDefault();
    const html = renderMarkdown(text);
    if (!value()) root.innerHTML = html;
    else insertHtmlAtCaret(root, html);
    caretToEnd();
    return true;
  }

  return {
    rich,
    value,
    setValue,
    setPlaceholder,
    focus,
    caretToEnd,
    mention,
    replaceMention,
    atHistoryEdge,
    formatInput,
    paste,
  };
}

function insertHtmlAtCaret(root, html) {
  const selection = getSelection();
  if (!selection?.rangeCount || !root.contains(selection.anchorNode)) {
    root.insertAdjacentHTML('beforeend', html);
    return;
  }
  const template = document.createElement('template');
  template.innerHTML = html;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  range.insertNode(template.content);
}

function applyBlockShortcut(root) {
  const selection = getSelection();
  if (!selection?.isCollapsed || !root.contains(selection.anchorNode)) return false;
  let block = selection.anchorNode;
  while (block.parentNode && block.parentNode !== root) block = block.parentNode;
  const text = block.textContent ?? '';
  const heading = /^(#{1,6}) $/.exec(text);
  const type = text === '> ' ? 'blockquote'
    : text === '- ' || text === '* ' ? 'ul'
      : text === '1. ' ? 'ol'
        : text === '``` ' ? 'pre'
          : heading ? `h${heading[1].length}` : null;
  if (!type) return false;

  let next;
  let caret;
  if (type === 'ul' || type === 'ol') {
    next = document.createElement(type);
    next.className = 'md-list';
    caret = document.createElement('li');
    caret.append(document.createElement('br'));
    next.append(caret);
  } else if (type === 'pre') {
    next = document.createElement('pre');
    next.className = 'md-pre';
    caret = document.createElement('code');
    caret.append(document.createElement('br'));
    next.append(caret);
  } else {
    next = document.createElement(type);
    if (type === 'blockquote') next.className = 'md-quote';
    if (type.startsWith('h')) next.className = 'md-h';
    next.append(document.createElement('br'));
    caret = next;
  }

  if (block === root) root.replaceChildren(next);
  else block.replaceWith(next);
  placeCaret(caret, 0);
  return true;
}

function applyInlineShortcut(root) {
  const selection = getSelection();
  const node = selection?.anchorNode;
  if (!selection?.isCollapsed || node?.nodeType !== Node.TEXT_NODE || !root.contains(node)) return false;
  if (node.parentElement?.closest('code, pre')) return false;
  const before = node.data.slice(0, selection.anchorOffset);
  for (const shortcut of INLINE_SHORTCUTS) {
    const match = shortcut.match.exec(before);
    if (!match) continue;
    const leading = shortcut.leadingSpace && match[0].startsWith(' ') ? ' ' : '';
    const start = selection.anchorOffset - match[0].length + leading.length;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, selection.anchorOffset);
    range.deleteContents();
    const formatted = document.createElement(shortcut.tag);
    formatted.textContent = match[shortcut.text];
    if (shortcut.href) {
      formatted.href = match[shortcut.href];
      formatted.target = '_blank';
      formatted.rel = 'noreferrer';
    }
    range.insertNode(formatted);
    const tail = document.createTextNode('\u200b');
    formatted.after(tail);
    placeCaret(tail, 1);
    return true;
  }
  return false;
}

function placeCaret(node, offset) {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

export function toMarkdown(root) {
  const text = [...root.childNodes].map((node) => serialize(node)).join('');
  return text
    .replace(/\u200b/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function serialize(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.data.replace(/\u00a0/g, ' ');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const tag = node.tagName.toLowerCase();
  const children = () => [...node.childNodes].map((child) => serialize(child)).join('');
  if (tag === 'br') return '\n';
  if (tag === 'strong' || tag === 'b') return `**${children()}**`;
  if (tag === 'em' || tag === 'i') return `*${children()}*`;
  if (tag === 'del' || tag === 's') return `~~${children()}~~`;
  if (tag === 'code' && node.parentElement?.tagName.toLowerCase() !== 'pre') return `\`${children()}\``;
  if (tag === 'a') return `[${children()}](${node.getAttribute('href') ?? ''})`;
  if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${children().trim()}\n\n`;
  if (tag === 'blockquote') {
    return `${children().trim().split('\n').map((line) => `> ${line}`).join('\n')}\n\n`;
  }
  if (tag === 'pre') return `\`\`\`${node.dataset.lang ?? ''}\n${node.textContent?.replace(/\u200b/g, '').trimEnd() ?? ''}\n\`\`\`\n\n`;
  if (tag === 'ul' || tag === 'ol') {
    const items = [...node.children].filter((child) => child.tagName.toLowerCase() === 'li');
    return `${items.map((item, index) => `${tag === 'ol' ? `${index + 1}.` : '-'} ${[...item.childNodes].map(serialize).join('').trim()}`).join('\n')}\n\n`;
  }
  if (tag === 'table') return `${serializeTable(node)}\n\n`;
  if (tag === 'p' || tag === 'div') return `${children().trimEnd()}\n\n`;
  return children();
}

function serializeTable(table) {
  const rows = [...table.querySelectorAll('tr')].map((row) =>
    [...row.children].map((cell) => cell.textContent?.trim() ?? ''));
  if (!rows.length) return '';
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(rows[0]), line(rows[0].map(() => '---')), ...rows.slice(1).map(line)].join('\n');
}
