// Composition root for the view. Subscribes to the server, derives the view
// model with the same core functions the server uses, and hands it to the
// room, the docked windows and the composer. No rules live here.

import { EVENT_KINDS } from '../core/events.mjs';
import {
  agentPose,
  detectLoops,
  eventsPerMin,
  agentBurn,
  fleetBurn,
  gradeClaims,
  pendingDecisions,
  stepTimings,
} from '../core/derive.mjs';
import { remaining } from '../core/flows.mjs';
import {
  createQueue as createErrands,
  enqueue as enqueueErrand,
  advance as advanceErrands,
  waypointFor as errandWaypoint,
  speaker as errandSpeaker,
  spoken as errandSpoken,
  ERRAND,
} from '../core/errands.mjs';
import { createScene, deskSpot } from './scene.mjs';
import { seatOf } from './layout.mjs';
import * as panels from './panels.mjs';
import { renderQueue, renderRoster, renderFlows, renderEvidence } from './panels.mjs';
import { createComposer, MISSION_TARGET, SPEAK_TARGETS } from './composer.mjs';
import { createSidePanel } from './sidepanel.mjs';
import { createGoalStrip } from './goalstrip.mjs';
import { createSound } from './sound.mjs';
import { renderMarkdown, markdownReady } from './markdown.mjs';
import { CUES, cueFor, keyOf, neglect, trackWaiting } from '../core/attention.mjs';
import {
  describeEvent,
  firstLine,
  plainText,
  shortenDetail,
  summariseCommand,
  isMachineNoise,
  FEED_PRESETS,
  passesPreset,
  doingWords,
} from '../core/readable.mjs';

const PULSE_MS = 900;
const PING_MS = 700;
const PANEL_THROTTLE_MS = 150;
const RUNS_REFRESH_MS = 3000;

const dom = pickDom();

const state = {
  agents: {},
  goals: {},
  claims: {},
  cards: null,
  board: [],
  velocity: null,
  // Orders being carried across the floor, one at a time.
  errands: createErrands(),
  errandPhase: null,
  hovered: null,
  feedPreset: 'all',
  // Which hero's question you are answering. A prayer is a conversation, not
  // a one-line reply typed into a card that then vanishes.
  prayerWith: null,
  repo: '',
  eventsByAgent: {},
  focus: null,
  target: MISSION_TARGET,
  startedAt: Date.now(),
  pulses: [],
  pings: [],
  moves: [],
  open: new Set(),
  runs: [],
  runId: null,
  mission: '',
  feedFilter: null,
  // When each unanswered decision was first seen, and what ignoring them has
  // cost so far. core/attention.mjs owns both rules; this only holds the
  // record it hands back.
  waiting: {},
  neglect: 0,
};

const palette = readPalette();
let scene = null;
let composer = null;
let strip = null;
const sound = createSound();

// ------------------------------------------------------------------ server

// Names for what you just did, so an action is never silent. One place, so
// every button reads the same way in the feed.
const ACTION_WORDS = Object.freeze({
  start: 'start', interrupt: 'kill', say: 'send', steer: 'steer',
  approve: 'answer', setGoal: 'set goal', clearGoal: 'clear goal',
  assignEngine: 'switch engine', setMission: 'set mission', newRun: 'new run',
  continueRun: 'continue run', resumeRun: 'run again', stopRun: 'stop run',
  setRepo: 'change folder', claim: 'claim files', release: 'release files',
  setMiddleware: 'edit middleware', resetMiddleware: 'reset middleware',
  assemble: 'assemble', settlePrayer: 'settle',
});

async function send(type, payload = {}) {
  const who = payload.agentId ?? payload.target;
  const label = ACTION_WORDS[type] ?? type;
  ingest(createLocalEvent(who && state.agents[who] ? who : 'minimac', EVENT_KINDS.STATUS, {
    text: `you: ${label}${who && state.agents[who] ? ` → ${state.agents[who].label}` : ''}`,
    from: 'you',
  }));
  schedulePanels();

  const response = await fetch('/cmd', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type, ...payload }),
  });
  const body = await response.json();
  if (!body.ok) {
    note(body.error);
    // The top bar is easy to miss, so a refusal is also said out loud in the
    // feed - a button that silently does nothing is the worst outcome here.
    ingest(createLocalEvent('minimac', EVENT_KINDS.BLOCKED, {
      reason: `${type} refused: ${body.error}`,
    }));
    schedulePanels();
  }
  return body;
}

function subscribe() {
  const source = new EventSource('/events');
  source.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.type === 'state') applySnapshot(data.state);
    if (data.type === 'event') ingest(data.event, data.agent);
    schedulePanels();
  };
}

function applySnapshot(snapshot) {
  state.agents = snapshot.agents;
  noticeHandouts(state.goals, snapshot.goals);
  state.goals = snapshot.goals;
  state.claims = snapshot.claims;
  state.cards = snapshot.cards ?? null;
  state.board = snapshot.board ?? state.board;
  state.velocity = snapshot.velocity ?? state.velocity;
  state.repo = snapshot.repo ?? state.repo;
  state.mission = snapshot.mission ?? state.mission;
  state.runId = snapshot.runId;
  if (state.runId && !seeded) {
    seeded = true;
    seedFromRun(state.runId);
  }
  // Nothing is selected at boot: the first thing you see is the whole room,
  // not one desk already pushed into your face.
  if (dom.repoPath) dom.repoPath.textContent = state.repo;
}

// Setting the mission gives every agent a goal. That is the orchestrator doing
// its job, so it is shown as its job: a bolt at Thor's desk and a courier
// crossing the floor to each agent, carrying the goal it was handed.
let goalsSeen = false;

function noticeHandouts(before, after) {
  if (!after) return;
  if (!goalsSeen) {
    goalsSeen = true;
    return; // the first snapshot is history, not news
  }
  const boss = orchestratorId();
  let handed = 0;
  for (const [agentId, goal] of Object.entries(after)) {
    const objective = goal?.objective ?? '';
    if (!objective || objective === (before?.[agentId]?.objective ?? '')) continue;
    handed += 1;
    if (agentId !== boss) addPing(boss, agentId);
    // The desk says what it was just told to do, in one line, for as long as
    // any other bubble would hold.
    shownBubble.set(agentId, { text: firstLine(objective), at: Date.now() });
  }
  if (handed > 0) fireMove(boss, 'neutral');
}

// An event this page made up, so a client-side refusal can appear in the same
// stream as everything else without pretending the server sent it.
function createLocalEvent(agentId, kind, payload) {
  return { agentId, ts: Date.now(), kind, payload: { ...payload, local: true } };
}

function ingest(event, agent) {
  if (agent) state.agents = { ...state.agents, [agent.id]: agent };
  const list = state.eventsByAgent[event.agentId] ?? [];
  state.eventsByAgent[event.agentId] = [...list.slice(-800), event];

  queueMove(event);
  noticeErrand(event);
  if (!event.payload?.local) sound.play(cueFor(event));
  if (event.kind === EVENT_KINDS.PING) {
    if (event.payload.kind === 'verified') addPulse(event.agentId);
    if (event.payload.to) addPing(event.agentId, event.payload.to);
  }
}

// Signature moves. Each agent has one, and it fires on a REAL event - never a
// timer - so a bolt or an arrow always means something happened.
const MOVE_BY_ROLE = Object.freeze({
  orchestrator: 'lightning', // routed work, or escalated to you
  tester: 'smash',           // a verdict, emerald for pass and red for fail
  coder: 'repulsor',         // a diff landed
  auditor: 'portal',         // a finding
  ux: 'beam',                // a report published
  product: 'hex',            // the contract accepted
  reviewer: 'binary',        // a merge verdict
});


const MOVE_COOLDOWN_MS = 4000;
const MOVE_LIFE_MS = 900;
const lastMoveAt = new Map();

// Thor giving somebody their orders is a thing that HAPPENS in the room: he
// gets up, walks over, and says it. A ping is exactly that signal.
function noticeErrand(event) {
  if (event.kind !== EVENT_KINDS.PING) return;
  const message = event.payload?.text ?? event.payload?.reason ?? '';
  state.errands = enqueueErrand(state.errands, {
    heroId: event.agentId,
    toId: event.payload?.toAgentId ?? event.payload?.to,
    message,
  }, Date.now());
}

function queueMove(event) {
  const agent = state.agents[event.agentId];
  if (!agent) return;
  const trigger = moveTrigger(agent, event);
  if (!trigger) return;

  const now = Date.now();
  if (now - (lastMoveAt.get(agent.id) ?? 0) < MOVE_COOLDOWN_MS) return;
  lastMoveAt.set(agent.id, now);

  state.moves.push({
    agentId: agent.id,
    move: agent.move ?? MOVE_BY_ROLE[agent.role] ?? 'repulsor',
    toAgentId: trigger.toAgentId ?? null,
    tone: trigger.tone,
    born: now,
  });
}

// What counts as this role doing its thing.
function moveTrigger(agent, event) {
  const payload = event.payload ?? {};
  if (event.kind === EVENT_KINDS.BLOCKED || (event.kind === EVENT_KINDS.APPROVAL && !payload.resolved)) {
    return { tone: 'fail' };
  }
  switch (agent.role) {
    case 'orchestrator':
      return event.kind === EVENT_KINDS.MESSAGE ? { tone: 'neutral' } : null;
    case 'tester':
      if (event.kind === EVENT_KINDS.PING && payload.kind === 'verified') {
        return { tone: 'ok', toAgentId: payload.to ?? null };
      }
      if (event.kind === EVENT_KINDS.RESULT) {
        return { tone: payload.isError ? 'fail' : 'ok' };
      }
      return null;
    case 'coder':
      return event.kind === EVENT_KINDS.DIFF ? { tone: 'ok' } : null;
    case 'auditor':
      return event.kind === EVENT_KINDS.CLAIM ? { tone: payload.receipt ? 'neutral' : 'fail' } : null;
    case 'ux':
      return event.kind === EVENT_KINDS.RESULT ? { tone: 'neutral' } : null;
    case 'product':
      return event.kind === EVENT_KINDS.PLAN ? { tone: 'ok' } : null;
    case 'reviewer':
      return event.kind === EVENT_KINDS.RESULT
        ? { tone: payload.isError ? 'fail' : 'ok' }
        : null;
    default:
      return null;
  }
}

