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
  return plainText(payload.text).slice(0, 90);
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
