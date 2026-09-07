// Transport and wiring only. Every rule lives in core/; every I/O detail lives
// in adapters/. This file moves messages between them.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appendEvent,
  BLOCKED_REASONS,
  createBlockedEvent,
  createEvent,
  EVENT_KINDS,
  eventsFor,
} from './core/events.mjs';
import { createRoster, assignEngine, DEFAULT_ROSTER, ENGINES, ROLES } from './core/roster.mjs';
import { setGoal, getGoal, clearGoal, deriveGoals } from './core/goals.mjs';
import { claimFiles, releaseClaim } from './core/claims.mjs';
import {
  composeDispatch,
  buildOutputSchema,
  workerDispatches,
  REPORT_FENCE,
  GOALS_FENCE,
  planningTask,
  EDITABLE_STEPS,
  defaultStepText,
  dispatchPipeline,
} from './core/dispatch.mjs';
import { createDriverRegistry } from './ports/driver.mjs';
import { createCodexDriver } from './adapters/codex.mjs';
import { createClaudeDriver } from './adapters/claude.mjs';
import { createSimDriver } from './adapters/sim.mjs';
import { ensureCodexServer } from './adapters/codexd.mjs';
import { createStore } from './adapters/store.mjs';
import { createWorktrees } from './adapters/git.mjs';
import { createRepoIndex } from './adapters/fs.mjs';
import { createUploads } from './adapters/uploads.mjs';
import { parseMentions, routeOf } from './core/mentions.mjs';
import { deriveCards, diffCards, indexByAgent, cardKey, prayerOf } from './core/monitor.mjs';
import {
  createBoard,
  addItem,
  assign as assignItem,
  advance as advanceGate,
  itemsOf,
  findItem,
  progress as boardProgress,
} from './core/board.mjs';
import {
  routeCard,
  governanceTask,
  parseVerdicts,
  VERDICT,
  VERDICT_FENCE,
} from './core/governance.mjs';
import { splitFenced, isMachineNoise } from './core/readable.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.json': 'application/json; charset=utf-8',
};

const options = parseArgs(process.argv.slice(2));

// A personal roster is a local file, never a repo default: names and meshes
// are taste, and one machine's taste should not ship with the tool.
if (options.rosterPath) {
  const file = JSON.parse(await readFile(options.rosterPath, 'utf8').catch(() => '{}'));
  // "$team" names the crew; every other key is an agent override.
  const { $team, ...agents } = file;
  options.team = $team ?? options.team;
  options.rosterOverrides = agents;
}

const state = {
  agents: forceEngine(createRoster(DEFAULT_ROSTER, options.rosterOverrides), options.engine),
  goals: {},
  claims: {},
  events: [],
  awaitingGoals: false,
  mission: options.mission,
  // What the room has noticed and nobody has reported. Derived here rather
  // than in the browser, so the same answer reaches the screen AND anything
  // that can act on it.
  cards: [],
  // What Thor has said about each card, keyed by cardKey so it dies with it.
  verdicts: {},
  governing: false,
  // The shared board. One list of work every agent reads and writes, so
  // coordination stops being prose.
  board: createBoard(),
};

state.goals = deriveGoals(state.goals, state.agents, state.mission);

const store = createStore({ file: join(ROOT, 'data', 'minimac.db') });

// A restart is not new work. If this repo left a run open, rejoin it and take
// back its mission and its goals - otherwise every restart puts the whole
// fleet back to "no goal - this agent would start blind" while the run it
// belongs to is still sitting in the list marked running.
const adopted = store.adoptRun(options.repo);
if (adopted) {
  if (!state.mission && adopted.mission) state.mission = adopted.mission;
  // The mission only arrives here, so the derive at boot ran against an empty
  // one and gave every worker nothing. Derive again now that we know what the
  // run is for - a worker with no goal is the drift this tool exists to stop.
  state.goals = deriveGoals(state.goals, state.agents, state.mission);
  // Saved goals are the truth and outrank anything derived, so they land last.
  for (const row of store.goalsFor(adopted.id)) {
    if (!row.objective) continue;
    state.goals = setGoal(
      state.goals,
      row.agent_id,
      row.objective,
      row.token_budget,
      row.status ?? 'active',
      row.source ?? 'manual',
    );
  }
  // Whatever the run was missing is now written down, so this cannot silently
  // come back as blank goals on the next restart.
  for (const [agentId, goal] of Object.entries(state.goals)) store.saveGoal(agentId, goal);

  // And the run's HISTORY, not just its goals. Without this the monitor was
  // blind to everything before the restart while the browser replayed the lot
  // from the database - so the room could show a loop the server could not
  // see, and no card was ever raised for it.
  state.events = store.replayRun(adopted.id);
  for (const event of state.events) state.agents = applyToAgent(state.agents, event);
  // The sessions those events belonged to are gone. Nobody is running until
  // they are started again, and saying otherwise is the dishonesty this whole
  // tool is against.
  for (const agent of Object.values(state.agents)) {
    state.agents = patchAgent(state.agents, agent.id, {
      status: 'idle', sessionId: null, sessionIds: [], blockedReason: null,
    });
  }
  state.cards = deriveCards(Object.values(state.agents), indexByAgent(state.events), Date.now());
  // The board belongs to the run, so rejoining a run rejoins its work.
  state.board = { items: store.itemsFor(adopted.id) };
}
const worktrees = createWorktrees({ repo: options.repo, root: join(ROOT, 'worktrees') });
const repoIndex = createRepoIndex();
const uploads = createUploads({ dir: join(ROOT, 'data', 'attachments') });
// How this fleet is told to work. Survives runs and restarts.
const middleware = store.middleware();
const getDriver = createDriverRegistry({
  [ENGINES.CODEX]: createCodexDriver({ url: options.codexUrl }),
  [ENGINES.CLAUDE]: createClaudeDriver({}),
  [ENGINES.SIM]: createSimDriver(),
});

for (const engine of Object.values(ENGINES)) {
  getDriver(engine).onEvent(ingest);
}

const subscribers = new Set();

// ---------------------------------------------------------------- ingestion

// An agent's report arrives inside its prose. Pulling it out here means both
// engines produce the same flows and claims without either CLI having to
// support a schema flag.
const REPORT_BLOCK = new RegExp('```' + REPORT_FENCE + '\\s*([\\s\\S]*?)```');
const GOALS_BLOCK = new RegExp('```' + GOALS_FENCE + '\\s*([\\s\\S]*?)```');

