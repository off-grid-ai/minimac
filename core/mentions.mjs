// Mentions. One grammar for everything you can name while typing:
//
//   @src/replay/timeline.ts   a file the agent should own and work in
//   /hygiene                  a skill the agent must apply
//   @coder or @ironman        an agent to address, or to hand work to
//
// Pure: it classifies against a roster it is given and never touches disk.

const TOKEN = /(^|\s)([@/#])([\w./~-]*[\w/-])/g;

export function parseMentions(text, { agents = [], checkpoints = [], decisions = [] } = {}) {
  const references = [];
  const aliases = agentMentionAliases(agents);
  const checkpointIds = new Set(checkpoints.map((item) => String(item.id).toLowerCase()));
  const decisionIds = new Set(decisions.map((item) => String(item.key ?? item.id).toLowerCase()));

  for (const [, , sigil, name] of text.matchAll(TOKEN)) {
    if (sigil === '/') {
      pushReference(references, { kind: 'skill', id: name });
      continue;
    }
    if (sigil === '#') {
      const key = name.toLowerCase();
      if (checkpointIds.has(key)) pushReference(references, { kind: 'checkpoint', id: name });
      else if (decisionIds.has(key)) pushReference(references, { kind: 'decision', id: name });
      continue;
    }
    const agentId = aliases.get(name.toLowerCase());
    if (agentId) pushReference(references, { kind: 'hero', id: agentId });
    else pushReference(references, { kind: 'file', id: name });
  }

  return { text, references };
}

// One alias codec for autocomplete and routing. Stable ids always win. A
// display name adds a readable kebab-case alias without becoming a second
// identity. Parenthetical titles stay presentation only.
export function agentMentionAliases(agents = []) {
  const aliases = new Map();
  for (const agent of agents) {
    if (agent?.id) aliases.set(String(agent.id).toLowerCase(), agent.id);
  }
  for (const agent of agents) {
    const alias = mentionAlias(agent?.name);
    if (alias && !aliases.has(alias)) aliases.set(alias, agent.id);
  }
  return aliases;
}

export function agentMentionNames(agents = []) {
  return [...agentMentionAliases(agents).keys()];
}

function mentionAlias(name) {
  return String(name ?? '')
    .split('(')[0]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// What the composer offers while you type. Returns null when the caret is not
// inside a mention, so the menu stays closed.
export function activeMention(text, caret = text.length) {
  const before = text.slice(0, caret);
  const match = before.match(/(^|\s)([@/#])([\w./~-]*)$/);
  if (!match) return null;
  return {
    sigil: match[2],
    query: match[3],
    start: caret - match[3].length - 1,
    end: caret,
  };
}

export function applyMention(text, mention, value) {
  return `${text.slice(0, mention.start)}${mention.sigil}${value} ${text.slice(mention.end)}`;
}

// A mention of an agent retargets the message; a message with no agent mention
// goes wherever the composer is pointed.
export function routeOf(parsed, fallbackAgentId) {
  return parsed.references.find((reference) => reference.kind === 'hero')?.id ?? fallbackAgentId;
}

function pushReference(list, reference) {
  if (reference.id && !list.some((value) => value.kind === reference.kind && value.id === reference.id)) {
    list.push(reference);
  }
}