// -------------------------------------------------------------- view model

// An agent taken off the mission keeps its desk: dark, empty, and still there
// to be clicked. Hiding it would leave no way to bring it back now that the
// crew panel is gone - the room is the only roster there is.
function orderedAgents() {
  const all = Object.values(state.agents);
  return [
    ...all.filter((agent) => agent.role !== 'orchestrator'),
    ...all.filter((agent) => agent.role === 'orchestrator'),
  ];
}

// Which desk a worker sits at. One definition, so a waypoint and a nameplate
// can never disagree about where somebody is.
function workerIndex(agentId) {
  return orderedAgents()
    .filter((agent) => agent.role !== 'orchestrator')
    .findIndex((agent) => agent.id === agentId);
}

function firstWorker() {
  return orderedAgents().find((agent) => agent.role !== 'orchestrator');
}

function viewAgents(now) {
  let index = 0;
  return orderedAgents().map((agent) => {
    const events = state.eventsByAgent[agent.id] ?? [];
    const isOrchestrator = agent.role === 'orchestrator';
    const model = {
      ...agent,
      index: isOrchestrator ? 0 : index,
      isOrchestrator,
      selected: agent.id === state.focus,
      offDuty: agent.enabled === false,
      pose: agentPose(agent, events, now),
      eventsPerMin: eventsPerMin(events, now),
      // Same rule as the pose: a finished loop is history, not an alarm.
      loopCount: agent.status === 'running' ? (detectLoops(events)[0]?.count ?? 0) : 0,
      goal: state.goals[agent.id] ?? null,
      // Where this agent must be standing right now, if they are carrying an
      // order. The scene walks them there; nothing else changes.
      // deskSpot flattens z into y for the 2D overlays, so it CANNOT be used
      // as a walk target - every waypoint came out with z undefined and the
      // body walked to NaN. seatOf is the floor's own x/z.
      errand: (() => {
        const at = errandWaypoint(state.errands, agent.id, (id) => {
          const other = state.agents[id];
          if (!other) return null;
          return seatOf({
            ...other,
            index: workerIndex(id),
            isOrchestrator: other.role === 'orchestrator',
          });
        });
        return at ? { at, phase: state.errands.active?.phase } : null;
      })(),
      // One promise against one reality, computed once here so the nameplate,
      // the desk and the header can never disagree about it.
      burn: agentBurn({ ...agent, flows: measuredFlows(agent) }, now),
    };
    if (!isOrchestrator) index += 1;
    return model;
  });
}

// The agent's declared plan supplies the words; the event stream supplies the
// clock. Taking actualMs from the agent's own payload would grade its estimate
// against its own claim, which is the thing this tool exists to stop.
function measuredFlows(agent) {
  const events = state.eventsByAgent[agent.id] ?? [];
  const measured = stepTimings(events);
  if (measured.length === 0) return agent.flows ?? [];
  return measured.map((timing, index) => {
    const declared = timing.id
      ? agent.flows?.find((step) => step?.id === timing.id) ?? {}
      : agent.flows?.[index] ?? {};
    return {
      ...declared,
      step: declared.step ?? timing.step,
      user_visible_result: declared.user_visible_result ?? timing.step,
      status: timing.status ?? declared.status,
      estimateMs: declared.estimateMs ?? timing.estimateMs,
      actualMs: timing.actualMs ?? 0,
    };
  });
}

function claimsFor(agentId) {
  const events = state.eventsByAgent[agentId] ?? [];
  const claims = events
    .filter((event) => event.kind === EVENT_KINDS.CLAIM)
    .map((event) => event.payload);
  return gradeClaims(claims).graded;
}

// The room derives its own cards on the server now, so the screen renders what
// the monitor found rather than working it out a second time. The local pass
// stays as the fallback for a server that has not sent any yet (an old build,
// or the first frame after a reload).
function decisions(now) {
  if (state.cards) return state.cards;
  return deriveLocalCards(now);
}

function deriveLocalCards(now) {
  return orderedAgents().filter((agent) => agent.enabled !== false).flatMap((agent) => {
    const events = state.eventsByAgent[agent.id] ?? [];
    const approval = pendingApproval(events);
    const cards = pendingDecisions(agent, events, now).map((decision) => ({
      ...decision,
      agentName: agent.label ?? agent.name,
      // An engine parked on a permission request is not just "blocked": it is
      // asking a question with named answers, so the card carries them.
      approval: decision.kind === 'blocked' ? approval : null,
    }));
    if (approval && !cards.some((card) => card.approval)) {
      cards.unshift({
        agentId: agent.id,
        agentName: agent.label ?? agent.name,
        kind: 'approval',
        detail: approval.summary,
        actions: ['steer', 'kill'],
        approval,
      });
    }
    return cards;
  });
}

// The newest approval that has not been answered yet.
function pendingApproval(events) {
  const resolved = new Set();
  let open = null;
  for (const event of events) {
    if (event.kind !== EVENT_KINDS.APPROVAL) continue;
    if (event.payload?.resolved) resolved.add(event.payload.id);
    else open = event.payload;
  }
  return open && !resolved.has(open.id) ? open : null;
}

// ------------------------------------------------------------------ render

let panelsQueued = false;
let lastBubbleAt = 0;
let seeded = false;
const rendered = new Map();
const deferred = new WeakSet();

// Everything is already in SQLite, so a reload rejoins the run in progress
// instead of starting from an empty feed.
async function seedFromRun(runId) {
  const { events = [] } = await fetch(`/replay?run=${runId}`)
    .then((response) => response.json())
    .catch(() => ({ events: [] }));

  const byAgent = {};
  for (const event of events.slice(-1500)) {
    (byAgent[event.agentId] ??= []).push(event);
  }
  for (const [agentId, list] of Object.entries(byAgent)) {
    state.eventsByAgent[agentId] = [...list, ...(state.eventsByAgent[agentId] ?? [])].slice(-800);
  }
  renderPanels();
}

function schedulePanels() {
  if (panelsQueued) return;
  panelsQueued = true;
  setTimeout(() => {
    panelsQueued = false;
    renderPanels();
  }, PANEL_THROTTLE_MS);
}

// Rebuilding a panel with replaceChildren destroys whatever field you were
// typing in. Skipping the rebuild instead was worse: focus stays in the reply
// box after you send, so the panel froze and every later answer went to the
// agent without ever appearing on screen. So the field is carried ACROSS the
// rebuild - what you had typed, where the caret was, and the focus itself -
// and the panel always redraws. A field opts in with `data-field`, whose value
// is what makes it the same field on the other side of the render.
function keepingField(root, render) {
  const active = document.activeElement;
  const typing = !!active && root.contains(active)
    && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement);
  const field = typing ? active.dataset.field : null;
  const value = typing ? active.value : '';
  const start = typing ? active.selectionStart : null;
  const end = typing ? active.selectionEnd : null;

  render();

  if (!field) return;
  const next = root.querySelector(`[data-field="${CSS.escape(field)}"]`);
  if (!(next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement)) return;
  next.value = value;
  next.focus();
  if (start !== null && end !== null) next.setSelectionRange(start, end);
}

// Live events arrive much faster than the controls change. Replacing a whole
// panel for each event makes clicks miss and moves the caret while somebody is
// typing. Each panel therefore redraws only when its own visible data changes.
// A real change that arrives during an edit waits until focus leaves the field.
function renderChanged(name, root, value, render, { deferWhileEditing = true } = {}) {
  const signature = JSON.stringify(value);
  if (rendered.get(name) === signature) return;

  const active = document.activeElement;
  const editing = !!active && root.contains(active)
    && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement);
  if (deferWhileEditing && editing) {
    if (!deferred.has(root)) {
      deferred.add(root);
      root.addEventListener('focusout', () => {
        deferred.delete(root);
        schedulePanels();
      }, { once: true });
    }
    return;
  }

  render();
  rendered.set(name, signature);
}

function rosterView(agents) {
  return agents.map((agent) => ({
    id: agent.id,
    label: agent.label,
    name: agent.name,
    role: agent.role,
    status: agent.status,
    selected: agent.selected,
    enabled: agent.enabled,
    instances: agent.instances,
    engine: agent.engine,
    goal: agent.goal,
  }));
}

// The walkover, tick by tick. Two signature moves bracket it: the carrier's
// as they set off, and the RECEIVER's as the order lands - so a delivery reads
// as one hero acting on another, not as somebody wandering the room.
function stepErrands(now) {
  const before = state.errands.active;
  state.errands = advanceErrands(state.errands, now);
  const after = state.errands.active;

  const wasKey = before ? `${before.key}:${before.phase}` : null;
  const isKey = after ? `${after.key}:${after.phase}` : null;
  if (wasKey === isKey) return;

  if (after?.phase === ERRAND.GOING) fireMove(after.heroId, 'neutral');
  if (after?.phase === ERRAND.TALKING) fireMove(after.toId, 'ok');
}