// The orchestrator's answer to "what should each of them be doing".
function harvestGoals(event) {
  const match = GOALS_BLOCK.exec(String(event.payload?.text ?? ''));
  if (!match) return;

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return;
  }

  // Who the mission needs. An agent taken off sits it out entirely: startCrew
  // skips anything disabled, so this is the orchestrator sizing its own crew.
  // No crew call is a failed assemble, not a partial one. Silently leaving
  // everyone on is how a two-hero mission ends up with seven idle seats.
  const named = Object.keys(parsed.crew ?? {}).length;
  if (state.awaitingGoals && named === 0) {
    ingest(createEvent(event.agentId, EVENT_KINDS.STATUS, {
      text: 'assemble incomplete: no crew named, so nobody was stood down',
      from: 'you',
    }));
  }

  const crew = [];
  for (const [agentId, wanted] of Object.entries(parsed.crew ?? {})) {
    const agent = state.agents[agentId];
    if (!agent || agent.role === ROLES.ORCHESTRATOR) continue;
    // A number is how many of that hero the work needs; a boolean is one or none.
    const copies = typeof wanted === 'number'
      ? Math.min(4, Math.max(0, Math.round(wanted)))
      : (wanted === true ? 1 : wanted === false ? 0 : null);
    if (copies === null) continue;

    const enabled = copies > 0;
    const instances = Math.max(1, copies);
    if (agent.enabled === enabled && agent.instances === instances) continue;
    state.agents = patchAgent(state.agents, agentId, { enabled, instances });
    crew.push(enabled
      ? `+${agent.label ?? agentId}${instances > 1 ? ` x${instances}` : ''}`
      : `-${agent.label ?? agentId}`);
  }
  if (crew.length) {
    ingest(createEvent(event.agentId, EVENT_KINDS.STATUS, {
      text: `crew for this mission: ${crew.join(' ')}`,
      from: 'you',
    }));
  }

  // The work itself. Anything Thor names here becomes a real item every agent
  // can see, with an owner and a gate chain nobody can walk out of order.
  for (const spec of parsed.items ?? []) {
    if (!spec?.title) continue;
    const owner = state.agents[spec.owner] ? spec.owner : null;
    const result = addItem(state.board, { ...spec, owner });
    if (result.error) continue;
    state.board = result.board;
    store.saveItem(result.item);
    if (result.duplicate) continue; // already on the board
    ingest(createEvent(event.agentId, EVENT_KINDS.STATUS, {
      text: `${result.item.id}: ${result.item.title}`
        + (owner ? ` \u2192 ${state.agents[owner].label ?? owner}` : ' (nobody yet)'),
      from: 'you',
    }));
    // Handing work to somebody is the commonest thing he does, so it is the
    // commonest walk across the floor.
    if (owner) orders(owner, `${result.item.id}: ${result.item.title}`);
  }

  let applied = 0;
  for (const [agentId, objective] of Object.entries(parsed.goals ?? {})) {
    if (!state.agents[agentId] || typeof objective !== 'string' || !objective.trim()) continue;
    state.goals = setGoal(state.goals, agentId, objective.trim(), null, 'active', 'derived');
    store.saveGoal(agentId, getGoal(state.goals, agentId));
    orders(agentId, objective.trim());
    applied += 1;
  }
  if (applied > 0) startCrew(`${event.agentId} set goals for ${applied} agents`);
}

function harvestReport(event) {
  const match = REPORT_BLOCK.exec(String(event.payload?.text ?? ''));
  if (!match) return;

  let report;
  try {
    report = JSON.parse(match[1]);
  } catch {
    return; // a malformed block is not a report; the prose still stands
  }

  // A hero asking for the room. It lands in the same queue as anything the
  // monitor derived, and is governed the same way - two ways in, one way out.
  const plea = report.escalate;
  if (plea?.why && String(plea.why).trim()) {
    ingest(createEvent(event.agentId, EVENT_KINDS.PRAYER, {
      why: String(plea.why).trim(),
      needs: ['decision', 'unblock', 'conflict'].includes(plea.needs) ? plea.needs : 'decision',
    }));
  }

  // An agent taking itself off the floor. It is the counterpart to ASSEMBLE:
  // Thor decides who starts, and each hero decides when it is finished. An
  // idle seat nobody closes is exactly the noise this is against.
  const done = report.standDown;
  if (done?.why && String(done.why).trim()) {
    const why = String(done.why).trim();
    ingest(createEvent(event.agentId, EVENT_KINDS.STATUS, {
      text: `stood down: ${why}`,
      from: 'you',
    }));
    // Its own choice, so it ends its own turn - it is not benched, and START
    // brings it straight back.
    COMMANDS.interrupt({ agentId: event.agentId }).catch(() => {});
  }

  // Gate moves. This is the only way the board changes from a worker, and
  // board.mjs refuses anything out of order or without a receipt - so an agent
  // cannot report a push over untested code however confidently it tries.
  for (const move of report.gates ?? []) {
    const result = advanceGate(state.board, {
      id: move?.item,
      gate: move?.gate,
      state: move?.state,
      receipt: move?.receipt ?? '',
      by: event.agentId,
    });
    if (result.error) {
      ingest(createEvent(event.agentId, EVENT_KINDS.STATUS, {
        text: `gate refused: ${result.error}`,
        from: 'you',
      }));
      continue;
    }
    state.board = result.board;
    store.saveItem(result.item);
    ingest(createEvent(event.agentId, EVENT_KINDS.STATUS, {
      text: `${move.item} ${move.gate}: ${move.state}`,
      from: 'you',
    }));
  }

  if (Array.isArray(report.flows) && report.flows.length > 0) {
    ingest(createEvent(event.agentId, EVENT_KINDS.PLAN, { steps: report.flows }));
  }
  for (const claim of report.claims ?? []) {
    ingest(createEvent(event.agentId, EVENT_KINDS.CLAIM, claim));
  }
}

// Every fenced block an agent may emit. These are payload for the tool, never
// speech: they are parsed here and stripped before anything is shown.
const FENCES = [REPORT_FENCE, GOALS_FENCE, VERDICT_FENCE];

// One reply arrives as several flushes. Splitting each flush on its own fails
// the moment a chunk boundary lands inside the fence marker itself - which is
// how raw JSON reached the floor and how an empty code block was rendered.
//
// So the whole reply is re-split from the start every time and only the NEW
// prose is emitted. A boundary can then fall anywhere and the answer is the
// same, because there is no per-chunk state to get out of step.
const wire = new Map();

function partition(event) {
  if (event.kind !== EVENT_KINDS.MESSAGE) return { event, raw: null };

  const held = wire.get(event.agentId) ?? { buffer: '', shown: 0 };
  const buffer = held.buffer + String(event.payload?.text ?? '');
  const { prose, open } = splitFenced(buffer, FENCES, false);

  // A block that has closed is complete and can be parsed. Nothing is parsed
  // while one is still open, which is why a split report used to be dropped.
  const raw = open ? null : buffer;
  const delta = prose.slice(held.shown).trim();

  if (open) {
    wire.set(event.agentId, { buffer, shown: prose.length });
  } else {
    wire.set(event.agentId, { buffer: '', shown: 0 });
  }

  if (!delta || isMachineNoise(delta)) return { event: null, raw };
  return { event: { ...event, payload: { ...event.payload, text: delta } }, raw };
}

