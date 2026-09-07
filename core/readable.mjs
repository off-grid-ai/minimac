// Turning machine output into something a person reads is a RULE, not a
// rendering detail, so it lives here with the other rules. The floor, the feed
// and the decision cards all ask this module - there is one answer to "what
// does this event say", and it is the same wherever it is shown.

import { EVENT_KINDS } from './events.mjs';
import { isBoardActivityEvent, isCrosstalkEvent } from './coordination.mjs';

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
  // A hero says what they are DOING. The command that proves it belongs in a
  // receipt, not in their mouth.
  if (event?.kind === EVENT_KINDS.TOOL) {
    return doingWords(payload.action, payload.target);
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
    .replace(/(^|\s)#{1,6}\s+/g, '$1')
    .replace(/(^|\n)\s*>\s?/g, '$1')
    .replace(/(^|\s)__([^_\n]+)__($|\s|[.,!?])/g, '$1$2$3')
    .replace(/(^|[^\w])_([^_\n]+)_($|[^\w])/g, '$1$2$3')
    .replace(/[\*~`]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// ------------------------------------------------------- the machine's half

// An agent's reply carries two things: prose for you, and a fenced block of
// JSON for the tool. Codex streams a long reply in flushes, so that block
// arrives split across several message events - and each fragment used to be
// shown on the floor as speech. That is how a hero came to say "] }".
//
// This is a STREAMING splitter: it takes the fragment and whether we were
// already inside a block, and returns the prose a person should see plus the
// state to pass to the next fragment. Nothing machine-shaped reaches the eye,
// and the caller keeps the raw text for parsing.
export function splitFenced(text, fences = [], open = false, preserveWhitespace = false) {
  const source = String(text ?? '');
  const opener = new RegExp('```(?:' + fences.join('|') + ')\\s*', 'g');
  let prose = '';
  let index = 0;
  let inside = open;

  while (index < source.length) {
    if (inside) {
      const close = source.indexOf('```', index);
      if (close === -1) {
        return {
          prose: preserveWhitespace ? prose : prose.trim(),
          open: true,
          partial: false,
        };
      }
      index = close + 3;
      inside = false;
      continue;
    }
    opener.lastIndex = index;
    const match = opener.exec(source);
    if (!match) {
      prose += source.slice(index);
      break;
    }
    prose += source.slice(index, match.index);
    index = match.index + match[0].length;
    inside = true;
  }

  // A flush can end in the MIDDLE of a fence marker - "``" now, "`minimac"
  // next. Those characters are not prose yet: they are the start of something
  // machine-shaped, and speaking them is how "```minimac" reached the floor
  // one backtick at a time. Hold back any tail that could still become one.
  const held = openerTail(prose, fences);
  return {
    prose: preserveWhitespace
      ? prose.slice(0, prose.length - held)
      : prose.slice(0, prose.length - held).trim(),
    open: inside,
    partial: held > 0,
  };
}

// How many trailing characters of `text` are a prefix of some fence opener.
function openerTail(text, fences) {
  const openers = fences.map((fence) => '```' + fence);
  const longest = Math.max(3, ...openers.map((o) => o.length));
  for (let take = Math.min(longest, text.length); take > 0; take -= 1) {
    const tail = text.slice(text.length - take);
    if (openers.some((o) => o.startsWith(tail))) return take;
  }
  return 0;
}

// A fragment that is only the tail of a JSON block - "] }", '": 900000},' -
// is payload that escaped the splitter, never something a person said.
const MACHINE_ONLY = /^[\s{}[\](),:;"']*$/;
// The tail of a JSON block is still payload even when it carries a word:
// 'release/107-feedback"} ] }' is not a sentence anybody said.
const JSON_TAIL = /["'\d\w][\s]*["']?[}\]][\s}\],]*$/;

export function isMachineNoise(text) {
  const value = String(text ?? '').trim();
  if (!value) return true;
  if (MACHINE_ONLY.test(value)) return true;
  // Real prose does not end on a closing brace or bracket.
  return JSON_TAIL.test(value) && /[{}[\]"]/.test(value);
}

// ------------------------------------------------------------ feed presets

// Three altitudes for the same stream. ALL is everything; CROSSTALK is only
// heroes talking to one another; SIGNAL is that plus the things that change
// what happens next - orders, verdicts, decisions and proof.
//
// Pure: given an event, does this preset let it through.
export const FEED_PRESETS = Object.freeze([
  { id: 'all', label: 'all', blurb: 'every line, in the order it happened' },
  { id: 'crosstalk', label: 'crosstalk', blurb: 'only the heroes talking to each other' },
  { id: 'signal', label: 'signal', blurb: 'crosstalk, plus anything that changes what happens next' },
  { id: 'evidence', label: 'evidence', blurb: 'only what was claimed, and the command behind it' },
]);

export function isPreset(id) {
  return id === 'board' || FEED_PRESETS.some((preset) => preset.id === id);
}

// Things that change what happens next: an order, a ruling, a permission
// request, a block, a finished turn, or a claim with a command behind it.
const SIGNAL_KINDS = new Set([
  'ping', 'blocked', 'approval', 'result', 'prayer', 'claim',
  'order', 'escalation', 'lease',
]);

export function passesPreset(event, preset = 'all') {
  if (preset === 'all' || !isPreset(preset)) return true;

  // Only what was claimed, with its command. A claim without a receipt is a
  // guess, and a wall of guesses is the opposite of evidence.
  if (preset === 'evidence') {
    return event?.kind === 'claim' && Boolean(event.payload?.receipt);
  }

  // Only the work moving.
  if (preset === 'board' || preset === 'checkpoints') {
    return isBoardActivityEvent(event);
  }

  if (isCrosstalkEvent(event)) return true;
  if (preset === 'crosstalk') return false;
  if (!SIGNAL_KINDS.has(event?.kind)) return false;
  if (event.kind === 'claim') return Boolean(event.payload?.receipt);
  return true;
}

// --------------------------------------------------- what a hero is doing

// A character never says a command. "run sed '1,240p' shared/ROADMAP.md" is
// the machine talking; "reading the roadmap" is the hero talking. Same fact,
// and only one of them can be read at a glance from across the room.
//
// This is deliberately a small, honest table. When a command is not in it the
// answer is the plain verb and the thing it touched - never the flags, never
// the pipeline, never a path six segments deep.
const DOING = Object.freeze([
  [/^git\s+push/, 'pushing to GitHub'],
  [/^git\s+(pull|fetch)/, 'catching up with GitHub'],
  [/^git\s+(commit)/, 'committing the work'],
  [/^git\s+(status|diff|log|rev-list|ls-tree|ls-remote|show|rev-parse)/, 'checking the repository'],
  [/^git\s+(checkout|switch|branch)/, 'moving between branches'],
  [/^gh\s+pr/, 'looking at the pull request'],
  [/^gh\s+run/, 'watching the checks'],
  [/^gh\s/, 'talking to GitHub'],
  [/^(npm|yarn|pnpm)\s+(run\s+)?(test|jest|vitest)/, 'running the tests'],
  [/^(npm|yarn|pnpm)\s+(run\s+)?(lint|eslint)/, 'running lint'],
  [/^(npm|yarn|pnpm)\s+(run\s+)?build/, 'building'],
  [/^(npm|yarn|pnpm)\s+(ci|install|i)\b/, 'installing dependencies'],
  [/^(npx\s+)?tsc/, 'checking types'],
  [/^(npm|yarn|pnpm)\s/, 'running a project script'],
  [/^(cat|sed|head|tail|less|bat)\b/, 'reading a file'],
  [/^(grep|rg|ag|ack)\b/, 'searching the code'],
  [/^(ls|find|fd|tree)\b/, 'looking around the folder'],
  [/^(mkdir|cp|mv|touch|rm)\b/, 'moving files about'],
  [/^(ps|top|lsof|kill)\b/, 'checking what is running'],
  [/^(curl|wget)\b/, 'calling out to the network'],
  [/^(echo|printf)\b/, 'writing something down'],
  [/^(python|python3|node|ruby|go|cargo)\b/, 'running a script'],
]);

// The last path-looking word, as its filename only.
function subject(command) {
  const words = String(command ?? '').split(/\s+/).filter((w) => !w.startsWith('-'));
  const path = [...words].reverse().find((w) => /[/.]/.test(w) && !/^https?:/.test(w));
  if (!path) return '';
  return path.replace(/['"`]/g, '').split('/').filter(Boolean).pop() ?? '';
}

export function doingWords(action, target) {
  const verb = String(action ?? '').toLowerCase();
  if (verb === 'read') return `reading ${subject(target) || 'a file'}`;
  if (verb === 'edit' || verb === 'write') return `changing ${subject(target) || 'a file'}`;
  if (verb === 'search') return 'searching the code';

  const command = String(target ?? '')
    .replace(/^\/bin\/\w*sh\s+-\w+\s*/, '')
    .replace(/^['"]/, '')
    .replace(/^cd\s+\S+\s*(&&|;)\s*/, '')
    .trim();
  for (const [pattern, words] of DOING) {
    if (pattern.test(command)) {
      const what = subject(command);
      return what && !words.includes(what) ? `${words} · ${what}` : words;
    }
  }
  const tool = command.split(/\s+/)[0] ?? '';
  return tool ? `working with ${tool}` : 'working';
}