function renderPanels() {
  const now = Date.now();
  const agents = viewAgents(now);
  const queue = decisions(now);

  // How long the fleet has been waiting on you, and what that costs the room.
  const before = state.waiting;
  state.waiting = trackWaiting(state.waiting, queue, now);
  // Most decisions are derived from history rather than announced by an event,
  // so the cue belongs to the QUEUE gaining a card, not to any one message.
  if (queue.some((decision) => !(keyOf(decision) in before))) sound.play(CUES.DECISION);
  const owed = neglect(state.waiting, now);
  state.neglect = owed.level;
  sound.setNeglect(owed.level);
  document.body.dataset.owed = queue.length ? 'yes' : '';

  // FLOW and EVIDENCE follow whoever is focused: they are one agent's contract
  // and one agent's claims, and the room is what says which agent that is.
  const focused = agents.find((agent) => agent.selected) ?? agents[0];
  if (dom.roster && windows?.isOpen('crew')) {
    renderChanged('crew', dom.roster, rosterView(agents), () => {
      renderRoster(dom.roster, agents, handlers);
    });
  }
  if (dom.roCrew) {
    const running = agents.filter((agent) => agent.status === 'running').length;
    dom.roCrew.textContent = `${running}/${agents.length} RUNNING`;
  }
  if (dom.flows && focused && windows?.isOpen('flows')) {
    const flows = measuredFlows(focused);
    renderChanged('flows', dom.flows, [focused.id, flows], () => {
      renderFlows(dom.flows, { ...focused, flows });
    });
  }
  // The focused flow stays available here and at the desk. The panel is the
  // stable reading surface; the desk keeps the same truth beside its controls.
  if (dom.focusName) dom.focusName.textContent = focused?.name ?? '';
  // One queue. A hero's question is a decision like any other, so answering it
  // happens here rather than behind a second tab that counted the same things.
  if (dom.queue && windows?.isOpen('decisions')) {
    const prayer = state.prayerWith
      ? state.eventsByAgent[state.prayerWith] ?? []
      : null;
    renderChanged('decisions', dom.queue, [queue, state.prayerWith, prayer], () => {
      keepingField(dom.queue, () => {
        if (state.prayerWith && prayerThread(state.prayerWith)) renderPrayer(dom.queue);
        else renderQueue(dom.queue, queue, handlers);
      });
    }, { deferWhileEditing: false });
  }
  if (dom.queueCount) dom.queueCount.textContent = String(queue.length);
  windows?.setCount?.('decisions', queue.length);
  windows?.setCount?.('prayer', orderedAgents().filter((a) => prayerThread(a.id)).length);
  composer?.setTarget(state.target, agents, state.mission ?? '');
  renderBubbles(queue);
  renderStrip(agents);
  renderHeader(agents);
  if (windows?.isOpen('feed')) renderFeed();
  if (dom.crewBar) {
    const crewBar = agents.map((agent) => [
      agent.id,
      agent.name,
      agent.label,
      agent.status,
      agent.offDuty,
      agent.id === state.focus,
      doingNow(agent),
    ]);
    renderChanged('crew-bar', dom.crewBar, crewBar, () => renderCrewBar(agents));
  }
  renderPrayer();
  if (dom.runs && windows?.isOpen('runs')) {
    renderChanged('runs', dom.runs, [state.runs, state.runId], () => {
      panels.renderRuns?.(dom.runs, state.runs, state.runId, handlers);
    });
  }
  if (dom.roRuns) dom.roRuns.textContent = `${state.runs.length} RUNS`;
}

// Standing at a desk shows that agent's whole standing: their goal, editable in
// place, the flow contract they accepted, and every claim they have made with
// the command behind it. None of it lives here - the goal goes back to the
// server, the flows and claims are derived from the event stream.
// The crew bar. Who is working, and what each of them is doing, in one row
// that never moves. A bubble is an EVENT - it appears, is read, and goes; "what
// is Hulk doing right now" is STATE, and state belongs somewhere fixed. Using
// a transient channel for persistent information is why the floor read as
// noise.
function lastAction(agentId) {
  const events = state.eventsByAgent[agentId] ?? [];
  return [...events].reverse().find((event) =>
    event.kind === EVENT_KINDS.TOOL || event.kind === EVENT_KINDS.MESSAGE) ?? null;
}