function ingest(incoming) {
  // A result carries its text in its own envelope and is never split, so it
  // goes straight to the parsers.
  if (incoming.kind === EVENT_KINDS.RESULT) {
    state.events = appendEvent(state.events, incoming);
    state.agents = applyToAgent(state.agents, incoming);
    store.record(incoming);
    publish({ type: 'event', event: incoming, agent: state.agents[incoming.agentId] });
    harvestBlocks(incoming);
    scheduleCards();
    return;
  }

  const { event, raw } = partition(incoming);
  // Payload with no prose still has to be parsed - it just is not said aloud.
  if (!event) {
    if (raw) harvestBlocks({ ...incoming, payload: { ...incoming.payload, text: raw } });
    return;
  }
  if (raw !== null) event.payload = { ...event.payload, raw };
  state.events = appendEvent(state.events, event);
  state.agents = applyToAgent(state.agents, event);
  store.record(event);
  publish({ type: 'event', event, agent: state.agents[event.agentId] });
  if (raw !== null) harvestBlocks({ ...event, payload: { ...event.payload, text: raw } });
  scheduleCards();
}

// Thor telling a hero something is an event in the ROOM, not just a row in a
// table: the floor walks him over and has him say it. Every outbound act of
// his goes through here, so a goal, an assignment and a ruling all look the
// same on the floor.
function orders(toAgentId, text) {
  const boss = Object.values(state.agents).find((a) => a.role === ROLES.ORCHESTRATOR);
  if (!boss || !state.agents[toAgentId] || toAgentId === boss.id) return;
  if (!String(text ?? '').trim()) return;
  ingest(createEvent(boss.id, EVENT_KINDS.PING, {
    to: toAgentId,
    toAgentId,
    kind: 'orders',
    text: String(text).trim(),
  }));
}

// Close the open prayer on this agent, if there is one. Recorded as an event
// so the answer is in the run's history beside the question.
function answerPrayer(agentId, text) {
  const open = prayerOf(indexByAgent(state.events)[agentId] ?? []);
  if (!open?.why) return false;
  ingest(createEvent(agentId, EVENT_KINDS.PRAYER, {
    ...open,
    answered: true,
    answer: String(text ?? '').trim(),
  }));
  return true;
}

// A block already parsed is not parsed again. Codex re-sends a completed reply
// as a final event, so the same goals block arrived twice and put every item
// on the board twice.
const harvested = new Map();

// The parsers all read the same reassembled text.
//
// A fenced block can arrive as streamed prose OR inside the final result an
// engine sends when a turn closes - Codex uses the latter for its last word.
// Reading only messages meant a whole assemble answer, crew decision and all,
// was produced and thrown away.
function blockText(event) {
  return String(event.payload?.text ?? event.payload?.report?.text ?? '');
}

function harvestBlocks(event) {
  const text = blockText(event);
  if (!text.includes('```')) return; // nothing fenced, nothing to parse
  const seen = harvested.get(event.agentId);
  if (seen === text) return;
  harvested.set(event.agentId, text);

  // Every parser reads the same normalised text, whichever envelope carried it.
  const carrying = { ...event, payload: { ...event.payload, text } };
  harvestReport(carrying);
  harvestGoals(carrying);
  harvestVerdicts(carrying);
}

// ----------------------------------------------------------------- monitor

// Every event passes through ingest(), so nothing has to poll to know what the
// fleet is doing. Deriving on each one would run the detectors hundreds of
// times a second during a busy turn, so the pass is coalesced.
const CARD_DEBOUNCE_MS = 250;
let cardTimer = null;

function scheduleCards() {
  if (cardTimer) return;
  cardTimer = setTimeout(() => {
    cardTimer = null;
    refreshCards();
  }, CARD_DEBOUNCE_MS);
}

function refreshCards() {
  const before = state.cards;
  const next = deriveCards(
    Object.values(state.agents),
    indexByAgent(state.events),
    Date.now(),
  );
  const { raised, cleared } = diffCards(before, next);
  state.cards = next;

  // A verdict outlives nothing: when the condition clears, so does the ruling.
  for (const card of cleared) delete state.verdicts[cardKey(card)];

  if (raised.length || cleared.length) {
    publish({ type: 'state', state: snapshot() });
    if (raised.length) void governanceTurn(raised);
  }
  return { raised, cleared };
}

// ---------------------------------------------------------------- governance

// The room decides WHEN something is worth a ruling; the orchestrator decides
// WHAT to do about it. He is woken only for cards nobody has seen, batched into
// one turn - a turn per card would cost a turn per card and let him answer the
// same condition three ways.
async function governanceTurn(raised) {
  if (state.governing) return; // one ruling at a time
  // Never interrupt an assemble. That turn IS the plan; cutting into it with a
  // ruling is how the plan came to be abandoned halfway through.
  if (state.awaitingGoals) return;
  const boss = Object.values(state.agents).find((a) => a.role === ROLES.ORCHESTRATOR);
  if (!boss || boss.enabled === false) return;

  // Nothing he could rule on: approvals are never his, nor is anything about
  // himself.
  const his = raised.filter((card) => routeCard(card, null, boss.id).toThor);
  if (his.length === 0) return;

  state.governing = true;
  // Say it on the floor. A ruling happening off-screen is the same as no
  // ruling: you cannot govern what you cannot see being governed.
  ingest(createEvent(boss.id, EVENT_KINDS.STATUS, {
    text: `ruling on ${his.length} card${his.length === 1 ? '' : 's'}: `
      + his.map((card) => `${card.agentName ?? card.agentId} ${card.kind}`).join(', '),
    from: 'you',
  }));
  try {
    const task = governanceTask(his, crewRoster());
    if (boss.sessionId) {
      const sent = await eachSession(boss, (id) =>
        getDriver(boss.engine).steer(
          id,
          composeDispatch(promptContext(boss, task, { exclusiveOutput: true })),
        ));
      if (!sent.delivered) throw new Error(sent.failures[0] ?? 'the engine took nothing');
    } else {
      await COMMANDS.start({ agentId: boss.id, task, exclusiveOutput: true });
    }
  } catch (error) {
    // Never silent. A governance turn that failed is a fleet nobody is
    // watching, and that has to reach you rather than a swallowed catch.
    ingest(createBlockedEvent(boss.id, {
      category: BLOCKED_REASONS.ERROR,
      reason: `could not rule on ${his.length} cards: ${error.message}`,
    }));
  } finally {
    state.governing = false;
  }
}

// His answer, pulled out of his prose like every other block.
function harvestVerdicts(event) {
  const keys = new Set(state.cards.map(cardKey));
  const verdicts = parseVerdicts(event.payload?.text ?? '', { keys });
  if (verdicts.length === 0) return;
  for (const verdict of verdicts) applyVerdict(verdict).catch(() => {});
}

// Only ever the verbs the floor already has, so nothing here can do something
// you could not undo from the room.
async function applyVerdict(verdict) {
  state.verdicts[verdict.id] = verdict;

  const agent = state.agents[verdict.agentId];
  const who = agent?.label ?? verdict.agentId;

  // Holding and escalating are answers, not actions - they only annotate.
  if (verdict.action === VERDICT.HOLD || verdict.action === VERDICT.ESCALATE) {
    ingest(createEvent('minimac', EVENT_KINDS.STATUS, {
      text: `${verdict.action} on ${who}: ${verdict.note || 'no reason given'}`,
      from: 'you',
    }));
    publish({ type: 'state', state: snapshot() });
    return;
  }

  if (verdict.action === VERDICT.STEER) {
    orders(verdict.agentId, verdict.text);
    await COMMANDS.steer({ agentId: verdict.agentId, text: verdict.text }).catch(() => {});
  } else if (verdict.action === VERDICT.GOAL) {
    await COMMANDS.setGoal({ agentId: verdict.agentId, objective: verdict.text });
  } else if (verdict.action === VERDICT.BENCH) {
    await COMMANDS.setEnabled({ agentId: verdict.agentId, enabled: false });
  }
  ingest(createEvent('minimac', EVENT_KINDS.STATUS, {
    text: `${verdict.action} on ${who}: ${verdict.note || verdict.text}`,
    from: 'you',
  }));
  publish({ type: 'state', state: snapshot() });
}

