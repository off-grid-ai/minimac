// Mentions. One grammar for everything you can name while typing:
//
//   @src/replay/timeline.ts   a file the agent should own and work in
//   /hygiene                  a skill the agent must apply
//   @coder                    an agent to address, or to hand work to
//
// Pure: it classifies against a roster it is given and never touches disk.

const TOKEN = /(^|\s)([@/])([\w./~-]*[\w/-])/g;

export function parseMentions(text, { agentIds = [] } = {}) {
  const files = [];
  const skills = [];
  const agents = [];

  for (const [, , sigil, name] of text.matchAll(TOKEN)) {
    if (sigil === '/') {
      push(skills, name);
      continue;
    }
    if (agentIds.includes(name)) push(agents, name);
    else push(files, name);
  }

  return { text, files, skills, agents };
}

// What the composer offers while you type. Returns null when the caret is not
// inside a mention, so the menu stays closed.
export function activeMention(text, caret = text.length) {
  const before = text.slice(0, caret);
  const match = before.match(/(^|\s)([@/])([\w./~-]*)$/);
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
  return parsed.agents[0] ?? fallbackAgentId;
}

function push(list, value) {
  if (value && !list.includes(value)) list.push(value);
}