function agoWords(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

function doingNow(agent) {
  if (agent.offDuty) return 'stood down for this mission';
  if (agent.status === 'blocked') return agent.blockedReason ?? 'waiting on you';

  const last = lastAction(agent.id);
  // Not working is a FACT with a time on it. "not working" alone told you
  // nothing about whether that was a second ago or an hour.
  if (agent.status !== 'running') {
    return last ? `stopped · last moved ${agoWords(last.ts)}` : 'never started';
  }
  if (!last) return 'starting up';
  if (last.kind === EVENT_KINDS.TOOL) {
    return doingWords(last.payload?.action, last.payload?.target);
  }
  const said = plainText(last.payload?.text ?? '');
  return said ? said.slice(0, 60) : 'thinking';
}

function renderCrewBar(agents) {
  if (!dom.crewBar) return;
  const cells = agents.map((agent) => {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'crewcell';
    cell.dataset.state = agent.offDuty
      ? 'off'
      : agent.status === 'running' ? 'on' : agent.status === 'blocked' ? 'blocked' : 'idle';
    if (agent.id === state.focus) cell.dataset.focus = 'yes';

    const name = document.createElement('span');
    name.className = 'crewcell-name';
    name.textContent = agent.name ?? agent.id;

    const doing = document.createElement('span');
    doing.className = 'crewcell-doing';
    doing.textContent = doingNow(agent);

    cell.append(name, doing);
    cell.title = `${agent.label ?? agent.name} - ${doingNow(agent)}`;
    cell.onclick = () => focus(agent.id === state.focus ? null : agent.id);
    return cell;
  });
  dom.crewBar.replaceChildren(...cells);
}

function renderStrip(agents) {
  if (!strip) return;
  const agent = agents.find((candidate) => candidate.id === state.focus);
  if (!agent) return strip.close();
  strip.render({
    ...agent,
    flows: measuredFlows(agent),
    claims: claimsFor(agent.id),
  });
}

// A decision belongs to a desk, so it is shown at that desk. Only the most
// urgent card per agent floats; the rest live in the decisions window.
// What each agent is doing RIGHT NOW, pinned to its desk. Without this the
// room shows mood and no content: an agent running twelve git commands looks
// exactly like one doing nothing.
// A bubble is for reading, so it holds still. An agent may change what its
// bubble says at most once every thirty seconds, however fast it is working.
const BUBBLE_HOLD_MS = 30_000;
const shownBubble = new Map(); // agentId -> { text, at }

const FRESH_MS = 8_000; // how long a bubble reads as newly arrived

function bubbleTextFor(agentId, latest, now) {
  const held = shownBubble.get(agentId);
  if (held && now - held.at < BUBBLE_HOLD_MS) {
    return { text: held.text, fresh: now - held.at < FRESH_MS };
  }
  const text = plainText(describeEvent(latest));
  // The server strips a report block before it is ever spoken, but history
  // recorded before that fix still holds the fragments, and a bubble is the
  // one surface where a stray "] }" is unmissable. Never speak payload: keep
  // whatever the agent last actually said instead.
  if (isMachineNoise(text)) return held ? { text: held.text, fresh: false } : null;
  if (!held || held.text !== text) shownBubble.set(agentId, { text, at: now });
  return { text, fresh: true };
}

function renderActivity(agents) {
  if (!dom.bubbles) return [];
  const now = Date.now();
  // Zoomed into a desk, the room falls quiet: only that agent speaks, so the
  // focused conversation is not competing with five others. `state.focus` is
  // the one record of which desk you are standing at - the camera, the console
  // target and the goal strip all read the same field.
  // While an order is being carried, the room holds ONE bubble: the hero
  // saying it. Hover overrides that - pointing at somebody is asking about
  // them, and your attention outranks the choreography.
  const carrying = errandSpeaker(state.errands, state.hovered);
  const order = errandSpoken(state.errands, state.hovered);

  if (order) {
    const at = scene?.screenPos?.(order.agentId);
    if (!at) return [];
    const to = state.agents[order.toId];
    return [speechBubble({
      text: to ? `${to.label ?? to.name}: ${order.text}` : order.text,
      fresh: true,
      x: at.x,
      y: at.y,
      tone: 'live',
      onClick: () => openAgentFeed(order.agentId),
    })];
  }

  return agents
    .filter((agent) => !agent.offDuty)
    // A hero who is not working says nothing. A bubble is what someone is
    // doing NOW; leaving the last thing they ever did floating over an empty
    // chair is what made the room impossible to read.
    .filter((agent) => agent.status === 'running' || agent.status === 'blocked')
    .filter((agent) => !state.focus || agent.id === state.focus)
    // A walk in progress silences everyone but the one being pointed at.
    .filter((agent) => !state.errands.active || !carrying || agent.id === carrying)
    .map((agent) => {
      const events = state.eventsByAgent[agent.id] ?? [];
      // A claim is the one thing an agent says that comes with a receipt, so
      // it outranks the command it happens to be running right now.
      const last = [...events].reverse().find((event) =>
        event.kind === EVENT_KINDS.TOOL
        || event.kind === EVENT_KINDS.MESSAGE
        || event.kind === EVENT_KINDS.CLAIM);
      if (!last) return null;
      const at = scene?.screenPos?.(agent.id);
      if (!at) return null;
      const said = bubbleTextFor(agent.id, last, now);
      if (!said?.text) return null; // nothing this agent said is worth speaking
      return speechBubble({
        text: said.text,
        fresh: said.fresh,
        x: at.x,
        y: at.y,
        tone: agent.status === 'running' ? 'live' : 'quiet',
        onClick: () => openAgentFeed(agent.id),
      });
    })
    .filter(Boolean);
}

// A speech bubble: rounded, wrapping, sitting ABOVE the head with a tail
// pointing down at it - so it never lands on the nameplate under the desk.
function speechBubble({ text, x, y, tone, onClick, fresh = false }) {
  const bubble = document.createElement('div');
  bubble.className = `bubble ${tone}`;
  bubble.textContent = text;

  const live = tone === 'live';
  const edge = tone === 'alert' ? 'var(--danger,#f87171)' : live
    ? 'var(--accent,#34d399)'
    : 'var(--line,#262626)';

  bubble.style.cssText = [
    'position:absolute', `left:${x}px`, `top:${y - 18}px`,
    'transform:translate(-50%, -100%)', 'z-index:30',
    'width:260px',
    'padding:7px 11px', 'border-radius:12px',
    `border:1px solid ${edge}`, 'background:var(--surface,#121212)',
    `color:var(--${live || tone === 'alert' ? 'text' : 'muted'}, #8a8a8a)`,
    'font:11px/1.45 Menlo, monospace',
    'white-space:normal', 'overflow-wrap:anywhere',
    'display:-webkit-box', '-webkit-line-clamp:3', '-webkit-box-orient:vertical',
    'overflow:hidden', 'transition:max-height 120ms ease-out',
    `opacity:${live || tone === 'alert' ? 1 : 0.72}`,
    // Hovering always works, whether or not the bubble is clickable, because a
    // clamped sentence you cannot finish reading is worse than no sentence.
    'pointer-events:auto', onClick ? 'cursor:pointer' : 'cursor:default',
  ].join(';');

  // Hover expands to the whole message and lifts it above its neighbours.
  // Hover shows the rest of the message. It grows DOWNWARD only - the width is
  // fixed, so it stays a speech bubble instead of stretching into a banner.
  // Hover shows the whole message: the clamp comes off, and anything taller
  // than the screen allows scrolls inside the bubble. Leaving `-webkit-box` in
  // place with the clamp merely unset does not reliably re-flow, so the display
  // mode is swapped outright.
  bubble.addEventListener('pointerenter', () => {
    // Pin the top edge where it already is, then grow downward. Without this
    // the bubble is bottom-anchored and expands up over the room.
    const before = bubble.getBoundingClientRect();
    bubble.style.transform = 'translate(-50%, 0)';
    bubble.style.top = `${before.top}px`;
    bubble.style.display = 'block';
    bubble.style.webkitLineClamp = 'unset';
    bubble.style.maxHeight = '46vh';
    bubble.style.overflowY = 'auto';
    bubble.style.opacity = '1';
    bubble.style.zIndex = '45';
  });
  bubble.addEventListener('pointerleave', () => {
    bubble.style.transform = 'translate(-50%, -100%)';
    bubble.style.top = `${y - 18}px`;
    bubble.style.display = '-webkit-box';
    bubble.style.webkitLineClamp = '3';
    bubble.style.maxHeight = '';
    bubble.style.overflowY = 'hidden';
    bubble.style.opacity = live || tone === 'alert' ? '1' : '0.72';
    bubble.style.zIndex = '30';
  });

  // A new message announces itself: a dot on the corner, and a brief pulse of
  // the border. It settles after a few seconds so the room does not shout.
  if (fresh) {
    const dot = document.createElement('span');
    dot.setAttribute('aria-label', 'new');
    dot.style.cssText = [
      'position:absolute', 'top:-4px', 'right:-4px', 'width:8px', 'height:8px',
      'border-radius:50%', `background:${edge}`,
      'box-shadow:0 0 0 2px var(--surface,#121212)',
      'animation:bubble-new 1.2s ease-out 3',
    ].join(';');
    bubble.append(dot);
    bubble.style.borderWidth = '2px';
  }

  const tail = document.createElement('span');
  tail.style.cssText = [
    'position:absolute', 'left:50%', 'bottom:-5px', 'width:9px', 'height:9px',
    'transform:translateX(-50%) rotate(45deg)',
    'background:var(--surface,#121212)',
    `border-right:1px solid ${edge}`, `border-bottom:1px solid ${edge}`,
  ].join(';');
  bubble.append(tail);

  if (onClick) bubble.onclick = onClick;
  return bubble;
}


function renderBubbles(queue) {
  if (!dom.bubbles) return;
  const byAgent = new Map();
  for (const decision of queue) {
    if (state.focus && decision.agentId !== state.focus) continue;
    if (!byAgent.has(decision.agentId)) byAgent.set(decision.agentId, decision);
  }

  const activity = renderActivity(viewAgents(Date.now()));
  const alerts = [...byAgent.values()]
    .map((decision) => {
      const at = scene?.screenPos?.(decision.agentId);
      if (!at) return null;
      const bubble = speechBubble({
        text: plainText(`${decision.agentName}: ${shortenDetail(decision.detail)}`),
        x: at.x,
        // Stacked clear of the activity bubble, which already sits above the head.
        y: at.y - 86,
        tone: 'alert',
        onClick: () => openAgentFeed(decision.agentId),
      });
      return bubble;
    })
    .filter(Boolean);

  dom.bubbles.replaceChildren(...activity, ...alerts);
  deoverlap([...alerts, ...activity]);
}

// Bubbles are placed over desks, and desks are close together, so two bubbles
// will collide. Rather than let one clip the other, they are nudged apart
// after layout - alerts hold their place, activity gives way.
function deoverlap(bubbles) {
  // Bubbles live inside the ROOM, not the whole window. The room now starts
  // below the top bar and the crew bar.
  const chrome = (name, fallback) => Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(name),
  ) || fallback;
  const TOP = chrome('--topbar-h', 48) + chrome('--crew-h', 40) + 8;
  const BOTTOM = window.innerHeight - 150;
  const RIGHT = window.innerWidth - chrome('--panel-w', 0) - 8;
  const GAP = 6;
  const placed = [];

  for (const bubble of bubbles) {
    let box = bubble.getBoundingClientRect();
    if (box.width === 0) continue;

    // Keep it on screen first: above the composer, below the top bar.
    let shift = 0;
    if (box.top < TOP) shift += TOP - box.top;
    if (box.bottom + shift > BOTTOM) shift -= box.bottom + shift - BOTTOM;
    // Nothing may hide under the side panel.
    if (box.right > RIGHT) {
      const current = Number.parseFloat(bubble.style.left) || 0;
      bubble.style.left = `${current - (box.right - RIGHT)}px`;
      box = bubble.getBoundingClientRect();
    }

    // Then push down past anything already sitting where it wants to be.
    for (let guard = 0; guard < 12; guard += 1) {
      const top = box.top + shift;
      const bottom = box.bottom + shift;
      const clash = placed.find((other) =>
        top < other.bottom + GAP &&
        bottom + GAP > other.top &&
        box.left < other.right + GAP &&
        box.right + GAP > other.left);
      if (!clash) break;
      shift = clash.bottom + GAP - box.top;
    }

    if (shift !== 0) {
      const current = Number.parseFloat(bubble.style.top) || 0;
      bubble.style.top = `${current + shift}px`;
      box = bubble.getBoundingClientRect();
    }
    placed.push({
      top: box.top, bottom: box.bottom, left: box.left, right: box.right,
    });
  }
}