function applyToAgent(agents, event) {
  const agent = agents[event.agentId];
  if (!agent) return agents;
  const next = { ...agent, lastEventTs: event.ts };

  if (event.kind === EVENT_KINDS.STATUS && event.payload.state) {
    next.status = event.payload.state;
  }
  if (event.kind === EVENT_KINDS.PLAN) {
    next.flows = mergeFlows(agent.flows, event.payload.steps ?? []);
  }
  if (event.kind === EVENT_KINDS.DIFF) {
    next.diffLines = event.payload.lines ?? agent.diffLines;
  }
  if (event.kind === EVENT_KINDS.BLOCKED) {
    next.status = 'blocked';
    next.blockedReason = event.payload.reason ?? null;
  }
  return { ...agents, [event.agentId]: next };
}

// Estimates come from the first plan and are never silently rewritten, so a
// later plan cannot quietly move the goalposts.
function mergeFlows(existing, incoming) {
  return incoming.map((step, index) => {
    // A stable flow id keeps an estimate attached to the same promise when an
    // agent inserts or reorders steps. Old engine-native plans may have no id,
    // so their existing index remains the narrow compatibility fallback.
    const previous = step?.id
      ? existing.find((candidate) => candidate?.id === step.id)
      : existing[index];
    return {
      ...step,
      estimateMs: previous?.estimateMs ?? step.estimateMs ?? null,
      actualMs: step.actualMs ?? previous?.actualMs ?? 0,
    };
  });
}

// One seat, one or more workers. Each gets its own session and its own slice
// label, and every event still carries the seat's id - so the floor shows one
// desk while the work runs in parallel behind it.
async function startWorkers(agent, cwd, context) {
  const driver = getDriver(agent.engine);
  const sessionIds = [];

  for (const { prompt } of workerDispatches(context)) {
    sessionIds.push(await driver.start(agent, cwd, prompt));
  }

  state.agents = patchAgent(state.agents, agent.id, { sessionIds });
  return sessionIds[0];
}

// A steer reaches every worker behind the seat, not just the first. It returns
// how many sessions actually took it: swallowing the driver error here is what
// let a message be shown on the floor as delivered while the engine had thrown
// it away - a claim with no receipt, which is the one thing this tool exists
// to stop.
async function eachSession(agent, action) {
  const ids = agent.sessionIds?.length ? agent.sessionIds : [agent.sessionId].filter(Boolean);
  let delivered = 0;
  const failures = [];
  for (const id of ids) {
    try {
      await action(id);
      delivered += 1;
    } catch (error) {
      failures.push(error?.message ?? String(error));
    }
  }
  return { delivered, failures, attempted: ids.length };
}

// What every agent is told about everyone else: who they are, what they are on,
// and what they own.
function crewRoster() {
  return Object.values(state.agents).map((agent) => ({
    id: agent.id,
    label: agent.label ?? agent.name,
    role: agent.role,
    engine: agent.engine,
    instances: agent.instances,
    objective: getGoal(state.goals, agent.id)?.objective ?? '',
    // Whether they are currently ON this mission. Without it the orchestrator
    // is judging who is needed without knowing who is already stood down.
    enabled: agent.enabled !== false,
    claims: state.claims[agent.id] ?? [],
  }));
}

// Every first dispatch and every steer reads the same live state through this
// one context builder. A caller may change the task or select an exclusive
// output fence, but it cannot silently omit the board, goal, crew, or history.
function promptContext(agent, task, {
  mentions = null,
  attachments = [],
  exclusiveOutput = false,
} = {}) {
  return {
    agent,
    goal: getGoal(state.goals, agent.id),
    task: task ?? state.mission,
    skills: options.skills,
    claims: state.claims[agent.id] ?? [],
    steps: agent.flows ?? [],
    board: state.board,
    mentions,
    attachments: [...(state.attachments ?? []), ...attachments],
    crew: crewRoster(),
    team: options.team,
    hook: options.hookText,
    overrides: middleware,
    exclusiveOutput,
  };
}

// What a step currently says: the override if there is one, otherwise the
// built-in default, otherwise whatever was loaded from a file at launch.
function middlewareText(name) {
  if (typeof middleware[name] === 'string') return middleware[name];
  if (name === 'hook') return options.hookText ?? '';
  return defaultStepText(name);
}

const PLANNING_TIMEOUT_MS = 180_000;

// Start everyone except the orchestrator, which is already running.
function startCrew(note, assembled = true) {
  if (!state.awaitingGoals) return;
  state.awaitingGoals = false;
  ingest(
    createEvent('minimac', EVENT_KINDS.STATUS, {
      text: note ?? 'goals set by the orchestrator - starting the crew',
      from: 'you',
    }),
  );
  // An assemble that timed out has decided nothing. Starting the whole fleet
  // on role defaults is not a safe fallback - it is the seven idle seats you
  // pressed ASSEMBLE to avoid. Say so and start nobody.
  if (!assembled) {
    ingest(createEvent('minimac', EVENT_KINDS.BLOCKED, {
      reason: 'assemble produced no crew - nobody was started. Press ASSEMBLE again, '
        + 'or START ALL to run everyone on their role defaults.',
    }));
    return;
  }
  for (const agent of Object.values(state.agents)) {
    if (agent.role === 'orchestrator' || agent.sessionId) continue;
    if (agent.enabled === false) continue; // taken off this mission
    COMMANDS.start({ agentId: agent.id }).catch(() => {});
  }
}

// Agents read files from disk, so an attachment travels as a path plus enough
// description that the agent knows why it was given one.
function attachmentLines(attachments) {
  const lines = attachments.map((file) => `- ${file.path}  (${file.type}, ${file.name})`);
  return `Attached by the operator - open these before you begin:\n${lines.join('\n')}`;
}

// The only way to change one agent. Always reads the current record, so a
// long await can never resurrect a stale copy over it.
function patchAgent(agents, agentId, changes) {
  const current = agents[agentId];
  if (!current) return agents;
  return { ...agents, [agentId]: { ...current, ...changes } };
}

// ----------------------------------------------------------------- commands

