// Turning machine output into something a person reads is a RULE, not a
// rendering detail, so it lives here with the other rules. The floor, the feed
// and the decision cards all ask this module - there is one answer to "what
// does this event say", and it is the same wherever it is shown.

import { EVENT_KINDS } from './events.mjs';

// A shell command is not a sentence. Say what was run in a few words; the exact
// command stays available wherever the surface can afford it.
export function summariseCommand(command) {
  let text = String(command ?? '').replace(/\s+/g, ' ').trim();
  text = text.replace(/^\/bin\/\w*sh\s+-\w+\s*/, '');        // /bin/zsh -lc
  text = text.replace(/^['"]/, '').replace(/['"]$/, '');
  text = text.replace(/^cd\s+\S+\s*(&&|;)\s*/, '');          // cd somewhere &&

  const first = text.split(/\s*(?:&&|\||;)\s*/)[0] ?? text;
  const words = first.split(' ').filter(Boolean);
  const tool = words[0] ?? '';
  const rest = words.slice(1).filter((word) => !word.startsWith('-')).slice(0, 2).join(' ');
  const short = [tool, rest].filter(Boolean).join(' ').slice(0, 70);
  return short + (text.length > first.length ? ' …' : '');
}

// What an agent is doing, in one line.
export function describeEvent(event) {
  const payload = event?.payload ?? {};
  if (event?.kind === EVENT_KINDS.TOOL) {
    const target = String(payload.target ?? '');
    const short = payload.action === 'run'
      ? summariseCommand(target)
      : target.replace(/\s+/g, ' ').trim().slice(0, 90);
    return `${payload.action} ${short}`;
  }
  // A claim without its receipt is just a confident sentence. Wherever a claim
  // is said out loud, the command behind it - or the absence of one - is said
  // in the same breath.
  if (event?.kind === EVENT_KINDS.CLAIM) {
    return `${plainText(payload.text).slice(0, 70)} ${describeReceipt(payload.receipt)}`;
  }
  return plainText(payload.text).slice(0, 90);
}

// The receipt, in the few words a bubble can afford.
export function describeReceipt(receipt) {
  const text = String(receipt ?? '').trim();
  return text ? `\u2190 ${summariseCommand(text)}` : '\u2190 no receipt';
}

// A paragraph, reduced to the one line a nameplate or a bubble can hold. The
// first sentence carries the point; the rest is elaboration.
export function firstLine(source, max = 90) {
  const text = plainText(source);
  if (!text) return '';
  const stop = text.search(/[.:;!?](\s|$)/);
  const head = stop > 0 ? text.slice(0, stop) : text;
  return head.length > max ? `${head.slice(0, max - 1)}\u2026` : head;
}

// A decision's detail is often a command wearing a prefix.
export function shortenDetail(detail) {
  const text = String(detail ?? '');
  const run = /^\s*run:\s*([\s\S]+)$/.exec(text);
  if (run) return `run ${summariseCommand(run[1])}`;
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

// Markdown belongs in a panel, never in a one-line bubble or a nameplate.
export function plainText(source) {
  return String(source ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_~`#>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