function frame() {
  const now = Date.now();
  // A walk is a clock, not an event. Advancing it only inside renderPanels
  // meant the queue moved when something happened to be reported and stalled
  // the rest of the time.
  stepErrands(now);
  state.pulses = state.pulses.filter((pulse) => now - pulse.born < PULSE_MS);
  state.pings = state.pings.filter((ping) => now - ping.born < PING_MS);
  state.moves = state.moves.filter((move) => now - move.born < MOVE_LIFE_MS);

  scene?.render({
    neglect: state.neglect,
    agents: viewAgents(now),
    pulses: state.pulses.map((pulse) => ({ ...pulse, life: 1 - (now - pulse.born) / PULSE_MS })),
    pings: state.pings.map((ping) => ({ ...ping, life: 1 - (now - ping.born) / PING_MS })),
    moves: state.moves.map((move) => ({ ...move, life: 1 - (now - move.born) / MOVE_LIFE_MS })),
  });

  if (now - lastBubbleAt > 500) {
    lastBubbleAt = now;
    renderBubbles(decisions(now));
    // Neglect is a clock, not an event: the room keeps going down while
    // nobody touches it, so it is re-read here and not only on the next event.
    const owed = neglect(state.waiting, now);
    state.neglect = owed.level;
    sound.setNeglect(owed.level);
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------- the windows

// What is left of the panels. FEED and DECISIONS are the two things you read
// about the whole floor; RUNS and MIDDLEWARE are settings. Flow, evidence and
// crew are gone from here: they belong to one agent, and they are now at that
// agent's desk.
const WINDOW_IDS = {
  feed: ['winFeed', 'btnFeed'],
  flows: ['winFlows', 'btnFlows'],
  crew: ['winCrew', 'btnCrew'],
  decisions: ['winDecisions', 'btnDecisions'],
  runs: ['winRuns', 'btnRuns'],
  middleware: ['winMiddleware', 'btnMiddleware'],
};

let windows = null;
// Reopening should return to whatever you were last reading.
let lastPanel = 'feed';

function windowEntries() {
  return Object.fromEntries(
    Object.entries(WINDOW_IDS)
      .filter(([, [winId]]) => dom[winId])
      .map(([name, [winId, buttonId]]) => [
        name,
        {
          el: dom[winId],
          button: dom[buttonId],
          bar: dom[winId].querySelector('.win-bar, header, h2'),
        },
      ]),
  );
}

function openWindow(name) {
  if (!windows?.isOpen(name)) toggleWindow(name);
}

function toggleWindow(name) {
  if (!windows) return;
  lastPanel = name;
  const nowOpen = windows.toggle(name);
  state.open = new Set(windows.openNames());
  dom[WINDOW_IDS[name]?.[1]]?.setAttribute('aria-pressed', String(nowOpen));
  // The list is a record on the server, not local state: a mission set since
  // boot, or the live run's event count, is only visible if we re-read it.
  if (name === 'runs' && nowOpen) loadRuns();
  renderPanels();
}

function closeTopWindow() {
  const last = windows?.openNames().pop();
  if (last) toggleWindow(last);
}

// ---------------------------------------------------------------- handlers

const handlers = {
  select: focus,
  setGoal: (agentId, objective) => send('setGoal', { agentId, objective }),
  assignEngine: (agentId, engine) => send('assignEngine', { agentId, engine }),
  setEnabled: (agentId, enabled) => send('setEnabled', { agentId, enabled }),
  close: () => focus(null),

  // Every steer is watched all the way to the desk: it leaves whatever you
  // typed it into, crosses the room, and the agent answers when it lands.
  steer: (agentId, text, from) => {
    flyTo({ agentId, text, from, tone: 'neutral' });
    return send('say', { target: agentId, text });
  },

  approve: (agentId, approvalId, decision, from) => {
    flyTo({ agentId, text: 'answered', from, tone: 'ok' });
    return send('approve', { agentId, approvalId, decision });
  },

  // A run is a conversation with the fleet. Past ones stay readable; a new one
  // resets the floor without losing them.
  stopRun: () => send('stopRun'),

  newRun: async () => {
    const mission = window.prompt('What is the mission for this run?', '');
    if (mission === null) return;
    await send('newRun', { mission });
    state.eventsByAgent = {};
    await loadRuns();
  },

  continueRun: async (runId) => {
    await send('continueRun', { runId });
    await loadRuns();
  },

  resumeRun: async (runId) => {
    await send('resumeRun', { runId });
    state.eventsByAgent = {};
    await loadRuns();
  },

  openRun: async (runId) => {
    const { events } = await fetch(`/replay?run=${runId}`).then((r) => r.json());
    state.eventsByAgent = {};
    for (const event of events) {
      const list = state.eventsByAgent[event.agentId] ?? [];
      state.eventsByAgent[event.agentId] = [...list, event];
    }
    renderPanels();
  },
  act: (action, decision, from) => {
    // RETRY dispatches the agent again. For an agent blocked because its engine
    // never came up, this is the only action on the card that can clear it.
    if (action === 'retry') {
      flyTo({ agentId: decision.agentId, text: 'retry', from, tone: 'ok' });
      return send('start', { agentId: decision.agentId });
    }
    if (action === 'kill') {
      flyTo({ agentId: decision.agentId, text: 'stop', from, tone: 'fail' });
      return send('interrupt', { agentId: decision.agentId });
    }
    if (action === 'split') {
      return send('say', {
        target: decision.agentId,
        text:
          'Stop. Split the current step into smaller steps and report the new flow contract ' +
          'before continuing.',
      });
    }
    if (action === 'answer' || decision.kind === 'prayer') {
      return openPrayer(decision.agentId);
    }
    return focus(decision.agentId);
  },
};

// Selecting an agent is walking up to their desk: the camera goes there, the
// conversation opens there, and the console is now addressed to them. Passing
// null - Escape, or a click on the empty floor - walks back out.
function focus(agentId) {
  const id = agentId && state.agents[agentId] ? agentId : null;
  state.focus = id;
  state.target = id ?? MISSION_TARGET;
  scene?.focusOn?.(id);
  if (id) fireMove(id, 'neutral'); // the room answers the click
  else strip?.close();
  renderPanels();
}

// Fire a move directly, outside the event triggers - used when you pick an
// agent, so the room answers a click.
function fireMove(agentId, tone = 'neutral') {
  const agent = state.agents[agentId];
  if (!agent) return;
  state.moves.push({
    agentId,
    move: agent.move ?? MOVE_BY_ROLE[agent.role] ?? 'repulsor',
    toAgentId: null,
    tone,
    born: Date.now(),
  });
}

function addressMission() {
  state.target = MISSION_TARGET;
  renderPanels();
  composer?.focus();
}

function addPulse(agentId) {
  const agent = viewAgents(Date.now()).find((candidate) => candidate.id === agentId);
  if (agent) state.pulses.push({ ...deskSpot(agent), born: Date.now() });
}

function addPing(fromId, toId) {
  const agents = viewAgents(Date.now());
  const from = agents.find((agent) => agent.id === fromId);
  const to = agents.find((agent) => agent.id === toId);
  if (from && to) {
    state.pings.push({ from: deskSpot(from), to: deskSpot(to), born: Date.now() });
  }
}

// -------------------------------------------------------------------- boot

function wireChrome() {
  // ASSEMBLE before START: Thor decides who this mission actually needs,
  // brings them on, stands the rest down, and gives each of the chosen a goal.
  // Nobody is dispatched blind, and nobody is dispatched who has nothing to do.
  dom.planAll?.addEventListener('click', () => send('assemble'));

  dom.startAll?.addEventListener('click', () => {
    for (const agent of orderedAgents()) {
      if (agent.enabled !== false) send('start', { agentId: agent.id });
    }
  });

  // The floor's voice. A switch, so it says which state it is in without a
  // word, and the choice survives a reload. It can only be started from a real
  // click - that is the browser's rule, not ours.
  if (dom.btnSound) {
    const paint = () => dom.btnSound.setAttribute('aria-checked', String(sound.enabled));
    paint();
    dom.btnSound.addEventListener('click', () => {
      sound.toggle();
      paint();
    });
  }

  dom.stopAll?.addEventListener('click', () => handlers.stopRun());

  for (const name of Object.keys(WINDOW_IDS)) {
    dom[WINDOW_IDS[name][1]]?.addEventListener('click', () => toggleWindow(name));
  }
  dom.winFlowsClose?.addEventListener('click', () => toggleWindow('flows'));
  dom.winCrewClose?.addEventListener('click', () => toggleWindow('crew'));
  dom.winDecisionsClose?.addEventListener('click', () => toggleWindow('decisions'));
  dom.winRunsClose?.addEventListener('click', () => toggleWindow('runs'));
  dom.winFeedClose?.addEventListener('click', () => toggleWindow('feed'));

  // The working folder is a live setting, so it is chosen where it is shown.
  if (dom.repoPath) {
    dom.repoPath.style.cursor = 'pointer';
    dom.repoPath.title = 'Click to choose the working folder';
    dom.repoPath.addEventListener('click', () => openPicker(state.repo));
  }

  // Two keys. Escape steps back out of a desk to the whole room; Cmd+\\ shows
  // and hides the panel. Everything else belongs to the browser and to
  // whatever is being typed.
  addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.focus) {
      event.preventDefault();
      focus(null);
      return;
    }
    if (event.key !== '\\' || !(event.metaKey || event.ctrlKey) || event.shiftKey) return;
    event.preventDefault();
    if (windows?.openNames().length) windows.close();
    else windows?.open(lastPanel);
  });
}

// The feed: everything happening, in the order it happened, in words. This is
// the "keep me in the loop" surface - open by default, because a person who
// has to go looking for the log is not in the loop.
// Clicking an agent's bubble opens the feed showing only that agent, which is
// what "let me read what Thor actually said" means.
function openAgentFeed(agentId) {
  focus(agentId);
  state.feedFilter = agentId;
  windows?.open('feed');
  renderPanels();
}

function clearFeedFilter() {
  state.feedFilter = null;
  renderPanels();
}

function renderFeed() {
  // The side panel adopts the feed BODY and leaves the old window element
  // hidden, so testing that window meant the feed never drew while docked -
  // which is why its filters were nowhere to be found. Ask the body whether it
  // is actually on screen instead.
  if (!feedBody || !feedBody.isConnected || feedBody.offsetParent === null) return;

  const lines = [];
  for (const [agentId, events] of Object.entries(state.eventsByAgent)) {
    if (state.feedFilter && agentId !== state.feedFilter) continue;
    const agent = state.agents[agentId];
    for (const event of events.slice(-300)) {
      // The preset decides the altitude: everything, only the heroes talking
      // to each other, or that plus whatever changes what happens next.
      if (!passesPreset(event, state.feedPreset)) continue;
      const entry = feedEntry(agent, event);
      if (entry) lines.push({ ...entry, ts: event.ts });
    }
  }
  lines.sort((a, b) => a.ts - b.ts);
  // Codex streams a message in pieces and then repeats it whole. A line that
  // is merely the start of the next line from the same agent is that stream
  // catching up, not something new to read.
  const deduped = lines.filter((line, index) => {
    const next = lines[index + 1];
    return !(next && next.who === line.who && next.text.startsWith(line.text));
  });

  const atBottom = feedBody.scrollHeight - feedBody.scrollTop - feedBody.clientHeight < 40;
  const rows = deduped.slice(-400).map(feedRow);
  // The board is pinned above the stream. One surface answers both questions a
  // person actually has: where does the work stand, and what just happened.
  const header = [presetBar(), boardBlock(), ...(state.feedFilter ? [filterChip()] : [])]
    .filter(Boolean);
  feedBody.replaceChildren(...header, ...rows);
  // Only follow the tail if the reader was already at it.
  if (atBottom) feedBody.scrollTop = feedBody.scrollHeight;
}

// A visible reminder that you are reading one agent, with the way back on it.
// Where the work stands, pinned above the stream it belongs to.
let boardOpen = true;

function boardBlock() {
  const items = state.board ?? [];
  if (items.length === 0) return null;
  // It is the point of the BOARD tag, and useful background on ALL. It would
  // only be noise on the others.
  if (!['all', 'board'].includes(state.feedPreset)) return null;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'border:1px solid var(--line,#262626);margin:0 0 8px;'
    + 'background:var(--sunk,#151515)';

  const head = document.createElement('button');
  head.type = 'button';
  const v = state.velocity ?? {};
  head.textContent = `${boardOpen ? '\u25be' : '\u25b8'} BOARD  `
    + `${v.done ?? 0} of ${v.items ?? items.length} done`
    + (v.percent === null || v.percent === undefined ? '' : `  ·  ${v.percent}% of gates passed`);
  head.style.cssText = 'display:block;width:100%;text-align:left;background:transparent;'
    + 'border:0;color:var(--accent,#34d399);font:inherit;font-size:9px;letter-spacing:.12em;'
    + 'padding:6px 8px;cursor:pointer';
  head.onclick = () => { boardOpen = !boardOpen; renderFeed(); };
  wrap.append(head);

  if (boardOpen) {
    const body = document.createElement('div');
    body.style.cssText = 'padding:0 8px 8px';
    panels.renderBoard(body, items, state.velocity, orderedAgents(), { focus });
    wrap.append(body);
  }
  return wrap;
}

