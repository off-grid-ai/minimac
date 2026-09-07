// Governance: who answers the decision cards.
//
// The floor derives cards nobody reported - a loop, an overrun, a silence, a
// blocked agent, a claim with no receipt. Until now every one of them stopped
// at the human, which makes the human the only governor of the fleet. That is
// the thing the north star is against: you command a crew, you never babysit
// one.
//
// Thor can answer them instead. How much he is trusted with is YOUR choice,
// and it is one setting with three positions. Nothing here talks to an engine
// or a socket: these are pure decisions about where a card goes and what the
// orchestrator is asked. The server does the sending.

// There is ONE behaviour, not three: Thor acts on what the room raises, and
// you still see every card he touched. A mode that hid his work would let him
// be wrong quietly, and a mode that only let him advise would leave you the
// sole governor - which is the thing this exists to stop. Neither was worth a
// switch, so there is no switch.

// What Thor is allowed to do about a card. Deliberately small: everything here
// is reversible from the floor, and none of it can touch your files.
export const VERDICT = Object.freeze({
  // Leave it alone - this is normal for this agent right now.
  HOLD: 'hold',
  // Say something to that agent, mid-turn.
  STEER: 'steer',
  // Give that agent a different standing objective.
  GOAL: 'goal',
  // Take that agent off the mission entirely.
  BENCH: 'bench',
  // This one is the human's call. Always reaches you, in every mode.
  ESCALATE: 'escalate',
});

const VERDICT_ACTIONS = new Set(Object.values(VERDICT));

export function isVerdictAction(value) {
  return VERDICT_ACTIONS.has(value);
}

// A stable identity for a card, so the same standing condition is not sent to
// the orchestrator once a second for as long as it lasts.
export function cardKey(card) {
  return `${card.agentId}:${card.kind}`;
}

// ------------------------------------------------------------------ routing

// Where one card goes, given the mode and whatever Thor said about it.
//
// `verdict` is null while Thor has not answered yet. An unanswered card in a
// mode that hides cards must still be held rather than dropped - silence from
// the orchestrator is not the same as the orchestrator clearing it.
export function routeCard(card, verdict = null, orchestratorId = null) {
  // An approval freezes the engine until a human-shaped answer arrives, and it
  // is the one thing the operator is accountable for. It is never delegated.
  if (card.kind === 'approval' || card.approval) {
    return { toHuman: true, toThor: false, reason: 'approvals are always yours' };
  }
  // Nobody supervises themselves. A card ABOUT the orchestrator goes to Mac,
  // never to the orchestrator - asking him to rule on his own overrun had him
  // wake mid-assemble and bench himself, and the assemble never finished.
  if (orchestratorId && card.agentId === orchestratorId) {
    return { toHuman: true, toThor: false, reason: 'the orchestrator is yours to judge' };
  }
  if (verdict?.action === VERDICT.ESCALATE) {
    return { toHuman: true, toThor: false, reason: verdict.note ?? 'escalated by the orchestrator' };
  }
  // He rules, and you see it. Nothing is hidden and nothing waits on you.
  return { toHuman: true, toThor: true, reason: null };
}

// ------------------------------------------------------------------- prompt

export const VERDICT_FENCE = 'minimac-verdict';

// One governance turn covers every open card at once. Waking the orchestrator
// per card would cost a turn each and let him answer the same condition
// several times with different reasoning.
export function governanceTask(cards, crew) {
  const roster = crew
    .filter((member) => member.role !== 'orchestrator')
    .map((member) => `- ${member.id}  (${member.label}, ${member.role})`
      + (member.objective ? `\n    goal: ${member.objective}` : '\n    goal: none set'))
    .join('\n');

  const list = cards
    .map((card) => `- id: ${cardKey(card)}\n  agent: ${card.agentId}\n  `
      + `condition: ${card.kind}\n  detail: ${card.detail}`)
    .join('\n');

  return [
    '# Governance turn',
    '',
    'The floor derived these conditions from what the crew actually did. Nobody '
    + 'reported them. Judge each one.',
    '',
    '## Open cards',
    '',
    list,
    '',
    '## The crew',
    '',
    roster,
    '',
    'Act on these yourself. Everything you do here is reversible from the floor, '
    + 'and Mac sees every card you touched.',
    '',
    'Answer with this block and nothing after it:',
    '',
    '```' + VERDICT_FENCE,
    '{ "verdicts": [',
    '  {"id": "coder:loop", "action": "steer", "note": "one line to the operator", '
    + '"text": "what to say to that agent"},',
    '  {"id": "tester:overrun", "action": "hold", "note": "why this is fine"}',
    '] }',
    '```',
    '',
    'Actions:',
    `- "${VERDICT.HOLD}" - normal for this agent right now. Say why in the note.`,
    `- "${VERDICT.STEER}" - say something to that agent mid-turn. Put it in "text".`,
    `- "${VERDICT.GOAL}" - give that agent a different objective. Put it in "text".`,
    `- "${VERDICT.BENCH}" - take that agent off the mission. Use this sparingly.`,
    `- "${VERDICT.ESCALATE}" - the operator's call, not yours. Say why in the note.`,
    '',
    'Rules:',
    '- One verdict per card id above. Do not invent ids.',
    '- The note is read by a person on the card itself. One line, plain English, '
    + 'no command names and no jargon.',
    '- Escalate anything that would lose work, cost money, or change what the '
    + 'mission is for. Those are never yours.',
    '- Prefer the smallest action that clears the condition. "hold" is a real answer.',
  ].join('\n');
}

// ------------------------------------------------------------------- answers

const VERDICT_BLOCK = new RegExp('```' + VERDICT_FENCE + '\\s*([\\s\\S]*?)```');

// Pull the verdicts out of the orchestrator's prose. Anything malformed is
// dropped rather than guessed at: a governance decision invented by a parser
// is worse than no governance at all.
export function parseVerdicts(text, { keys = null } = {}) {
  const match = VERDICT_BLOCK.exec(String(text ?? ''));
  if (!match) return [];

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return [];
  }

  const seen = new Set();
  const out = [];
  for (const raw of parsed.verdicts ?? []) {
    const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
    if (!id || seen.has(id)) continue;
    if (keys && !keys.has(id)) continue; // never answer a card nobody raised
    if (!isVerdictAction(raw.action)) continue;
    // An action that carries no instruction cannot be applied.
    const text_ = typeof raw.text === 'string' ? raw.text.trim() : '';
    if ((raw.action === VERDICT.STEER || raw.action === VERDICT.GOAL) && !text_) continue;
    seen.add(id);
    out.push({
      id,
      agentId: id.split(':')[0],
      action: raw.action,
      note: typeof raw.note === 'string' ? raw.note.trim() : '',
      text: text_,
    });
  }
  return out;
}