const COMMANDS = {
  // One mission in, a goal on every seat out. Nothing is ever dispatched blind.
  async setMission({ mission, attachments = [] }) {
    state.mission = mission;
    ensureRun();
    state.attachments = attachments;
    // The run is titled by its mission, and the mission usually arrives after
    // the run has started, so the record has to be told.
    store.renameRun(mission);
    state.goals = deriveGoals(state.goals, state.agents, mission);
    // The orchestrator's goal is the mission, always. A goal saved on an
    // earlier run - or the old role template - must never outrank the sentence
    // you just typed, which is exactly what happened while this was derived
    // like everyone else's.
    const boss = Object.values(state.agents).find((a) => a.role === ROLES.ORCHESTRATOR);
    if (boss) {
      state.goals = setGoal(state.goals, boss.id, mission, null, 'active', 'manual');
    }
    for (const [agentId, goal] of Object.entries(state.goals)) store.saveGoal(agentId, goal);
    // Say it out loud on the floor, so a submit is never silent.
    ingest(
      createEvent('minimac', EVENT_KINDS.MESSAGE, {
        text: `mission set: ${mission}`,
        attachments,
        from: 'you',
      }),
    );
    // A new mission is a new crew. Setting a goal on Thor lands here too, so
    // every route into "here is the work" assembles - there is one assemble
    // path, not a copy of it inlined per caller.
    // The role templates above are only a floor, so nothing is ever goal-less
    // if the assemble turn fails or times out.
    await COMMANDS.assemble().catch(() => {});
    return { mission, goals: state.goals, planning: true };
  },

  // ASSEMBLE. Thor decides who this mission actually needs, brings them on,
  // stands the rest down, and gives each of the chosen a goal. Same turn that
  // setMission runs, on demand - so you can re-assemble after the mission
  // changes shape, or after you have flipped agents by hand and want Thor to
  // judge it again.
  async assemble() {
    if (!state.mission) throw new Error('set the mission first - there is nobody to assemble for');
    const orchestrator = Object.values(state.agents).find((a) => a.role === 'orchestrator');
    if (!orchestrator) throw new Error('no orchestrator on the floor');
    if (orchestrator.enabled === false) {
      throw new Error(`${orchestrator.label ?? 'the orchestrator'} is off this mission`);
    }
    ensureRun();
    ingest(createEvent(orchestrator.id, EVENT_KINDS.STATUS, {
      text: 'assembling: deciding who this mission needs, and standing the rest down',
      from: 'you',
    }));
    // Assembling is its OWN turn. Steering the brief into a session already
    // deep in mission work is why he never once answered it: he was pushing a
    // branch and the planning instruction arrived as an aside. Ending that turn
    // first makes the brief the whole of what he is being asked.
    if (orchestrator.sessionId) {
      await COMMANDS.interrupt({ agentId: orchestrator.id });
    }
    state.awaitingGoals = true;
    await COMMANDS.start({
      agentId: orchestrator.id,
      task: planningTask(state.mission, crewRoster()),
      planning: true,
    });
    // If nothing comes back, the crew still starts - late beats never.
    setTimeout(() => {
      if (state.awaitingGoals) startCrew('the orchestrator did not set goals in time', false);
    }, PLANNING_TIMEOUT_MS);
    return { planning: true };
  },

  // A run is a conversation with the fleet. Starting a new one closes the old
  // record and resets the floor; the old one stays readable in the database.
  // Stop everything without losing it: agents are interrupted, the run is
  // closed in the record, and what happened stays on screen to be read.
  async stopRun() {
    const stopped = [];
    for (const agent of Object.values(state.agents)) {
      if (!agent.sessionId) continue;
      await getDriver(agent.engine).interrupt(agent.sessionId).catch(() => {});
      state.agents = patchAgent(state.agents, agent.id, { status: 'stopped', sessionId: null });
      stopped.push(agent.id);
    }
    ingest(
      createEvent('minimac', EVENT_KINDS.STATUS, {
        state: 'idle',
        text: stopped.length ? `run stopped: ${stopped.join(', ')}` : 'run stopped',
        from: 'you',
      }),
    );
    store.finishRun();
    return { stopped };
  },

  // Continue an old run: the SAME conversations, picked up where they stopped.
  // The agents keep everything they already worked out, which is the whole
  // difference between continuing and starting over.
  async continueRun({ runId, note }) {
    const previous = store.getRun(Number(runId));
    if (!previous) throw new Error(`no run ${runId}`);

    // Continue always continues. Where a session survives, the agent keeps its
    // memory; where it does not, that agent starts fresh on the same goal and
    // the feed says which ones lost their thread. A dead button is never the
    // right answer.
    const sessions = new Map(
      store.sessionsFor(Number(runId)).map((row) => [row.agent_id, row.session_id]),
    );

    // Continuing opens a NEW run record carrying the old mission, so the fleet
    // has one current run and the history stays honest about what happened when.
    store.finishRun();
    state.events = [];
    state.mission = previous.mission;
    store.startRun(state.mission, options.repo);
    for (const agent of Object.values(state.agents)) store.saveEngine(agent.id, agent.engine);

    for (const row of store.goalsFor(Number(runId))) {
      if (row.objective) {
        state.goals = setGoal(state.goals, row.agent_id, row.objective, row.token_budget, 'active', 'manual');
      }
    }

    const prompt = note
      ?? 'Continue where you left off. Restate in one line what you were doing, then carry on.';
    const resumed = [];
    const restarted = [];

    for (const agent of Object.values(state.agents)) {
      const previousSession = sessions.get(agent.id);
      const driver = getDriver(agent.engine);
      try {
        if (!previousSession) throw new Error('no session recorded');
        if (typeof driver.resume !== 'function') throw new Error('engine cannot resume');
        const sessionId = await driver.resume(
          agent,
          options.repo,
          previousSession,
          composeDispatch(promptContext(agent, prompt)),
        );
        state.agents = patchAgent(state.agents, agent.id, { sessionId, status: 'running' });
        store.saveSession(agent.id, sessionId, agent.engine);
        resumed.push(agent.id);
      } catch {
        await COMMANDS.start({ agentId: agent.id }).catch(() => {});
        restarted.push(agent.id);
      }
    }

    ingest(
      createEvent('minimac', EVENT_KINDS.STATUS, {
        text: `continued run ${runId}: resumed ${resumed.join(', ') || 'none'}`
          + (restarted.length
            ? ` · no session to resume, started fresh: ${restarted.join(', ')}`
            : ''),
        from: 'you',
      }),
    );
    return { resumed, restarted };
  },

  // Run an old one again: its mission and the goals as they were, in a fresh
  // run record so the original stays intact and comparable.
  // RUN AGAIN: same mission and goals, from nothing. Its board starts empty too.
  async resumeRun({ runId }) {
    const previous = store.getRun(Number(runId));
    if (!previous) throw new Error(`no run ${runId}`);

    const saved = store.goalsFor(Number(runId));
    await COMMANDS.newRun({ mission: previous.mission, autoStart: false });

    for (const row of saved) {
      if (!row.objective) continue;
      state.goals = setGoal(
        state.goals,
        row.agent_id,
        row.objective,
        row.token_budget,
        'active',
        'manual', // it was chosen for that run, so it is not re-derived here
      );
      store.saveGoal(row.agent_id, getGoal(state.goals, row.agent_id));
    }

    for (const agent of Object.values(state.agents)) {
      await COMMANDS.start({ agentId: agent.id }).catch(() => {});
    }
    return { from: Number(runId), runId: store.runId, mission: previous.mission };
  },

  async newRun({ mission, autoStart = true }) {
    for (const agent of Object.values(state.agents)) {
      if (agent.sessionId) await getDriver(agent.engine).interrupt(agent.sessionId).catch(() => {});
    }
    store.finishRun();
    state.agents = forceEngine(createRoster(DEFAULT_ROSTER, options.rosterOverrides), options.engine);
    state.goals = {};
    state.claims = {};
    state.events = [];
    // A new mission starts with an empty board. The last mission's work is kept
    // in the record but must not be handed to this crew as though it were
    // theirs - which is how a LICENSE plan turned up under a CI mission.
    state.board = createBoard();
    state.cards = [];
    state.verdicts = {};
    state.mission = mission ?? '';
    const id = store.startRun(state.mission, options.repo);
    state.goals = deriveGoals(state.goals, state.agents, state.mission);
    for (const [agentId, goal] of Object.entries(state.goals)) store.saveGoal(agentId, goal);
    for (const agent of Object.values(state.agents)) store.saveEngine(agent.id, agent.engine);
    if (autoStart && state.mission) {
      for (const agent of Object.values(state.agents)) {
        await COMMANDS.start({ agentId: agent.id }).catch(() => {});
      }
    }
    return { runId: id, mission: state.mission };
  },

  async start({
    agentId,
    task,
    mentions = null,
    attachments = [],
    planning = false,
    exclusiveOutput = planning,
  }) {
    if (state.agents[agentId]?.enabled === false) return { skipped: 'disabled' };
    ensureRun();
    const agent = state.agents[agentId];
    const goal = getGoal(state.goals, agentId);
    if (!goal?.objective) throw new Error(`${agentId} has no goal - set the mission first`);
    const cwd = options.isolate ? await worktrees.create(agentId) : options.repo;
    const context = promptContext(agent, task ?? state.mission, {
      mentions,
      attachments,
      // A planning turn owns the goals fence. Do not add the report fence.
      exclusiveOutput,
    });
    let sessionId;
    try {
      sessionId = await startWorkers(agent, cwd, context);
    } catch (error) {
      ingest(
        createBlockedEvent(agentId, {
          category: BLOCKED_REASONS.ERROR,
          reason: `${agent.engine} could not start: ${error.message}`,
        }),
      );
      throw error;
    }
    // Re-read: events arriving during the await already changed this agent.
    state.agents = patchAgent(state.agents, agentId, { sessionId, status: 'running' });
    store.saveSession(agentId, sessionId, agent.engine);
    return { sessionId, workers: agent.instances };
  },

  // The composer's single verb. One line of text, whatever it names, ends up
  // in exactly one place: the mission, or one agent.
  async say({ target, text, attachments = [] }) {
    const parsed = parseMentions(text, { agentIds: Object.keys(state.agents) });
    // A pasted path is an attachment, so dragging a file in and pasting its
    // path behave the same way.
    for (const path of await repoIndex.existingPaths(text)) {
      if (!attachments.some((file) => file.path === path)) {
        attachments = [...attachments, { path, name: path.split('/').pop(), type: 'file' }];
      }
    }
    if (parsed.files.length > 0 && target !== 'mission') {
      await COMMANDS.claim({ agentId: routeOf(parsed, target), patterns: parsed.files });
    }
    if (target === 'mission') return COMMANDS.setMission({ mission: text, attachments });

    // POLICY. One sentence that binds the whole fleet, forever. It is written
    // into the standing instruction, which the prompt pipeline adds to every
    // dispatch AND every steer - so no model decides whether it applies, and
    // an agent started an hour from now is bound by it too.
    if (target === 'policy') {
      const rule = String(text ?? '').trim();
      if (!rule) throw new Error('a policy needs something to say');
      const standing = middlewareText('hook');
      const next = standing?.trim() ? `${standing.trim()}\n- ${rule}` : `- ${rule}`;
      await COMMANDS.setMiddleware({ name: 'hook', text: next });
      ingest(createEvent('minimac', EVENT_KINDS.STATUS, {
        text: `policy, binding on everyone from now on: ${rule}`,
        from: 'you',
      }));
      return { policy: next };
    }

    // THOR. Said once; he decides who needs it and in what words.
    if (target === 'thor') {
      const boss = Object.values(state.agents).find((a) => a.role === ROLES.ORCHESTRATOR);
      if (!boss) throw new Error('no orchestrator on the floor');
      const brief = [
        '# Pass this on',
        '',
        'Mac said this once, to you, for the whole crew:',
        '',
        text,
        '',
        'Decide who actually needs to hear it and what it means for each of them. '
        + 'Say nothing to anyone it does not concern. Answer with the goals block, '
        + 'setting only the goals you are changing.',
      ].join('\n');
      return COMMANDS.say({ target: boss.id, text: brief, attachments });
    }

    const agentId = routeOf(parsed, target);
    const agent = state.agents[agentId];
    if (!agent) throw new Error(`unknown agent: ${agentId}`);
    ingest(createEvent(agentId, EVENT_KINDS.MESSAGE, { text, from: 'you', attachments }));
    const body = attachments.length > 0 ? `${text}\n\n${attachmentLines(attachments)}` : text;
    return agent.sessionId
      ? COMMANDS.steer({ agentId, text: body })
      : COMMANDS.start({ agentId, task: text, mentions: parsed, attachments });
  },

  // Make the orchestrator say something to a hero. The floor walks him over.
  // Used by ASSEMBLE, by his rulings, and by nothing else in normal operation.
  async orders({ agentId, text }) {
    if (!state.agents[agentId]) throw new Error(`unknown agent: ${agentId}`);
    orders(agentId, text);
    return { to: agentId };
  },

  // The working folder is a live setting, not a launch-only flag.
  // Rewrite one middleware step. It takes effect on the next dispatch and on
  // every steer, and it outlives the run.
  async setMiddleware({ name, text }) {
    if (!EDITABLE_STEPS.includes(name)) throw new Error(`${name} is not editable`);
    middleware[name] = text;
    store.saveMiddleware(name, text);
    return { name, text };
  },

  async resetMiddleware({ name }) {
    delete middleware[name];
    store.saveMiddleware(name, null);
    return { name, text: middlewareText(name) };
  },

  async setRepo({ dir }) {
    const verdict = await repoIndex.check(dir);
    if (!verdict.ok) throw new Error(`${dir}: ${verdict.reason}`);
    options.repo = dir;
    return { repo: dir, git: verdict.git };
  },

  // Pressing a button beats typing prose: the engine gets the exact decision it
  // offered. Engines without an approval protocol fall back to steering.
  async approve({ agentId, approvalId, decision }) {
    const agent = state.agents[agentId];
    if (!agent?.sessionId) throw new Error(`${agentId} is not running`);
    const driver = getDriver(agent.engine);
    if (typeof driver.approve === 'function') {
      await driver.approve(agent.sessionId, approvalId, decision);
    } else {
      await driver.steer(
        agent.sessionId,
        composeDispatch(promptContext(agent, String(decision))),
      );
    }
    ingest(createEvent(agentId, EVENT_KINDS.STATUS, { approvalId, decision, from: 'you' }));
    return {};
  },

  // A prayer stays open through a conversation. Only the operator can close
  // it, and closing it is recorded beside the question and its replies.
  async settlePrayer({ agentId }) {
    if (!state.agents[agentId]) throw new Error(`no agent ${agentId}`);
    if (!answerPrayer(agentId, 'settled by Mac')) {
      throw new Error(`${agentId} has no open question`);
    }
    refreshCards();
    return { settled: true };
  },

  async steer({ agentId, text }) {
    const agent = state.agents[agentId];
    if (!agent) throw new Error(`no agent ${agentId}`);
    // A reply does NOT close the question. You asked to be able to go back and
    // forth, and a card that vanishes on your first sentence ends the
    // conversation for you. It closes when you say it is settled.
    if (!agent.sessionId) {
      // The answer is already recorded above, so say what happened rather than
      // pretending nothing did: the card is closed, the agent never heard it.
      throw new Error(
        `${agent.label ?? agentId} has no live session${
          agent.blockedReason ? ` - ${agent.blockedReason}` : ''
        }. Your answer is on the record; press START for them to hear it.`,
      );
    }
    const sent = await eachSession(agent, (id) =>
      getDriver(agent.engine).steer(
        id,
        composeDispatch(promptContext(agent, text)),
      ));
    // Only what the engine took is written to the floor.
    if (!sent.delivered) {
      throw new Error(
        `${agent.label ?? agentId} did not take that: ${sent.failures[0] ?? 'the engine is gone'}`,
      );
    }
    ingest(createEvent(agentId, EVENT_KINDS.MESSAGE, { text, from: 'you' }));
    return { delivered: sent.delivered };
  },

  // KILL. Stops this agent's turn now: the Claude child is killed, a Codex turn
  // is interrupted, and the seat is cleared so START gives you a fresh one. The
  // agent stays on the floor - this ends the work, not the worker.
  async interrupt({ agentId }) {
    const agent = state.agents[agentId];
    if (!agent) throw new Error(`no agent ${agentId}`);
    answerPrayer(agentId, 'stopped by Mac');
    const had = agent.sessionIds?.length || (agent.sessionId ? 1 : 0);
    if (had) await eachSession(agent, (id) => getDriver(agent.engine).interrupt(id));
    state.agents = patchAgent(state.agents, agentId, {
      status: 'stopped', sessionId: null, sessionIds: [],
    });
    // Their conditions died with the turn. Leaving cards up for an agent who
    // has stopped is asking you to decide about something that is already over.
    refreshCards();
    return {};
  },

  async setGoal({ agentId, objective, tokenBudget, status }) {
    // Giving the orchestrator a goal IS giving the fleet a mission - it would
    // be strange to write "get the repos pushed" on Thor and have the rest of
    // the crew sit there with nothing.
    if (state.agents[agentId]?.role === ROLES.ORCHESTRATOR && objective?.trim()) {
      return COMMANDS.setMission({ mission: objective.trim() });
    }
    state.goals = setGoal(state.goals, agentId, objective, tokenBudget, status);
    store.saveGoal(agentId, getGoal(state.goals, agentId));
    const agent = state.agents[agentId];
    if (agent?.sessionId) {
      const message = `Your goal changed. From now on: ${objective}`;
      const sent = await eachSession(agent, async (id) => {
        const driver = getDriver(agent.engine);
        await driver.setGoal(id, objective, tokenBudget, status);
        await driver.steer(id, composeDispatch(promptContext(agent, message)));
      });
      if (!sent.delivered) {
        throw new Error(`${agent.label ?? agentId} did not receive the changed goal`);
      }
    }
    return { goal: getGoal(state.goals, agentId) };
  },

  async clearGoal({ agentId }) {
    state.goals = clearGoal(state.goals, agentId);
    store.saveGoal(agentId, null);
    return {};
  },

  // Scale a seat: two Ironmen behind one desk, each on its own slice.
  async setInstances({ agentId, instances }) {
    const agent = state.agents[agentId];
    if (!agent) throw new Error(`unknown agent: ${agentId}`);
    const count = Math.min(4, Math.max(1, Number(instances) || 1));
    state.agents = patchAgent(state.agents, agentId, { instances: count });
    return { agentId, instances: count };
  },

  async setEnabled({ agentId, enabled }) {
    // Benching clears their cards too - see interrupt.
    const agent = state.agents[agentId];
    if (!agent) throw new Error(`unknown agent: ${agentId}`);
    if (!enabled && agent.sessionId) await COMMANDS.interrupt({ agentId });
    state.agents = patchAgent(state.agents, agentId, { enabled: !!enabled });
    return { agentId, enabled: !!enabled };
  },

  async assignEngine({ agentId, engine }) {
    state.agents = assignEngine(state.agents, agentId, engine);
    store.saveEngine(agentId, engine);
    return { engine };
  },

  async claim({ agentId, patterns }) {
    const result = claimFiles(state.claims, agentId, patterns);
    state.claims = result.claims;
    if (result.granted) store.saveClaims(agentId, patterns);
    return result;
  },

  async release({ agentId }) {
    state.claims = releaseClaim(state.claims, agentId);
    store.saveClaims(agentId, []);
    return {};
  },
};