// Three altitudes on the same stream, always visible above it.
function presetBar() {
  const bar = document.createElement('div');
  bar.style.cssText = [
    'position:sticky', 'top:0', 'z-index:2', 'display:flex', 'gap:4px',
    'padding:2px 0 6px', 'background:var(--surface,#121212)',
  ].join(';');
  for (const preset of FEED_PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = preset.label;
    button.title = preset.blurb;
    const on = preset.id === state.feedPreset;
    button.style.cssText = 'background:transparent;font:inherit;font-size:9px;'
      + 'letter-spacing:.1em;text-transform:uppercase;padding:2px 7px;cursor:pointer;'
      + `border:1px solid ${on ? 'var(--accent,#34d399)' : 'var(--line,#262626)'};`
      + `color:${on ? 'var(--accent,#34d399)' : 'var(--faint,#5a5a5a)'}`;
    button.onclick = () => {
      state.feedPreset = preset.id;
      renderFeed();
    };
    bar.append(button);
  }
  return bar;
}

function filterChip() {
  const chip = document.createElement('div');
  chip.style.cssText = [
    'position:sticky', 'top:0', 'z-index:1', 'display:flex', 'align-items:center',
    'gap:8px', 'padding:4px 0 6px', 'background:var(--surface,#121212)',
    'border-bottom:1px solid var(--line,#262626)', 'font-size:10px',
    'letter-spacing:.12em', 'color:var(--accent,#34d399)',
  ].join(';');
  const who = state.agents[state.feedFilter]?.label ?? state.feedFilter;
  chip.append(document.createTextNode(`ONLY ${who.toUpperCase()}`));

  const all = document.createElement('button');
  all.type = 'button';
  all.textContent = 'SHOW ALL';
  all.style.cssText =
    'margin-left:auto;background:transparent;border:1px solid var(--line,#262626);'
    + 'color:var(--muted,#8a8a8a);font:inherit;padding:2px 7px;cursor:pointer';
  all.onclick = clearFeedFilter;
  chip.append(all);
  return chip;
}

function feedRow(entry) {
  const row = document.createElement('div');
  row.className = `feed-row ${entry.tone}`;
  row.style.cssText = 'padding:5px 0;border-bottom:1px solid var(--line,#262626)';

  const head = document.createElement('div');
  head.style.cssText = 'color:var(--muted,#8a8a8a);font-size:10px;letter-spacing:.06em';
  head.textContent = `${entry.at}  ${entry.who}${entry.suffix ?? ''}`;
  row.append(head);

  const body = document.createElement('div');
  body.className = 'md';
  if (entry.markdown) body.innerHTML = renderMarkdown(entry.text);
  else body.textContent = entry.text;
  if (entry.tone === 'alert') body.style.color = 'var(--danger,#f87171)';
  // The full command is one click away rather than filling the feed.
  if (entry.full && entry.full.length > entry.text.length) {
    body.title = entry.full;
    body.style.cursor = 'zoom-in';
    body.onclick = () => {
      body.textContent = body.dataset.open === '1' ? entry.text : entry.full;
      body.dataset.open = body.dataset.open === '1' ? '0' : '1';
    };
  }
  row.append(body);
  return row;
}



function feedEntry(agent, event) {
  const who = agent?.label ?? event.agentId;
  const at = new Date(event.ts).toLocaleTimeString([], { hour12: false });
  const payload = event.payload ?? {};

  if (event.kind === EVENT_KINDS.MESSAGE) {
    const text = String(payload.text ?? '').trim();
    if (plainText(text).length < 12) return null;
    return { at, who, suffix: payload.from === 'you' ? ' (from you)' : '', text, markdown: true, tone: '' };
  }
  if (event.kind === EVENT_KINDS.TOOL && payload.phase !== 'completed') {
    const target = String(payload.target ?? '');
    const short = payload.action === 'run' ? summariseCommand(target) : target.replace(/\s+/g, ' ').trim();
    return {
      at, who, text: `${payload.action} ${short}`, markdown: false, tone: 'tool', full: target,
    };
  }
  if (event.kind === EVENT_KINDS.CLAIM) {
    const receipt = payload.receipt ? `  <- ${payload.receipt}` : '  <- no receipt';
    return { at, who, text: `${payload.text}${receipt}`, markdown: false, tone: payload.receipt ? '' : 'alert' };
  }
  if (event.kind === EVENT_KINDS.BLOCKED) {
    const reason = String(payload.reason ?? '');
    const short = reason.length > 90 ? `${reason.slice(0, 8)}${summariseCommand(reason.slice(8))}` : reason;
    return { at, who, text: `BLOCKED - ${short}`, markdown: false, tone: 'alert', full: reason };
  }
  if (event.kind === EVENT_KINDS.APPROVAL && !payload.resolved) {
    return { at, who, text: `NEEDS YOU - ${payload.summary ?? ''}`, markdown: false, tone: 'alert' };
  }
  if (event.kind === EVENT_KINDS.STATUS && payload.text) {
    return { at, who: '', text: payload.text, markdown: false, tone: '' };
  }
  return null;
}

let headerEl = null;
let feedBody = null;

// The feed is a window like any other: same chrome, same dock switch, same
// dragging and resizing. Building it here rather than in the markup only means
// nobody else has to know it exists.
function mountFeed() {
  const win = document.createElement('section');
  win.id = 'winFeed';
  win.className = 'win';

  const bar = document.createElement('div');
  bar.className = 'win-bar';

  feedBody = document.createElement('div');
  feedBody.className = 'win-body';
  feedBody.id = 'feed';

  win.append(bar, feedBody);
  document.body.append(win);

  dom.winFeed = win;
  dom.feed = feedBody;
  mountFeedButton();
}

// The prayer thread. One hero asked you something only they could know to
// ask; this is where the two of you settle it. It stays open until YOU say it
// is settled - answering once does not end a conversation.
function openPrayer(agentId) {
  state.prayerWith = agentId;
  openWindow('decisions');
  schedulePanels();
}

function prayerThread(agentId) {
  const events = state.eventsByAgent[agentId] ?? [];
  const start = events.findLastIndex(
    (event) => event.kind === EVENT_KINDS.PRAYER && !event.payload?.answered,
  );
  if (start === -1) return null;
  const question = events[start].payload;
  // Everything either of you has said since they asked.
  const said = events.slice(start + 1).filter((event) =>
    event.kind === EVENT_KINDS.MESSAGE || event.kind === EVENT_KINDS.PRAYER);
  return { question, said, askedAt: events[start].ts };
}

function renderPrayer(into) {
  const prayerBody = into;
  if (!prayerBody) return;
  const agentId = state.prayerWith;
  const agent = agentId ? state.agents[agentId] : null;
  const thread = agentId ? prayerThread(agentId) : null;

  // No thread picked - so show WHO is waiting. The tab counts four questions;
  // opening it to "nobody has asked you anything" is the badge calling the
  // panel a liar.
  if (!agent || !thread) {
    const waiting = orderedAgents()
      .map((candidate) => ({ agent: candidate, thread: prayerThread(candidate.id) }))
      .filter((row) => row.thread);

    if (waiting.length === 0) {
      const idle = document.createElement('div');
      idle.style.cssText = 'padding:10px 0;color:var(--muted,#8a8a8a)';
      idle.textContent = agentId
        ? 'settled - nothing is waiting on you here'
        : 'nobody has asked you anything';
      prayerBody.replaceChildren(idle);
      return;
    }

    const head = document.createElement('div');
    head.style.cssText = 'font-size:9px;letter-spacing:.12em;color:var(--faint,#5a5a5a);padding-bottom:8px';
    head.textContent = `${waiting.length} WAITING ON YOU`;

    const rows = waiting.map(({ agent: who, thread: t }) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.style.cssText = 'display:block;width:100%;text-align:left;background:transparent;'
        + 'border:0;border-bottom:1px solid var(--line,#262626);color:inherit;font:inherit;'
        + 'padding:8px 0;cursor:pointer';
      const name = document.createElement('div');
      name.style.cssText = 'font-size:9px;letter-spacing:.12em;color:var(--accent,#34d399)';
      name.textContent = (who.label ?? who.name).toUpperCase();
      const asked = document.createElement('div');
      asked.style.cssText = 'padding-top:2px';
      asked.textContent = t.question.why;
      row.append(name, asked);
      row.onclick = () => openPrayer(who.id);
      return row;
    });
    prayerBody.replaceChildren(head, ...rows);
    return;
  }

  const rows = [];
  const who = document.createElement('button');
  who.type = 'button';
  who.style.cssText = 'display:block;width:100%;text-align:left;background:transparent;border:0;'
    + 'font:inherit;font-size:10px;letter-spacing:.12em;color:var(--accent,#34d399);'
    + 'padding:0 0 6px;cursor:pointer';
  who.textContent = `\u2190 ${(agent.label ?? agent.name).toUpperCase()} ASKED YOU`;
  who.title = 'back to everyone waiting';
  who.onclick = () => { state.prayerWith = null; schedulePanels(); };
  rows.push(who);

  const asked = document.createElement('div');
  asked.style.cssText = 'padding:8px 10px;border-left:2px solid var(--accent,#34d399);'
    + 'background:var(--sunk,#1a1a1a);margin-bottom:10px';
  asked.textContent = thread.question.why;
  rows.push(asked);

  for (const event of thread.said) {
    const mine = event.payload?.from === 'you';
    const line = document.createElement('div');
    line.style.cssText = 'padding:5px 0;border-bottom:1px solid var(--line,#262626)';
    const tag = document.createElement('span');
    tag.style.cssText = `font-size:9px;letter-spacing:.12em;margin-right:8px;color:${
      mine ? 'var(--accent,#34d399)' : 'var(--muted,#8a8a8a)'}`;
    tag.textContent = mine ? 'YOU' : (agent.label ?? agent.name).toUpperCase();
    line.append(tag, document.createTextNode(plainText(event.payload?.text ?? event.payload?.answer ?? '')));
    rows.push(line);
  }

  const reply = document.createElement('input');
  reply.dataset.field = `reply:${agentId}`;
  reply.placeholder = `answer ${agent.label ?? agent.name}`;
  reply.style.cssText = 'width:100%;margin-top:10px;background:var(--bg,#0d0d0d);'
    + 'border:1px solid var(--line,#262626);color:inherit;font:inherit;padding:6px 8px';
  reply.onkeydown = (event) => {
    event.stopPropagation();
    if (event.key !== 'Enter' || !reply.value.trim()) return;
    send('say', { target: agentId, text: reply.value.trim() });
    reply.value = '';
  };
  rows.push(reply);

  const settled = document.createElement('button');
  settled.type = 'button';
  settled.textContent = 'SETTLED';
  settled.title = 'close this question - it stays open until you say so';
  settled.style.cssText = 'margin-top:8px;background:transparent;border:1px solid var(--line,#262626);'
    + 'color:var(--muted,#8a8a8a);font:inherit;font-size:9px;letter-spacing:.12em;padding:3px 9px;cursor:pointer';
  settled.onclick = () => send('settlePrayer', { agentId });
  rows.push(settled);

  prayerBody.replaceChildren(...rows);
}

