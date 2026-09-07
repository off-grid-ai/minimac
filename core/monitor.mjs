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
import { PLANS_THRICE } from './dispatch.mjs';

// A stable identity for a card. The same standing condition on the same agent
// is ONE card for as long as it lasts - otherwise a loop that persists for two
// minutes would wake the orchestrator several hundred times.
export function cardKey(card) {
  return `${card.agentId}:${card.kind}`;
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

// A step that is running and never said how long it would take. It cannot be
// late, which is exactly why it must not be allowed to stay silent.
export function noEstimateCard(agent, name) {
  const open = (agent.flows ?? []).find(
    (step) => step?.status && step.status !== 'pending' && !step.estimateMs,
  );
  if (!open) return null;
  return {
    agentId: agent.id,
    agentName: name,
    kind: 'no-estimate',
    detail: `"${open.step}" is running with no estimate, so nothing can tell you if it is late`,
    actions: ['steer', 'kill'],
    approval: null,
  };
}

// A step that changed something without a plan behind it, or with a plan that
// was never sharpened. Only for the roles that plan.
export function unplannedCard(agent, name) {
  if (!PLANS_THRICE.has(agent.role)) return null;
  const started = (agent.flows ?? []).filter(
    (step) => step?.status && step.status !== 'pending',
  );

  const unplanned = started.find((step) => !step.approach?.plan);
  if (unplanned) {
    return {
      agentId: agent.id,
      agentName: name,
      kind: 'unplanned',
      detail: `"${unplanned.step}" was acted on with no plan behind it`,
      actions: ['steer', 'kill'],
      approval: null,
    };
  }

  // A plan nobody attacked is a first draft. Both passes have to have changed
  // something, or the loop was recited rather than run.
  const unsharpened = started.find(
    (step) => !step.approach.sharpened?.trim() || !step.approach.cut?.trim(),
  );
  if (!unsharpened) return null;
  return {
    agentId: agent.id,
    agentName: name,
    kind: 'unplanned',
    detail: `"${unsharpened.step}" acted on a first-draft plan - it was never sharpened or cut`,
    actions: ['steer', 'kill'],
    approval: null,
  };
}

// A step planned as though nothing had happened before it. This is the drift
// the chain exists to stop: planning at step six against the task as first read.
export function brokenChainCard(agent, name) {
  if (!PLANS_THRICE.has(agent.role)) return null;
  const steps = agent.flows ?? [];
  const index = steps.findIndex(
    (step, i) => i > 0 && step?.approach?.plan && !(step.approach.inputs ?? []).length,
  );
  if (index === -1) return null;
  return {
    agentId: agent.id,
    agentName: name,
    kind: 'broken-chain',
    detail: `"${steps[index].step}" was planned without reading what the earlier steps produced`,
    actions: ['steer', 'kill'],
    approval: null,
  };
}

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

    for (const make of [noEstimateCard, unplannedCard, brokenChainCard]) {
      const card = make(agent, name);
      if (card) derived.push(card);
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
  'broken-chain': 3,
  unplanned: 4,
  'no-estimate': 5,
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