async function handleCommand(cmd) {
  const command = COMMANDS[cmd.type];
  if (!command) throw new Error(`unknown command: ${cmd.type}`);
  const result = await command(cmd);
  publish({ type: 'state', state: snapshot() });
  return result;
}

// -------------------------------------------------------------------- wire

function snapshot() {
  return {
    agents: state.agents,
    goals: state.goals,
    claims: state.claims,
    mission: state.mission,
    repo: options.repo,
    runId: store.runId,
    // Every card carries whatever Thor said about it. Nothing is hidden.
    cards: state.cards.map((card) => ({
      ...card,
      verdict: state.verdicts[cardKey(card)] ?? null,
    })),
    board: itemsOf(state.board),
    velocity: boardProgress(state.board),
    schema: buildOutputSchema(),
  };
}

function publish(message) {
  const frame = `data: ${JSON.stringify(message)}\n\n`;
  for (const res of subscribers) res.write(frame);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/events') return subscribe(res);
  if (url.pathname === '/cmd' && req.method === 'POST') return command(req, res);
  if (url.pathname === '/upload' && req.method === 'POST') return upload(req, res);
  if (url.pathname === '/history') {
    const agentId = url.searchParams.get('agent');
    return json(res, 200, { events: eventsFor(state.events, agentId) });
  }
  if (url.pathname === '/files') {
    const found = await repoIndex.search(options.repo, url.searchParams.get('q') ?? '', 20);
    return json(res, 200, { files: found });
  }
  // An uploaded file, read back for display. Confined to the attachments
  // directory so a crafted path cannot read anything else.
  if (url.pathname === '/attachment') {
    const wanted = resolve(String(url.searchParams.get('path') ?? ''));
    const root = join(ROOT, 'data', 'attachments');
    if (!wanted.startsWith(root)) return json(res, 403, { error: 'forbidden' });
    return serveStatic(wanted.slice(ROOT.length), res);
  }
  if (url.pathname === '/dirs') {
    return json(res, 200, await repoIndex.dirs(url.searchParams.get('path') ?? ''));
  }
  if (url.pathname === '/middleware') {
    return json(res, 200, {
      order: dispatchPipeline().names(),
      steps: EDITABLE_STEPS.map((name) => ({
        name,
        text: middlewareText(name),
        overridden: typeof middleware[name] === 'string',
      })),
    });
  }
  if (url.pathname === '/skills') {
    return json(res, 200, { skills: await repoIndex.skills(options.repo) });
  }
  if (url.pathname === '/runs') {
    return json(res, 200, { runs: store.listRuns(Number(url.searchParams.get('limit') ?? 20)) });
  }
  if (url.pathname === '/replay') {
    const runId = Number(url.searchParams.get('run'));
    const agentId = url.searchParams.get('agent');
    const events = agentId ? store.replay(runId, agentId) : store.replayRun(runId);
    return json(res, 200, { events });
  }
  return serveStatic(url.pathname, res);
});