// A switch on the console, cloned from its neighbours so it cannot drift out
// of style with them.
function mountFeedButton() {
  const sibling = dom.btnCrew ?? dom.btnDecisions;
  if (!sibling?.parentElement) return;
  const button = sibling.cloneNode(false);
  button.id = 'btnFeed';
  button.textContent = 'FEED';
  button.removeAttribute('aria-pressed');
  sibling.parentElement.insertBefore(button, sibling);
  dom.btnFeed = button;
}

// ------------------------------------------------------------- middleware
//
// What every agent is told, and the ability to rewrite it. These steps ride on
// every dispatch and every steer, so this panel is where the fleet's manners
// are actually set.

let middlewareBody = null;
let middlewareSteps = [];

function mountMiddleware() {
  const win = document.createElement('section');
  win.id = 'winMiddleware';
  win.className = 'win';
  const bar = document.createElement('div');
  bar.className = 'win-bar';
  middlewareBody = document.createElement('div');
  middlewareBody.className = 'win-body';
  middlewareBody.id = 'middleware';
  win.append(bar, middlewareBody);
  document.body.append(win);
  dom.winMiddleware = win;

  const sibling = dom.btnDecisions ?? dom.btnRuns ?? dom.btnCrew;
  if (sibling?.parentElement) {
    const button = sibling.cloneNode(false);
    button.id = 'btnMiddleware';
    button.textContent = 'MIDDLEWARE';
    sibling.parentElement.append(button);
    dom.btnMiddleware = button;
  }
}

async function loadMiddleware() {
  const data = await fetch('/middleware').then((r) => r.json()).catch(() => null);
  if (!data) return;
  middlewareSteps = data.steps ?? [];
  renderMiddleware(data.order ?? []);
}

function renderMiddleware(order) {
  if (!middlewareBody) return;

  const intro = document.createElement('div');
  intro.style.cssText = 'padding:6px 0 10px;color:var(--muted,#8a8a8a)';
  intro.textContent = `Every dispatch is built from these, in order: ${order.join(' → ')}`;

  middlewareBody.replaceChildren(intro, ...middlewareSteps.map(stepEditor));
}

function stepEditor(step) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'padding:8px 0;border-bottom:1px solid var(--line,#262626)';

  const head = document.createElement('div');
  head.style.cssText =
    'display:flex;align-items:center;gap:8px;font-size:10px;letter-spacing:.12em;'
    + 'text-transform:uppercase;color:var(--muted,#8a8a8a)';
  const name = document.createElement('span');
  name.textContent = step.name;
  if (step.overridden) {
    name.style.color = 'var(--accent,#34d399)';
    name.textContent += ' · yours';
  }
  head.append(name);

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'act';
  save.textContent = 'SAVE';
  save.style.cssText = 'margin-left:auto;flex:none';

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'act';
  reset.textContent = 'RESET';
  reset.style.flex = 'none';

  const box = document.createElement('textarea');
  box.value = step.text;
  box.rows = 8;
  box.spellcheck = false;
  box.setAttribute('aria-label', `${step.name} prompt`);
  box.style.cssText = [
    'width:100%', 'margin-top:6px', 'resize:vertical', 'font:inherit',
    'background:var(--bg,#0a0a0a)', 'color:var(--text,#e8e8e8)',
    'border:1px solid var(--line,#262626)', 'padding:6px 8px', 'white-space:pre-wrap',
  ].join(';');

  save.onclick = async () => {
    await send('setMiddleware', { name: step.name, text: box.value });
    await loadMiddleware();
  };
  reset.onclick = async () => {
    await send('resetMiddleware', { name: step.name });
    await loadMiddleware();
  };

  head.append(save, reset);
  wrap.append(head, box);
  return wrap;
}

// Nothing you press may be silent. Whatever the action was - a steer, an
// answer, a kill - a token leaves the control you pressed, crosses the room,
// lands on that desk, and the agent reacts to it arriving.
function flyMessage({ target, text, from }) {
  flyTo({ agentId: target === MISSION_TARGET ? orchestratorId() : target, text, from });
}

