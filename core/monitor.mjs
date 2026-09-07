// The monitor. What the room notices that nobody reported.
//
// `derive.mjs` holds the detectors - loops, overruns, silence, staleness, the
// grade of a claim. This is the layer above: it runs every detector over every
// agent and produces the cards that are worth somebody's attention, then says
// which of those are NEW since last time.
//
// It lived inside ui/main.mjs, which meant the room's knowledge reached a
// screen and nothing that could act on it. Here it is pure and importable, so
// the server can run it once and both the browser and the orchestrator can
// read the same answer. One monitor, two consumers.
//
// Nothing in this file touches an engine, a socket, a clock it was not handed,
// or the DOM.

import { EVENT_KINDS } from './events.mjs';
import { pendingDecisions } from './derive.mjs';

// A stable identity for a card. The same standing condition on the same agent
// is ONE card for as long as it lasts - otherwise a loop that persists for two
// minutes would wake the orchestrator several hundred times.
export function cardKey(card) {
  const base = `${card.agentId}:${card.kind}`;
  return card.approval?.id ? `${base}:${card.approval.id}` : base;
}

// A card owns the time its condition first became visible. Keep that time on
// the server-owned card so browser reloads and every consumer read one value.
export function stampCards(previous = [], next = [], now) {
  const raisedAt = new Map(previous.map((card) => [cardKey(card), card.raisedAt]));
  return next.map((card) => ({
    ...card,
    raisedAt: raisedAt.get(cardKey(card)) ?? now,
  }));
}

// The newest approval that has not been answered. An engine parked on one is
// frozen until a human-shaped answer arrives, which is why it outranks
// everything the detectors merely observed.
export function pendingApproval(events = []) {
  const resolved = new Set();
  let open = null;
  for (const event of events) {
    if (event.kind !== EVENT_KINDS.APPROVAL) continue;
    if (event.payload?.resolved) resolved.add(event.payload.id);
    else open = event.payload;
  }
  return open && !resolved.has(open.id) ? open : null;
}

// A hero's own escalation. The detectors are involuntary and that is their
// value, but "I need a decision", "we are about to touch the same file" and
// "my goal contradicts another agent's" can never be derived from behaviour.
export function prayerOf(events = []) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.kind !== EVENT_KINDS.PRAYER) continue;
    if (event.payload?.answered) return null; // the newest one is already handled
    return event.payload;
  }
  return null;
}

// The discipline cards. A rule nobody checks is decoration, so the room checks
// these itself rather than trusting the agent to have obeyed.

// Every card the room would raise, for every agent, right now.
//
// `agents` is the list in display order. `eventsByAgent` is a plain object of
// agentId -> that agent's events, oldest first.
export function deriveCards(agents = [], eventsByAgent = {}, now = Date.now()) {
  const cards = [];
  for (const agent of agents) {
    if (agent.enabled === false) continue; // off the mission, not worth reporting
    const events = eventsByAgent[agent.id] ?? [];
    const approval = pendingApproval(events);
    const name = agent.label ?? agent.name;

    const derived = pendingDecisions(agent, events, now).map((decision) => ({
      ...decision,
      agentName: name,
      approval: decision.kind === 'blocked' ? approval : null,
    }));

    // An approval nobody has folded into a blocked card is a card of its own.
    if (approval && !derived.some((card) => card.approval)) {
      derived.unshift({
        agentId: agent.id,
        agentName: name,
        kind: 'approval',
        detail: approval.summary,
        actions: ['steer', 'kill'],
        approval,
      });
    }

    const prayer = prayerOf(events);
    if (prayer?.why) {
      derived.unshift({
        agentId: agent.id,
        agentName: name,
        kind: 'prayer',
        detail: prayer.why,
        needs: prayer.needs ?? 'decision',
        actions: ['steer', 'kill'],
        approval: null,
      });
    }

    cards.push(...derived);
  }
  return cards.sort((a, b) => urgency(a) - urgency(b));
}

// An engine that is frozen outranks one that is merely going wrong, and a hero
// who asked for you outranks a number the room worked out on its own.
const RANK = Object.freeze({
  approval: 0,
  prayer: 1,
  blocked: 2,
});

export function urgency(card) {
  return RANK[card.kind] ?? 6;
}

// What changed since the last pass. `raised` is what nobody has seen yet and is
// the only thing worth waking anyone for; `cleared` is what resolved itself,
// which matters because a card that went away must stop being acted on.
export function diffCards(previous = [], next = []) {
  const before = new Set(previous.map(cardKey));
  const after = new Set(next.map(cardKey));
  return {
    raised: next.filter((card) => !before.has(cardKey(card))),
    cleared: previous.filter((card) => !after.has(cardKey(card))),
  };
}

// Index events by agent, oldest first. The server keeps one flat list, so this
// is how it gets the shape every detector expects.
export function indexByAgent(events = []) {
  const byAgent = {};
  for (const event of events) {
    (byAgent[event.agentId] ??= []).push(event);
  }
  return byAgent;
}