function subscribe(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  subscribers.add(res);
  res.write(`data: ${JSON.stringify({ type: 'state', state: snapshot() })}\n\n`);
  res.on('close', () => subscribers.delete(res));
}

async function command(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    const result = await handleCommand(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    json(res, 200, { ok: true, result });
  } catch (error) {
    json(res, 400, { ok: false, error: error.message });
  }
}

async function upload(req, res) {
  try {
    const name = decodeURIComponent(String(req.headers['x-filename'] ?? 'file'));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const saved = await uploads.save(name, Buffer.concat(chunks), store.runId);
    json(res, 200, { ok: true, file: saved });
  } catch (error) {
    json(res, 400, { ok: false, error: error.message });
  }
}

async function serveStatic(pathname, res) {
  // Asset paths contain spaces ("Models/GLTF format"), so decode before joining.
  const decoded = decodeURIComponent(pathname);
  const relative = normalize(decoded === '/' ? '/floor.html' : decoded).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, relative);
  if (!file.startsWith(ROOT)) return json(res, 403, { error: 'forbidden' });
  try {
    const body = await readFile(file);
    const type = extname(file);
    // Code changes constantly while this is being built; a cached module means
    // the user is looking at a version that no longer exists. Assets may cache.
    const volatile = type === '.mjs' || type === '.js' || type === '.html' || type === '.css';
    res.writeHead(200, {
      'content-type': MIME[type] ?? 'application/octet-stream',
      'cache-control': volatile ? 'no-store, must-revalidate' : 'public, max-age=3600',
    });
    res.end(body);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// One engine for every seat, for a demo or a bake-off. Without it each agent
// keeps the engine set on the roster.
function forceEngine(agents, engine) {
  if (!engine) return agents;
  return Object.fromEntries(
    Object.entries(agents).map(([id, agent]) => [id, { ...agent, engine }]),
  );
}

function parseArgs(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) flags.set(argv[i].slice(2), argv[i + 1] ?? true);
  }
  return {
    port: Number(flags.get('port') ?? 4600),
    repo: resolve(String(flags.get('repo') ?? process.cwd())),
    codexUrl: String(flags.get('codex-url') ?? 'ws://127.0.0.1:4573'),
    // --contract still names the file the standing instruction is seeded from.
    contractPath: flags.get('contract') ? String(flags.get('contract')) : null,
    hookPath: flags.get('hook') ? String(flags.get('hook')) : null,
    hookText: '',
    skills: String(flags.get('skills') ?? '').split(',').filter(Boolean),
    isolate: flags.get('isolate') === true || flags.get('isolate') === 'true',
    mission: String(flags.get('mission') ?? ''),
    engine: flags.get('engine') ? String(flags.get('engine')) : null,
    rosterPath: flags.get('roster') ? String(flags.get('roster')) : null,
    team: String(flags.get('team') ?? 'the Avengers'),
    rosterOverrides: {},
  };
}