function flyTo({ agentId, text = '', from, tone = 'neutral' }) {
  const to = scene?.screenPos?.(agentId);
  if (!to || !from) return;
  const ink = tone === 'fail' ? 'var(--danger, #f87171)' : 'var(--accent, #34d399)';

  const note = document.createElement('div');
  note.className = 'flyer';
  note.textContent = text.length > 60 ? `${text.slice(0, 57)}…` : text || 'attachment';
  note.style.cssText = [
    'position:fixed', 'z-index:55', 'pointer-events:none', 'max-width:280px',
    'padding:4px 8px', 'font:11px/1.4 Menlo, monospace', 'white-space:nowrap',
    'overflow:hidden', 'text-overflow:ellipsis',
    'background:var(--surface, #121212)', `color:${ink}`,
    `border:1px solid ${ink}`,
    `left:${from.left + 16}px`, `top:${from.top}px`,
  ].join(';');
  document.body.append(note);

  const canvas = dom.floor?.getBoundingClientRect() ?? { left: 0, top: 0 };
  const dx = canvas.left + to.x - (from.left + 16);
  const dy = canvas.top + to.y - from.top;

  // Reduced motion still lands: no flight, but the same arrival.
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    note.remove();
    land(agentId, tone);
    return;
  }

  note
    .animate(
      [
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
        { transform: `translate(${dx * 0.6}px, ${dy * 0.6 - 40}px) scale(0.9)`, opacity: 1, offset: 0.6 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.4)`, opacity: 0 },
      ],
      { duration: 620, easing: 'cubic-bezier(.2,.7,.3,1)' },
    )
    .addEventListener('finish', () => {
      note.remove();
      land(agentId, tone);
    });
}

// The arrival. The desk rings with the same pulse a verified step uses, and
// the agent plays its own move, so a message is answered by the agent it was
// sent to rather than by a generic flash.
function land(agentId, tone) {
  const agent = viewAgents(Date.now()).find((candidate) => candidate.id === agentId);
  if (!agent) return;
  state.pulses.push({ ...deskSpot(agent), born: Date.now() });
  fireMove(agentId, tone);
}

function orchestratorId() {
  return Object.values(state.agents).find((agent) => agent.role === 'orchestrator')?.id
    ?? firstWorker()?.id;
}

// ------------------------------------------------------------ folder picker
//
// The browser cannot hand a real path to a process, so browsing happens on the
// server and this only draws what it returns.

let picker = null;

async function openPicker(startAt) {
  closePicker();
  picker = document.createElement('div');
  picker.className = 'picker';
  picker.setAttribute('role', 'dialog');
  picker.setAttribute('aria-label', 'Choose the working folder');
  // Baseline so the picker is usable on its own; the stylesheet may override.
  picker.style.cssText = [
    'position:fixed', 'z-index:60', 'left:50%', 'top:64px', 'transform:translateX(-50%)',
    'width:min(560px, 90vw)', 'max-height:60vh', 'display:flex', 'flex-direction:column',
    'gap:8px', 'padding:12px', 'background:var(--surface, #121212)',
    'color:var(--text, #e8e8e8)', 'border:1px solid var(--line, #262626)',
    'font:12px/1.5 Menlo, monospace',
  ].join(';');
  document.body.append(picker);
  await showDir(startAt);
}

function closePicker() {
  picker?.remove();
  picker = null;
}

async function showDir(path) {
  const listing = await fetch(`/dirs?path=${encodeURIComponent(path ?? '')}`)
    .then((response) => response.json())
    .catch(() => null);
  if (!listing || !picker) return;

  const head = document.createElement('div');
  head.className = 'picker-head';
  head.textContent = listing.path;
  head.style.cssText = 'direction:rtl;text-align:left;overflow:hidden;white-space:nowrap;color:var(--muted,#8a8a8a)';

  const use = document.createElement('button');
  use.className = 'act';
  use.textContent = 'USE THIS FOLDER';
  use.style.cssText =
    'padding:6px 10px;background:var(--accent,#34d399);color:var(--bg,#0a0a0a);border:0;' +
    'font:inherit;letter-spacing:.08em;cursor:pointer;';
  use.onclick = async () => {
    const result = await send('setRepo', { dir: listing.path });
    if (result.ok) closePicker();
  };

  const rows = document.createElement('div');
  rows.className = 'picker-list';
  rows.style.cssText = 'overflow:auto;flex:1;min-height:0;border:1px solid var(--line,#262626)';
  rows.append(row('..', () => showDir(listing.parent)));
  for (const name of listing.children) {
    rows.append(row(name, () => showDir(`${listing.path}/${name}`.replace('//', '/'))));
  }

  picker.replaceChildren(head, rows, use);
}

function row(label, onPick) {
  const item = document.createElement('div');
  item.className = 'picker-row';
  item.tabIndex = 0;
  item.textContent = label;
  item.style.cssText = 'padding:4px 8px;cursor:pointer;';
  item.onmouseenter = () => { item.style.background = 'var(--nested, #1a1a1a)'; };
  item.onmouseleave = () => { item.style.background = ''; };
  item.onclick = onPick;
  item.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onPick();
    }
  };
  return item;
}

// A failure must never present as a blank screen: the windows still work and
// the reason is on screen.
function boot() {
  try {
    // Clicking a desk selects the agent AND opens their side of the story -
    // the feed, filtered to them. Selecting in silence was the complaint.
    scene = createScene({
      canvas: dom.floor,
      palette,
      onSelect: openAgentFeed,
      onHover: (id) => {
        if (state.hovered === id) return;
        state.hovered = id;
        schedulePanels(); // the bubble follows the pointer at once
      },
    });
  } catch (error) {
    note(`floor unavailable: ${error.message}. The windows still work.`);
  }

  composer = createComposer({
    dom: {
      input: dom.composerInput,
      send: dom.composerSend,
      menu: dom.mentionMenu,
      targetChip: dom.composerTarget,
      attachments: dom.attachments,
      file: dom.fileInput,
    },
    send,
    getAgents: () => orderedAgents(),
    getTarget: () => state.target,
    setTarget: (target) => {
      state.target = target;
      renderPanels();
    },
    onSend: flyMessage,
  });

  // The feed's element and dock switch must exist before the window manager
  // takes inventory, or it manages five windows and ignores the sixth.
  markdownReady.then(() => renderPanels());
  mountMarkdownStyles();
  mountHeader();
  mountFeed();
  mountMiddleware();

  // The console's extra row when a desk is focused.
  strip = createGoalStrip({
    handlers,
    console: dom.composer,
    // The desk draws a flow and a claim with the same functions the panels
    // use. One way to draw each, wherever it appears.
    renderFlows,
    renderEvidence,
  });

  windows = createSidePanel({
    entries: windowEntries(),
    labels: { feed: 'FEED', crew: 'CREW', decisions: 'DECISIONS',
              runs: 'MISSIONS', middleware: 'MIDDLEWARE' },
    onChange: () => renderPanels(),
  });

  wireChrome();
  // A read-only window onto the one part of the floor you cannot see. It
  // reports; nothing in the app ever reads it back.
  window.minimac = Object.freeze({ sound: () => sound.probe() });
  // A read-only probe for verifying the walk without eyes on the screen.
  window.__mmErrand = () => ({
    active: state.errands.active
      ? { hero: state.errands.active.heroId, to: state.errands.active.toId,
          phase: state.errands.active.phase }
      : null,
    pending: state.errands.pending.length,
    waypoint: viewAgents(Date.now()).find((a) => a.errand)?.errand ?? null,
  });
  dom.btnAttach?.addEventListener('click', () => dom.fileInput?.click());
  subscribe();
  loadRuns();
  loadMiddleware();
  // While the window is open the current run is still growing, so the row keeps
  // up with it. Closed, this costs nothing.
  setInterval(() => {
    if (windows?.isOpen('runs')) loadRuns();
  }, RUNS_REFRESH_MS);
  renderPanels();
  requestAnimationFrame(frame);
}

async function loadRuns() {
  state.runs = await fetch('/runs')
    .then((response) => response.json())
    .then((body) => (body.runs ?? []).map((run) => ({ ...run, current: run.id === state.runId })))
    .catch(() => []);
  renderPanels();
}

function note(text) {
  if (!text || !dom.topbar) return;
  let slot = dom.topbar.querySelector('.notice');
  if (!slot) {
    slot = document.createElement('span');
    slot.className = 'notice';
    dom.topbar.append(slot);
  }
  slot.textContent = text;
  setTimeout(() => slot.remove(), 6000);
}

function pickDom() {
  const ids = [
    'floor', 'topbar', 'repoPath', 'queueCount', 'startAll', 'planAll', 'crewBar',
    'composer', 'composerTarget', 'composerInput', 'composerSend', 'mentionMenu',
    'attachments', 'fileInput', 'btnAttach',
    'winDecisions', 'winDecisionsClose', 'queue', 'bubbles', 'btnDecisions',
    'winCrew', 'winCrewClose', 'roster', 'roCrew', 'btnCrew',
    'winFlows', 'winFlowsClose', 'flows', 'btnFlows', 'focusName',
    'winRuns', 'winRunsClose', 'runs', 'roRuns', 'btnRuns', 'stopAll', 'btnSound',
  ];
  return Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
}

function readPalette() {
  const style = getComputedStyle(document.documentElement);
  const read = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  return {
    floor: read('--floor-bg', '#101010'),
    wall: '#161616',
    line: read('--line', '#262626'),
    desk: '#3b3b3b',
    deskDark: '#2a2a2a',
    frame: '#2f2f2f',
    paper: '#cfcfcf',
    body: '#9a9a9a',
    hair: '#5a5a5a',
    dim: '#2e2e2e',
    idle: '#5f6360',
    muted: read('--muted', '#8a8a8a'),
    accent: read('--accent', '#34d399'),
    danger: read('--danger', '#f87171'),
  };
}

boot();


// ---------------------------------------------------------------- chrome
// Declared at the end on purpose: function declarations hoist, so boot can
// call them wherever they live, and an edit elsewhere cannot leave a hole.

function mountMarkdownStyles() {
  const style = document.createElement('style');
  style.textContent = `
    @keyframes bubble-new {
      0% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.6); opacity: .55; }
      100% { transform: scale(1); opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      [style*="bubble-new"] { animation: none !important; }
    }
    .md { white-space: normal; }
    .md p { margin: 2px 0; }
    .md h1, .md h2, .md h3, .md h4, .md h5, .md h6 {
      margin: 6px 0 2px; font-size: 11px; letter-spacing: .06em;
      text-transform: uppercase; color: var(--accent, #34d399);
    }
    .md ul, .md ol { margin: 2px 0; padding-left: 16px; }
    .md li { margin: 1px 0; }
    .md code { padding: 0 3px; border: 1px solid var(--line, #262626); }
    .md pre {
      margin: 4px 0; padding: 6px 8px; overflow-x: auto;
      background: var(--bg, #0a0a0a); border: 1px solid var(--line, #262626);
    }
    .md pre code { white-space: pre; border: 0; padding: 0; }
    .md blockquote {
      margin: 4px 0; padding-left: 8px;
      border-left: 2px solid var(--line, #262626); color: var(--muted, #8a8a8a);
    }
    .md hr { border: 0; border-top: 1px solid var(--line, #262626); margin: 6px 0; }
    .md a { color: var(--accent, #34d399); }
    .md strong { color: var(--text, #e8e8e8); }
    .md table { border-collapse: collapse; margin: 4px 0; }
    .md th, .md td { border: 1px solid var(--line, #262626); padding: 2px 6px; }
  `;
  document.head.append(style);
}

// The header answers the two questions you ask walking up to the screen: what
// are they working on, and is anything actually happening.
function mountHeader() {
  if (!dom.topbar) return;
  headerEl = document.createElement('div');
  headerEl.className = 'mission-state';
  headerEl.style.cssText =
    'display:flex;align-items:baseline;gap:10px;min-width:0;flex:1;font:11px/1.4 Menlo, monospace';
  dom.topbar.append(headerEl);
}

// Durations in the fewest characters that stay honest.
function shortMs(ms) {
  const m = Math.round((ms ?? 0) / 60000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

function renderHeader(agents) {
  if (!headerEl) return;
  const running = agents.filter((agent) => agent.status === 'running').length;
  const blocked = agents.filter((agent) => agent.status === 'blocked').length;
  const tone = blocked
    ? 'var(--danger,#f87171)'
    : running
      ? 'var(--accent,#34d399)'
      : 'var(--muted,#8a8a8a)';

  const chip = document.createElement('span');
  chip.textContent = blocked
    ? `${blocked} BLOCKED`
    : running
      ? `RUNNING ${running}/${agents.length}`
      : 'IDLE';
  chip.style.cssText =
    `flex:none;padding:1px 7px;letter-spacing:.12em;font-size:10px;border:1px solid ${tone};color:${tone}`;

  const mission = state.mission ?? '';
  const text = document.createElement('span');
  text.textContent = mission || 'no mission set';
  text.title = mission;
  text.style.cssText =
    'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:'
    + (mission ? 'var(--text,#e8e8e8)' : 'var(--muted,#8a8a8a)');

  // The north star as one number: ten minutes of agent work should take ten
  // minutes. It sits in the top bar because it is the only figure that is
  // always worth a glance.
  // The question is never "how long" on its own. It is how much longer, what
  // is left, and how far along - so the header answers all three without being
  // asked, which is the whole reason this exists.
  const measured = agents.map((agent) => ({ ...agent, flows: measuredFlows(agent) }));
  const burn = fleetBurn(measured);
  const left = remaining(measured.flatMap((agent) => agent.flows));
  const kids = [chip, text];

  const parts = [];
  if (left.total > 0) parts.push(`${left.steps} of ${left.total} left`);
  if (left.percentDone !== null) parts.push(`${left.percentDone}% done`);
  if (burn) parts.push(`${shortMs(burn.actualMs)} of ${shortMs(burn.estimateMs)}`);

  if (parts.length) {
    const late = !!burn && burn.ratio > 1;
    const fleet = document.createElement('span');
    fleet.textContent = parts.join(' · ');
    fleet.title = late
      ? 'the fleet is past the time it promised itself'
      : 'what is left, how far along, and time against the fleet\'s own estimate';
    fleet.style.cssText = 'flex:none;margin-left:auto;padding-left:10px;font-size:10px;'
      + 'letter-spacing:.08em;font-variant-numeric:tabular-nums;color:'
      + (late ? 'var(--danger,#f87171)' : 'var(--muted,#8a8a8a)');
    kids.push(fleet);
  }
  headerEl.replaceChildren(...kids);
}