// Appended to every message to every agent, first dispatch and every steer.
if (options.hookPath) {
  options.hookText = await readFile(options.hookPath, 'utf8').catch(() => '');
}

// The engineering contract is a property of the REPO, not of how the server was
// launched. Requiring --contract meant it was silently absent every time it was
// forgotten - which was every time.
const CONTRACT_FILES = [
  '.codex/ENGINEERING_CONTRACT.md',
  '.claude/ENGINEERING_CONTRACT.md',
  'ENGINEERING_CONTRACT.md',
];

async function findContract(repo, explicit) {
  if (explicit) {
    return { text: await readFile(explicit, 'utf8').catch(() => ''), from: explicit };
  }
  for (const name of CONTRACT_FILES) {
    const path = join(repo, name);
    const text = await readFile(path, 'utf8').catch(() => null);
    if (text?.trim()) return { text, from: path };
  }
  return { text: '', from: null };
}

const contract = await findContract(options.repo, options.contractPath);
// The repo's engineering contract IS the standing instruction. There is one
// channel, and this is what it starts with; POLICY appends to the same text.
options.contractFrom = contract.from;
options.hookText = [options.hookText, contract.text].filter((part) => part?.trim()).join('\n\n');

// A run is created when work actually begins, not when the server boots -
// otherwise every restart leaves an empty "unnamed run" in the history.
function ensureRun() {
  if (store.runId !== null) return store.runId;
  const id = store.startRun(state.mission, options.repo);
  for (const agent of Object.values(state.agents)) store.saveEngine(agent.id, agent.engine);
  return id;
}

// A restart is NOT the end of a run: closing it here is what made every
// restart lose the mission and leave the whole crew goal-less, because there
// was no open run left to rejoin. Only STOP ends a run.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => process.exit(0));
}

// Codex agents need a daemon listening before they can start. Bringing it up
// here means a blocked crew is never waiting on a command in another terminal.
// Nothing is adopted: a daemon that is already running stays running when we
// exit, and one we started dies with us.
async function ensureEngines() {
  const wanted = Object.values(state.agents).some((agent) => agent.engine === ENGINES.CODEX);
  if (!wanted) return;
  const result = await ensureCodexServer({
    url: options.codexUrl,
    onLog: (line) => process.stdout.write(`codex: ${line}\n`),
  });
  process.stdout.write(`codex app-server: ${result.reason}\n`);
  if (result.ok && result.started) {
    process.on('exit', () => result.stop?.());
  }
  if (!result.ok) {
    // Said on the floor as well as the terminal: a crew that cannot start is a
    // decision, not a log line.
    ingest(createEvent('minimac', EVENT_KINDS.STATUS, {
      text: `codex is not available - ${result.reason}`,
      from: 'you',
    }));
  }
}

server.listen(options.port, async () => {
  process.stdout.write(
    `minimac on http://127.0.0.1:${options.port}  repo=${options.repo}\n`,
  );
  process.stdout.write(
    options.contractFrom
      ? `engineering contract: ${options.contractFrom}\n`
      : 'engineering contract: NONE FOUND - agents are working without one\n',
  );
  await ensureEngines();
});
