// Composition root for the view. Subscribes to the server, derives the view
// model with the same core functions the server uses, and hands it to the
// room, the docked windows and the composer. No rules live here.

import { EVENT_KINDS } from '../core/events.mjs';
import { stateOf as checkpointState } from '../core/board.mjs';
import { crosstalkDelivery } from '../core/coordination.mjs';
import {
  agentPose,
  detectLoops,
  eventsPerMin,
  gradeClaims,
} from '../core/derive.mjs';
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
import { renderQueue, renderRoster, renderFlows } from './panels.mjs';
import { createComposer, MISSION_TARGET, SPEAK_TARGETS } from './composer.mjs';
import { createSidePanel } from './sidepanel.mjs';
import { createGoalStrip } from './goalstrip.mjs';
import { createSound } from './sound.mjs';
import { renderMarkdown, markdownReady } from './markdown.mjs';
import { createControlButton } from './controls.mjs';
import {
  CONTEXT_KIND, messagesForContext, messagesForThread,
} from '../core/conversation.mjs';
import { renderMessageGroup } from './conversation.mjs';
import { renderEntityDetail } from './entity-detail.mjs';
import { captureScrollAnchor, restoreScrollAnchor } from './scroll-anchor.mjs';
import { CUES, cueFor, keyOf, neglect, trackWaiting } from '../core/attention.mjs';
import {
  describeEvent,
  firstLine,
  plainText,
  shortenDetail,
  summariseCommand,
  isMachineNoise,
  doingWords,
} from '../core/readable.mjs';
import {
  DETAIL_LEVELS as FEED_LEVELS, ACTIVITY_FILTERS as FEED_PRESETS,
  checkpointThreadSummary, missionNarrative,
} from '../core/activity.mjs';

const PULSE_MS = 900;
const PING_MS = 700;
const PANEL_THROTTLE_MS = 150;
const RUNS_REFRESH_MS = 3000;
const CHECKPOINT_CLOCK_MS = 1000;
let lastCheckpointClockAt = 0;

const dom = pickDom();

const state = {
  agents: {},
  goals: {},
  claims: {},
  cards: [],
  board: [],
  flows: [],
  progress: null,
  acceptance: null,
  quality: [],
  contradictions: [],
  tokenEstimate: null,
  workspace: null,
  // Orders being carried across the floor, one at a time.
  errands: createErrands(),
  errandPhase: null,
  hovered: null,
  feedPreset: 'all',
  feedLevel: 'summary',
  feedFiltersOpen: false,
  feedQuery: '',
  feedCheckpoint: '',
  feedWorkUnit: '',
  feedStage: '',
  feedReplyTo: null,
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
  selectedRunId: null,
  selectedMission: '',
  selectedMissionView: null,
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
// Feed rows are rebuilt whenever a live event arrives. Keep disclosure state
// outside those short-lived DOM nodes so the reader's choices survive updates.
const expandedFeedRows = new Set();
let renderedFeedView = null;

// ------------------------------------------------------------------ server

// Names for what you just did, so an action is never silent. One place, so
// every button reads the same way in the feed.
const ACTION_WORDS = Object.freeze({
  start: 'start', interrupt: 'kill', say: 'send', steer: 'steer',
  approve: 'answer', setGoal: 'set goal', clearGoal: 'clear goal',
  assignEngine: 'switch engine', configureRuntime: 'set model / effort', setMission: 'set mission', newRun: 'new run',
  continueRun: 'continue run', resumeRun: 'run again', stopRun: 'stop run',
  setRepo: 'change folder', claim: 'claim files', release: 'release files',
  setMiddleware: 'edit middleware', resetMiddleware: 'reset middleware',
  assemble: 'assemble', settlePrayer: 'settle', setActive: 'set active',
  moveCheckpoint: 'reorder checkpoint', pauseCheckpoint: 'pause checkpoint',
  reassignCheckpoint: 'reassign checkpoint', forceStartCheckpoint: 'start checkpoint',
  assignWork: 'add checkpoint',
  setAcceptance: 'set required proof',
});

async function send(type, payload = {}) {
  const who = payload.agentId ?? payload.target;
  const label = ACTION_WORDS[type] ?? type;
  if (type !== 'resolveResource') {
    ingest(createLocalEvent(who && state.agents[who] ? who : 'minimac', EVENT_KINDS.STATUS, {
      text: `you: ${label}${who && state.agents[who] ? ` → ${state.agents[who].label}` : ''}`,
      from: 'you',
    }));
    schedulePanels();
  }

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
  if (body.ok && ['postConversation', 'replyConversation', 'reactConversation', 'setInstances'].includes(type)) {
    setTimeout(() => refreshOpenEntity(), 0);
  }
  if (body.ok && type === 'setMission' && body.result?.runId) {
    state.selectedRunId = body.result.runId;
    state.selectedMission = body.result.mission ?? '';
    state.selectedMissionView = null;
    seededRunId = body.result.runId;
    setRunUrl(body.result.runId);
    state.eventsByAgent = {};
  }
  return body;
}

function subscribe() {
  const source = new EventSource('/events');
  source.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.type === 'state') applySnapshot(data.state);
    if (data.type === 'event' && data.runId === state.selectedRunId) {
      ingest(data.event, data.agent);
    }
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
  state.flows = snapshot.flows ?? state.flows;
  state.progress = snapshot.progress ?? state.progress;
  state.acceptance = snapshot.acceptance ?? state.acceptance;
  state.quality = snapshot.quality ?? state.quality;
  state.contradictions = snapshot.contradictions ?? state.contradictions;
  state.tokenEstimate = snapshot.tokenEstimate ?? state.tokenEstimate;
  state.workspace = snapshot.workspace ?? state.workspace;
  state.runId = snapshot.runId;
  if (!state.selectedRunId || state.selectedRunId === snapshot.runId) {
    state.selectedMissionView = null;
  }
  state.repo = snapshot.repo ?? state.repo;
  state.mission = snapshot.mission ?? state.mission;
  const requestedRun = runIdFromUrl();
  if (!requestedRun && state.runId) setRunUrl(state.runId, { replace: true });
  const selectedRun = requestedRun ?? state.runId;
  if (selectedRun === state.runId) state.selectedMission = state.mission;
  if (selectedRun && selectedRun !== seededRunId) {
    state.selectedRunId = selectedRun;
    seededRunId = selectedRun;
    seedFromRun(selectedRun);
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
  for (const [agentId, goal] of Object.entries(after)) {
    const objective = goal?.objective ?? '';
    if (!objective || objective === (before?.[agentId]?.objective ?? '')) continue;
    // The desk says what it was just told to do, in one line, for as long as
    // any other bubble would hold.
    shownBubble.set(agentId, { text: firstLine(objective), at: Date.now() });
  }
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

// Every directed Crosstalk event uses the same domain projection. The scene
// only owns animation state; it does not decide who spoke to whom.
function noticeErrand(event) {
  const delivery = crosstalkDelivery(event);
  if (!delivery) return;
  state.errands = enqueueErrand(state.errands, {
    eventId: delivery.eventId,
    heroId: delivery.fromAgentId,
    toId: delivery.toAgentId,
    message: delivery.message,
  }, Date.now());
  addPing(delivery.fromAgentId, delivery.toAgentId);
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
      return event.kind === EVENT_KINDS.CONVERSATION_MESSAGE ? { tone: 'neutral' } : null;
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
    };
    if (!isOrchestrator) index += 1;
    return model;
  });
}

function claimsFor(agentId) {
  const events = state.eventsByAgent[agentId] ?? [];
  const claims = events
    .filter((event) => event.kind === EVENT_KINDS.CLAIM)
    .map((event) => event.payload);
  return gradeClaims(claims).graded;
}

function decisions() {
  return state.cards;
}

// ------------------------------------------------------------------ render

let panelsQueued = false;
let lastBubbleAt = 0;
let seededRunId = null;
const rendered = new Map();
const deferred = new WeakSet();

// Everything is already in SQLite, so a reload rejoins the run in progress
// instead of starting from an empty feed.
async function seedFromRun(runId) {
  const { run = null, events = [], missionState = null } = await fetch(`/replay?run=${runId}`)
    .then((response) => response.json())
    .catch(() => ({ run: null, events: [], missionState: null }));

  if (runId !== state.selectedRunId) return;
  state.selectedMission = run?.mission ?? (runId === state.runId ? state.mission : '');
  state.selectedMissionView = runId === state.runId ? null : missionState;
  const byAgent = {};
  for (const event of events.slice(-1500)) {
    (byAgent[event.agentId] ??= []).push(event);
  }
  state.eventsByAgent = Object.fromEntries(
    Object.entries(byAgent).map(([agentId, list]) => [agentId, list.slice(-800)]),
  );
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

function rosterView(agents, board = state.board, readOnly = false) {
  return agents.map((agent) => {
    const checkpoints = board
      .filter((item) => item.owner === agent.id)
      .map((item) => ({
        id: item.id,
        title: item.title || item.outcome,
        state: checkpointState({ items: board }, item),
      }));
    const messages = (state.eventsByAgent[agent.id] ?? [])
      .filter((event) => event.kind === EVENT_KINDS.CONVERSATION_MESSAGE && plainText(event.payload?.message?.body ?? ''))
      .slice(-3)
      .map((event) => ({
        id: event.payload?.message?.id ?? `${agent.id}:${event.ts}`,
        text: firstLine(plainText(event.payload?.message?.body ?? '')),
        checkpointId: event.payload?.message?.context?.kind === 'checkpoint' ? event.payload.message.context.id : null,
        ts: event.ts,
      }));
    return {
      id: agent.id,
      label: agent.label,
      name: agent.name,
      role: agent.role,
      status: readOnly ? 'stopped' : agent.status,
      selected: agent.selected,
      enabled: agent.enabled,
      active: readOnly ? false : agent.active,
      instances: agent.instances,
      engine: agent.engine,
      model: agent.model,
      effort: agent.effort,
      goal: agent.goal,
      readOnly,
      checkpoints,
      messages,
    };
  });
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
  const readingLiveMission = !state.selectedRunId || state.selectedRunId === state.runId;
  const missionView = readingLiveMission ? null : state.selectedMissionView;
  const board = missionView?.board ?? state.board;
  const flows = missionView?.flows ?? state.flows;
  const progress = missionView?.progress ?? state.progress;
  const agents = viewAgents(now);
  const queue = readingLiveMission ? decisions(now) : [];

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

  // Evidence follows the focused agent. Flow belongs to the mission and is a
  // read-only projection of its checkpoints, so focus cannot change progress.
  const focused = agents.find((agent) => agent.selected) ?? agents[0];
  if (dom.roster && windows?.isOpen('crew')) {
    const connectedAgents = rosterView(agents, board, !readingLiveMission);
    renderChanged('crew', dom.roster, connectedAgents, () => {
      renderRoster(dom.roster, connectedAgents, handlers);
    });
  }
  if (dom.roCrew) {
    const running = agents.filter((agent) => agent.status === 'running').length;
    dom.roCrew.textContent = `${running}/${agents.length} RUNNING`;
  }
  if (dom.flows && windows?.isOpen('flows')) {
    const missionFlow = { id: 'mission', name: 'mission', steps: flows };
    renderChanged('flows', dom.flows, flows, () => {
      renderFlows(dom.flows, missionFlow, { openCheckpoint: openCheckpointThread });
    });
  }
  if (dom.checkpoints && windows?.isOpen('checkpoints')) {
    const workState = agents.map((agent) => [
      agent.id,
      agent.status,
      agent.enabled,
      (agent.workers ?? []).map((worker) => [
        worker.id, worker.state, worker.sessionId, worker.checkpointId,
      ]),
      agent.workItemIds,
    ]);
    renderChanged('checkpoints', dom.checkpoints, [
      board, progress, workState,
    ], () => {
      panels.renderBoard(dom.checkpoints, board, progress, agents, {
        readOnly: !readingLiveMission,
        move: (id, direction) => send('moveCheckpoint', { id, direction }),
        pause: (id, paused) => send('pauseCheckpoint', { id, paused }),
        start: (id) => send('forceStartCheckpoint', { id }),
        reassign: (id, owner) => send('reassignCheckpoint', { id, owner }),
        add: (checkpoint) => send('assignWork', checkpoint),
        openThread: openCheckpointThread,
        openAgent: (agentId) => {
          focus(agentId);
          openWindow('crew');
        },
      }, { readOnly: !readingLiveMission });
    });
  }
  // The focused name still identifies the chat target. It does not own Flow.
  if (dom.focusName) dom.focusName.textContent = focused?.name ?? '';
  // One queue. A hero's question is a decision like any other, so answering it
  // happens here rather than behind a second tab that counted the same things.
  if (dom.queue && windows?.isOpen('decisions')) {
    renderChanged('decisions', dom.queue, queue, () => {
      keepingField(dom.queue, () => {
        renderQueue(dom.queue, queue, handlers);
      });
    }, { deferWhileEditing: false });
  }
  if (dom.queueCount) dom.queueCount.textContent = String(queue.length);
  const runningCheckpoints = board.filter((item) => item.lease?.state === 'running').length;
  const openCheckpoints = board.filter((item) => item.closedAt == null
    && item.disposition !== 'cancelled' && item.disposition !== 'replaced').length;
  const completedFlows = flows.filter((flow) => flow.status === 'verified').length;
  const flowPercent = flows.length
    ? Math.round((completedFlows / flows.length) * 100)
    : 0;
  const activeAvengers = readingLiveMission
    ? agents.filter((agent) => agent.active).length
    : 0;
  windows?.setMissionContext?.({ id: state.selectedRunId, title: state.selectedMission });
  windows?.setCount?.('flows', `${flowPercent}%`);
  windows?.setCount?.('checkpoints', `${runningCheckpoints} RUN · ${openCheckpoints} OPEN`);
  windows?.setCount?.('crew', String(activeAvengers));
  windows?.setCount?.('decisions', queue.length);
  composer?.setTarget(state.target, agents, state.mission ?? '');
  renderBubbles(queue);
  renderStrip(agents, queue);
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
  if (dom.runs && windows?.isOpen('runs')) {
    const missionDetail = readingLiveMission ? {
      acceptance: state.acceptance,
      progress: state.progress,
      contradictions: state.contradictions,
      tokenEstimate: state.tokenEstimate,
      quality: state.quality,
      readOnly: false,
    } : { ...(missionView ?? {}), readOnly: true };
    renderChanged('runs', dom.runs, [
      state.runs,
      state.runId,
      state.selectedRunId,
      missionDetail.acceptance,
      missionDetail.progress,
      missionDetail.contradictions,
      missionDetail.tokenEstimate,
      missionDetail.quality,
    ], () => {
      panels.renderRuns?.(dom.runs, state.runs, state.runId, handlers, state.selectedRunId, {
        acceptance: missionDetail.acceptance,
        progress: missionDetail.progress,
        contradictions: missionDetail.contradictions,
        tokenEstimate: missionDetail.tokenEstimate,
        quality: missionDetail.quality,
      });
    });
  }
  if (dom.roRuns) dom.roRuns.textContent = `${state.runs.length} RUNS`;
  setDockMetric(dom.btnFlows, `${flowPercent}%`);
  setDockMetric(dom.btnCheckpoints, String(runningCheckpoints));
  setDockMetric(dom.btnCrew, String(activeAvengers));
  if (dom.planAll && state.tokenEstimate) {
    dom.planAll.title = `Assemble with about ${state.tokenEstimate.assemble} context tokens`;
  }
}

function setDockMetric(button, value) {
  if (!button) return;
  let metric = button.querySelector('.dock-view-count');
  if (!metric) {
    metric = document.createElement('span');
    metric.className = 'dock-view-count';
    button.append(metric);
  }
  metric.textContent = value;
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
    event.kind === EVENT_KINDS.TOOL || event.kind === EVENT_KINDS.CONVERSATION_MESSAGE) ?? null;
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
    // The top strip and the scene are two handles for the same action.
    // Both open this Avenger's feed and apply the same chat filter.
    cell.onclick = () => openConnectedEntity('hero', agent.id);
    return cell;
  });
  dom.crewBar.replaceChildren(...cells);
}

function renderStrip(agents, queue = []) {
  if (!strip) return;
  const agent = agents.find((candidate) => candidate.id === state.focus);
  if (!agent) return strip.close();
  strip.render({
    ...agent,
    decisions: queue.filter((decision) => decision.agentId === agent.id),
  });
}

// A decision belongs to a desk, so it is shown at that desk. Only the most
// urgent card per agent floats; the rest live in the decisions window.
// What each agent is doing RIGHT NOW, pinned to its desk. Without this the
// room shows mood and no content: an agent running twelve git commands looks
// exactly like one doing nothing.
// A bubble is for reading, so it holds still briefly. An agent may change what
// its bubble says at most once every five seconds, however fast it is working.
const BUBBLE_HOLD_MS = 5_000;
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

function renderActivity(agents, covered = new Set()) {
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
      onClick: () => openConnectedEntity('hero', order.agentId),
    })];
  }

  return agents
    .filter((agent) => !agent.offDuty)
    // A decision is the most important thing this agent has to say. Keep one
    // bubble at the head instead of stacking a second tail in empty space.
    .filter((agent) => !covered.has(agent.id))
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
        || event.kind === EVENT_KINDS.CONVERSATION_MESSAGE
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
        onClick: () => openConnectedEntity('hero', agent.id),
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

  const activity = renderActivity(viewAgents(Date.now()), new Set(byAgent.keys()));
  const alerts = [...byAgent.values()]
    .map((decision) => {
      const at = scene?.screenPos?.(decision.agentId);
      if (!at) return null;
      const bubble = speechBubble({
        text: plainText(`${decision.agentName}: ${shortenDetail(decision.detail)}`),
        x: at.x,
        y: at.y,
        tone: 'alert',
        onClick: () => openConnectedEntity('hero', decision.agentId),
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
  if (dom.checkpoints && windows?.isOpen('checkpoints')
    && now - lastCheckpointClockAt >= CHECKPOINT_CLOCK_MS) {
    lastCheckpointClockAt = now;
    panels.refreshCheckpointTimes(dom.checkpoints, now);
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------- the windows

// What is left of the panels. FEED and DECISIONS are the two things you read
// about the whole floor; RUNS and MIDDLEWARE are settings. Flow, evidence and
// crew are gone from here: they belong to one agent, and they are now at that
// agent's desk.
const WINDOW_IDS = {
  runs: ['winRuns', 'btnRuns'],
  flows: ['winFlows', 'btnFlows'],
  checkpoints: ['winCheckpoints', 'btnCheckpoints'],
  feed: ['winFeed', 'btnFeed'],
  crew: ['winCrew', 'btnCrew'],
  decisions: ['winDecisions', 'btnDecisions'],
  middleware: ['winMiddleware', 'btnMiddleware'],
};

let windows = null;
let restoringNavigation = false;
// Reopening should return to whatever you were last reading.
let lastPanel = 'runs';

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
  openChat: (id) => openConnectedEntity('hero', id),
  openCheckpoint: openCheckpointThread,
  openDecision: (id) => openConnectedEntity('decision', id),
  setGoal: (agentId, objective) => send('setGoal', { agentId, objective }),
  assignEngine: (agentId, engine) => send('assignEngine', { agentId, engine }),
  configureRuntime: (agentId, runtime) => send('configureRuntime', { agentId, ...runtime }),
  setInstances: (agentId, instances) => send('setInstances', { agentId, instances }),
  setActive: (agentId, active) => send('setActive', { agentId, active }),
  close: () => focus(null),

  approve: (agentId, approvalId, decision, from) => {
    flyTo({ agentId, text: 'answered', from, tone: 'ok' });
    return send('approve', { agentId, approvalId, decision });
  },

  // A run is a conversation with the fleet. Past ones stay readable; a new one
  // resets the floor without losing them.
  stopRun: () => send('stopRun'),

  newRun: async () => {
    const response = await send('newRun', { mission: '', autoStart: false });
    if (response.result?.runId) {
      state.selectedRunId = response.result.runId;
      seededRunId = response.result.runId;
      setRunUrl(response.result.runId);
    }
    state.eventsByAgent = {};
    state.focus = null;
    state.target = MISSION_TARGET;
    setConsoleCollapsed(false);
    composer?.beginMission();
    scene?.focusOn?.(null);
    strip?.close();
    await loadRuns();
  },

  continueRun: async (runId) => {
    const response = await send('continueRun', { runId });
    if (response.result?.runId) {
      state.selectedRunId = response.result.runId;
      seededRunId = null;
      setRunUrl(response.result.runId);
    }
    await loadRuns();
  },

  resumeRun: async (runId) => {
    const response = await send('resumeRun', { runId });
    if (response.result?.runId) {
      state.selectedRunId = response.result.runId;
      seededRunId = null;
      setRunUrl(response.result.runId);
    }
    state.eventsByAgent = {};
    await loadRuns();
  },

  openRun: async (runId, { updateUrl = true } = {}) => {
    state.selectedRunId = Number(runId);
    seededRunId = Number(runId);
    if (updateUrl) setRunUrl(runId);
    const { run, events, missionState } = await fetch(`/replay?run=${runId}`).then((r) => r.json());
    state.selectedMission = run?.mission ?? '';
    state.selectedMissionView = Number(runId) === state.runId ? null : missionState;
    state.eventsByAgent = {};
    for (const event of events) {
      const list = state.eventsByAgent[event.agentId] ?? [];
      state.eventsByAgent[event.agentId] = [...list, event];
    }
    renderPanels();
  },
  setAcceptance: (required) => send('setAcceptance', { required }),
  act: (action, decision, from) => {
    // RETRY dispatches the agent again. For an agent blocked because its engine
    // never came up, this is the only action on the card that can clear it.
    if (action === 'retry') {
      flyTo({ agentId: decision.agentId, text: 'retry', from, tone: 'ok' });
      return send('start', { agentId: decision.agentId });
    }
    if (action === 'kill') {
      flyTo({ agentId: decision.agentId, text: 'stop', from, tone: 'fail' });
      return send('setActive', { agentId: decision.agentId, active: false });
    }
    if (action === 'dismiss') {
      return send('dismissDecision', { key: decision.key });
    }
    if (action === 'split') {
      return send('say', {
        target: decision.agentId,
        text:
          'Stop. Split the current checkpoint into smaller checkpoints and report the new flow contract ' +
          'before continuing.',
      });
    }
    if (action === 'answer' || decision.kind === 'prayer') {
      return openConnectedEntity('decision', decision.key ?? decision.id);
    }
    return focus(decision.agentId);
  },
};

function runIdFromUrl() {
  const runId = Number(new URL(window.location.href).searchParams.get('run'));
  return Number.isSafeInteger(runId) && runId > 0 ? runId : null;
}

function setRunUrl(runId, { replace = false } = {}) {
  const selected = Number(runId);
  if (!Number.isSafeInteger(selected) || selected <= 0) return;
  const url = new URL(window.location.href);
  if (url.searchParams.get('run') === String(selected)) return;
  url.searchParams.set('run', String(selected));
  window.history[replace ? 'replaceState' : 'pushState']({ runId: selected }, '', url);
}

function tabFromUrl() {
  const tab = new URL(window.location.href).searchParams.get('tab');
  return tab && tab in WINDOW_IDS ? tab : null;
}

function setTabUrl(tab, { replace = false } = {}) {
  const url = new URL(window.location.href);
  if ((url.searchParams.get('tab') ?? null) === (tab ?? null)) return;
  if (tab) url.searchParams.set('tab', tab);
  else url.searchParams.delete('tab');
  window.history[replace ? 'replaceState' : 'pushState'](
    { runId: state.selectedRunId, tab: tab ?? null },
    '',
    url,
  );
}

function restorePanelFromUrl() {
  if (!windows) return;
  restoringNavigation = true;
  const tab = tabFromUrl();
  if (tab) {
    lastPanel = tab;
    windows.open(tab);
  } else {
    windows.close();
  }
  state.open = new Set(windows.openNames());
  restoringNavigation = false;
}

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
  setConsoleCollapsed(false);
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

function setConsoleCollapsed(collapsed) {
  dom.composer?.classList.toggle('is-collapsed', collapsed);
  strip?.syncVisibility();
  dom.composerCollapse?.setAttribute('aria-expanded', String(!collapsed));
  const label = collapsed ? 'Expand console' : 'Collapse console';
  dom.composerCollapse?.setAttribute('aria-label', label);
  if (dom.composerCollapse) dom.composerCollapse.title = label;
}

function wireChrome() {
  // ASSEMBLE before START: Thor decides who this mission actually needs,
  // brings them on, stands the rest down, and gives each of the chosen a goal.
  // Nobody is dispatched blind, and nobody is dispatched who has nothing to do.
  dom.planAll?.addEventListener('click', () => send('assemble'));

  dom.startAll?.addEventListener('click', () => {
    send('startReady');
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

  const paintZoom = () => {
    const zoom = scene?.zoomState?.();
    if (!zoom) {
      if (dom.sceneZoom) dom.sceneZoom.hidden = true;
      return;
    }
    dom.sceneZoomLevel.textContent = `${Math.round(zoom.value * 100)}%`;
    dom.sceneZoomOut.disabled = !zoom.canZoomOut;
    dom.sceneZoomIn.disabled = !zoom.canZoomIn;
  };
  dom.sceneZoomOut?.addEventListener('click', () => {
    scene?.zoomBy?.(-1);
    paintZoom();
  });
  dom.sceneZoomIn?.addEventListener('click', () => {
    scene?.zoomBy?.(1);
    paintZoom();
  });
  paintZoom();

  dom.composerCollapse?.addEventListener('click', () => {
    setConsoleCollapsed(!dom.composer?.classList.contains('is-collapsed'));
  });
  dom.composerInput?.addEventListener('focus', () => setConsoleCollapsed(false));

  for (const name of Object.keys(WINDOW_IDS)) {
    dom[WINDOW_IDS[name][1]]?.addEventListener('click', () => toggleWindow(name));
  }
  dom.winFlowsClose?.addEventListener('click', () => toggleWindow('flows'));
  dom.winCheckpointsClose?.addEventListener('click', () => toggleWindow('checkpoints'));
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
function clearFeedFilter() {
  state.feedFilter = null;
  renderPanels();
}

function sentHistoryFor(target) {
  const missionHistory = target === MISSION_TARGET;
  const agentId = state.agents[target] ? target : orchestratorId();
  return (state.eventsByAgent[agentId] ?? [])
    .filter((event) => event.kind === EVENT_KINDS.CONVERSATION_MESSAGE && event.payload?.message?.from === 'you')
    .sort((a, b) => a.ts - b.ts)
    .map((event) => String(event.payload?.message?.body ?? ''))
    .filter((text) => missionHistory === text.startsWith('mission set: '))
    .map((text) => missionHistory ? text.slice('mission set: '.length) : text);
}

function renderFeed() {
  // The side panel adopts the feed window and leaves the old window element
  // hidden, so testing that window meant the feed never drew while docked -
  // which is why its filters were nowhere to be found. Ask the body whether it
  // is actually on screen instead.
  if (!feedBody || !feedBody.isConnected || feedBody.offsetParent === null) return;

  const readingLiveMission = state.selectedRunId === state.runId;
  const feedBoard = state.selectedMissionView?.board ?? state.board;
  const feedFlows = state.selectedMissionView?.flows ?? state.flows;
  if (feedChatHost) feedChatHost.hidden = !readingLiveMission;
  const talkTo = state.feedFilter
    ? state.agents[state.feedFilter]
    : state.agents[orchestratorId()];
  feedChat?.setTarget(talkTo?.id ?? null, orderedAgents(), state.selectedMission ?? '');

  const allMissionEvents = Object.values(state.eventsByAgent).flat();
  const narrative = missionNarrative({
    events: allMissionEvents, missionId: String(state.selectedRunId), board: feedBoard,
    filters: {
      detail: state.feedLevel, type: state.feedPreset, heroId: state.feedFilter,
      checkpointId: state.feedCheckpoint, workUnitId: state.feedWorkUnit,
      stage: state.feedStage, query: state.feedQuery,
    },
  });

  const feedView = JSON.stringify([
    state.selectedRunId, state.feedLevel, state.feedPreset, state.feedFilter,
    state.feedQuery, state.feedCheckpoint, state.feedWorkUnit, state.feedStage,
  ]);
  const position = feedView === renderedFeedView
    ? captureScrollAnchor(feedBody)
    : { mode: 'tail' };
  const entries = narrative.slice(-400);
  const rows = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.kind === 'message') {
      const messages = [entry.message];
      while (entries[index + 1]?.kind === 'message'
        && entries[index + 1].message.authorId === entry.message.authorId) {
        messages.push(entries[index + 1].message);
        index += 1;
      }
      rows.push(renderMessageGroup(messages, {
        agents: state.agents,
        events: allMissionEvents,
        onReply: (message) => { state.feedReplyTo = message.id; feedChat?.focus(); },
        onReact: (message, reaction) => send('reactConversation', {
          context: message.context, messageId: message.id, reaction,
        }),
        onOpen: (reference) => openConnectedEntity(reference.kind, reference.id),
      }));
      continue;
    }
    const event = entry.event;
    const view = feedEntry(state.agents[event.agentId], event);
    if (!view) continue;
    const checkpointId = view.checkpointId ?? event.payload?.checkpointId ?? null;
    const item = checkpointId ? feedBoard.find((candidate) => candidate.id === checkpointId) : null;
    const workUnit = feedFlows.find((candidate) => candidate.workUnitId === item?.workUnitId);
    const checkpoint = workUnit?.checkpoints?.find((candidate) => candidate.id === item?.id);
    rows.push(feedRow({
      ...view, agentId: event.agentId, checkpointId,
      workUnitId: item?.workUnitId ?? null,
      workUnitDisplayId: workUnit?.displayId ?? item?.workUnitId ?? null,
      checkpointDisplayId: checkpoint?.displayId ?? item?.id ?? null,
      stage: item?.stage ?? null,
      assignmentTo: view.kind === 'assignment'
        ? state.agents[event.payload?.toAgentId]?.label ?? event.payload?.toAgentId
        : null,
      threadCount: checkpointId
        ? messagesForContext(allMissionEvents, { kind: CONTEXT_KIND.CHECKPOINT, id: checkpointId }).length
        : 0,
      reactions: {}, reactionActors: {}, ts: event.ts,
      key: feedEventKey(event.agentId, event),
    }));
  }
  const header = [missionFeedContext(), feedLevelBar(), state.feedFiltersOpen ? feedFilterPanel() : null,
    checkpointThreadsBar(feedBoard, allMissionEvents),
    readingLiveMission ? checkpointCard() : null, ...(state.feedFilter ? [filterChip()] : [])]
    .filter(Boolean);
  feedControls?.replaceChildren(...header);
  feedBody.replaceChildren(...rows);
  restoreScrollAnchor(feedBody, position);
  renderedFeedView = feedView;
}

function checkpointThreadsBar(board, events) {
  const projected = new Map((state.workspace?.checkpoints ?? []).map((item) => [item.id, item]));
  const threads = board.map((item) => ({
    id: item.id,
    label: projected.get(item.id)?.displayId ?? item.displayId ?? item.id,
    ...checkpointThreadSummary(events, item.id),
  })).filter((thread) => thread.count > 0)
    .sort((left, right) => right.latestAt - left.latestAt);
  if (!threads.length) return null;

  const nav = document.createElement('nav');
  nav.className = 'feed-thread-index';
  nav.setAttribute('aria-label', 'Active checkpoint threads');
  const label = document.createElement('span');
  label.textContent = 'THREADS';
  nav.append(label);
  for (const thread of threads) {
    const button = createControlButton(`#${thread.label}  ${thread.count}`, { variant: 'quiet' });
    button.title = `${thread.count} message${thread.count === 1 ? '' : 's'}`;
    button.onclick = () => openCheckpointThread(thread.id);
    nav.append(button);
  }
  return nav;
}

function feedFilterPanel() {
  const panel = document.createElement('section');
  panel.className = 'feed-filter-panel';
  panel.append(presetBar());

  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Search this mission';
  search.value = state.feedQuery;
  search.oninput = () => {
    state.feedQuery = search.value;
    renderFeed();
    document.querySelector('.feed-filter-panel input[type="search"]')?.focus();
  };
  panel.append(search);

  const select = (label, value, options, set) => {
    const control = document.createElement('select');
    control.setAttribute('aria-label', label);
    control.append(new Option(label.toUpperCase(), ''));
    for (const [id, text] of options) control.append(new Option(text, id));
    control.value = value;
    control.onchange = () => { set(control.value); renderFeed(); };
    return control;
  };
  const items = (state.selectedMissionView?.board ?? state.board ?? [])
    .filter((item) => item.disposition === 'active');
  const workUnits = [...new Map(items.filter((item) => item.workUnitId)
    .map((item) => [item.workUnitId, item.workUnitId])).entries()];
  const checkpoints = items.map((item) => [item.id, item.title || item.id]);
  const stages = [...new Set(items.map((item) => item.stage).filter(Boolean))]
    .map((stage) => [stage, stage.toUpperCase()]);
  panel.append(
    select('Hero', state.feedFilter ?? '', orderedAgents().map((agent) => [agent.id, agent.label]),
      (value) => { state.feedFilter = value || null; }),
    select('Checkpoint', state.feedCheckpoint, checkpoints, (value) => { state.feedCheckpoint = value; }),
  );
  if (workUnits.length > 1) {
    panel.append(select('Work unit', state.feedWorkUnit, workUnits,
      (value) => { state.feedWorkUnit = value; }));
  }
  if (stages.length > 1) {
    panel.append(select('Stage', state.feedStage, stages,
      (value) => { state.feedStage = value; }));
  }
  const clear = createControlButton('CLEAR');
  clear.onclick = () => {
    state.feedQuery = '';
    state.feedFilter = null;
    state.feedWorkUnit = '';
    state.feedCheckpoint = '';
    state.feedStage = '';
    renderFeed();
  };
  panel.append(clear);
  return panel;
}

function missionFeedContext() {
  const context = document.createElement('div');
  context.className = 'feed-mission-context';
  const label = document.createElement('span');
  label.textContent = `MISSION ${state.selectedRunId ?? ''}`;
  const title = document.createElement('strong');
  title.textContent = state.selectedMission || 'No mission set';
  context.append(label, title);
  return context;
}

function feedLevelBar() {
  const bar = document.createElement('div');
  bar.className = 'feed-levels';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Feed detail');
  for (const level of FEED_LEVELS) {
    const button = createControlButton(level.label.toUpperCase());
    button.title = level.blurb;
    button.setAttribute('aria-pressed', String(level.id === state.feedLevel));
    button.onclick = () => {
      state.feedLevel = level.id;
      renderFeed();
    };
    bar.append(button);
  }
  const filters = createControlButton('FILTERS');
  filters.setAttribute('aria-expanded', String(state.feedFiltersOpen));
  filters.onclick = () => {
    state.feedFiltersOpen = !state.feedFiltersOpen;
    renderFeed();
  };
  bar.append(filters);
  return bar;
}

function feedEventKey(agentId, event) {
  const payload = event.payload ?? {};
  return JSON.stringify([
    agentId,
    event.ts,
    event.kind,
    payload.toolUseId ?? payload.sessionId ?? '',
    payload.action ?? '',
    payload.target ?? '',
    payload.reason ?? '',
    payload.text ?? '',
  ]);
}

function rememberFeedRow(key, open) {
  if (open) {
    expandedFeedRows.add(key);
    // This state is only a reading aid. Bound it independently of the event
    // history so a long mission cannot grow it without limit.
    while (expandedFeedRows.size > 400) {
      expandedFeedRows.delete(expandedFeedRows.values().next().value);
    }
  } else {
    expandedFeedRows.delete(key);
  }
}

// A compact status card stays in Feed. The full checkpoint list has its own
// scrollable panel, so this card opens it and never expands in place.
function checkpointCard() {
  const items = state.board ?? [];
  if (items.length === 0) return null;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'border:1px solid var(--line,#262626);margin:0 0 8px;'
    + 'background:var(--sunk,#151515)';

  const head = document.createElement('button');
  head.type = 'button';
  const work = state.progress?.work ?? {};
  head.textContent = `CHECKPOINTS  `
    + `${work.done ?? 0} of ${work.total ?? 0} work units done`
    + (work.percent === null || work.percent === undefined ? '' : `  ·  ${work.percent}%`);
  head.style.cssText = 'display:block;width:100%;text-align:left;background:transparent;'
    + 'border:0;color:var(--accent,#34d399);font:inherit;font-size:9px;letter-spacing:.12em;'
    + 'padding:6px 8px;cursor:pointer';
  head.onclick = () => openWindow('checkpoints');
  wrap.append(head);
  return wrap;
}

// Three altitudes on the same stream, always visible above it.
function presetBar() {
  const bar = document.createElement('div');
  bar.style.cssText = [
    'display:flex', 'gap:4px',
    'padding:2px 0 6px', 'background:var(--surface,#121212)',
  ].join(';');
  for (const preset of FEED_PRESETS) {
    const button = createControlButton(preset.label);
    button.title = preset.blurb;
    const on = preset.id === state.feedPreset;
    button.setAttribute('aria-pressed', String(on));
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
    'display:flex', 'align-items:center',
    'gap:8px', 'padding:4px 0 6px', 'background:var(--surface,#121212)',
    'border-bottom:1px solid var(--line,#262626)', 'font-size:10px',
    'letter-spacing:.12em', 'color:var(--accent,#34d399)',
  ].join(';');
  const who = state.agents[state.feedFilter]?.label ?? state.feedFilter;
  chip.append(document.createTextNode(`ONLY ${who.toUpperCase()}`));

  const all = createControlButton('SHOW ALL');
  all.style.marginLeft = 'auto';
  all.onclick = clearFeedFilter;
  chip.append(all);
  return chip;
}

function feedRow(entry) {
  const row = document.createElement('article');
  row.className = `feed-row ${entry.tone}${entry.kind ? ` is-${entry.kind}` : ''}`;
  row.dataset.scrollKey = entry.key;
  row.style.cssText = 'padding:5px 0;border-bottom:1px solid var(--line,#262626)';

  const head = document.createElement('div');
  head.style.cssText = 'color:var(--muted,#8a8a8a);font-size:10px;letter-spacing:.06em';
  const avatar = document.createElement('span');
  avatar.className = 'feed-avatar';
  avatar.textContent = String(entry.who || 'M').slice(0, 1).toUpperCase();
  const author = document.createElement('strong');
  author.textContent = `${entry.who || 'MINIMAC'}${entry.suffix ?? ''}`;
  const time = document.createElement('time');
  time.textContent = entry.at;
  head.append(avatar, author, time);
  row.append(head);

  if (entry.kind === 'assignment') {
    const assignment = document.createElement('div');
    assignment.className = 'feed-assignment-label';
    assignment.textContent = [
      'ASSIGNED',
      entry.assignmentTo,
      entry.workUnitDisplayId,
      entry.checkpointDisplayId,
    ].filter(Boolean).join(' / ');
    row.append(assignment);
  }

  const body = document.createElement('div');
  body.className = 'md';
  if (entry.tone === 'alert') body.style.color = 'var(--danger,#f87171)';
  // The full command is one click away rather than filling the feed.
  if (entry.full && entry.full.length > entry.text.length) {
    body.title = entry.full;
    body.role = 'button';
    body.tabIndex = 0;
    const draw = () => {
      const open = expandedFeedRows.has(entry.key);
      body.innerHTML = renderMarkdown(open ? entry.full : entry.text);
      body.dataset.open = open ? '1' : '0';
      body.setAttribute('aria-expanded', String(open));
      body.style.cursor = open ? 'zoom-out' : 'zoom-in';
    };
    const toggle = () => {
      rememberFeedRow(entry.key, !expandedFeedRows.has(entry.key));
      draw();
    };
    body.onclick = toggle;
    body.onkeydown = (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggle();
    };
    draw();
  } else {
    body.innerHTML = renderMarkdown(entry.text);
  }
  row.append(body);
  const references = feedReferences(entry);
  if (references) row.append(references);
  return row;
}

function feedReferences(entry) {
  const refs = [...(entry.references ?? [])];
  if (entry.checkpointId && !refs.some((ref) => ref.kind === 'checkpoint' && ref.id === entry.checkpointId)) {
    refs.unshift({ kind: 'checkpoint', id: entry.checkpointId, label: entry.checkpointDisplayId });
  }
  if (entry.workUnitId) refs.unshift({ kind: 'work-unit', id: entry.workUnitId, label: entry.workUnitDisplayId });
  const visible = refs.filter((ref) => ref.kind !== 'attachment');
  if (!visible.length) return null;
  const nav = document.createElement('nav');
  nav.className = 'feed-references';
  nav.setAttribute('aria-label', 'Related work');
  for (const ref of visible) {
    if (ref.kind === 'work-unit') {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `#${ref.label ?? ref.id}`;
      button.onclick = () => openWindow('flows');
      nav.append(button);
      if (entry.checkpointId) {
        const thread = document.createElement('button');
        thread.type = 'button';
        thread.className = 'feed-thread-button';
        thread.setAttribute('aria-label', `Open ${entry.checkpointDisplayId ?? 'checkpoint'} thread`);
        thread.title = entry.threadCount
          ? `Open thread · ${entry.threadCount} messages`
          : 'Open thread';
        thread.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5h10v6H7l-3 3v-3H3z"/></svg>';
        thread.onclick = () => openCheckpointThread(entry.checkpointId);
        nav.append(thread);
      }
    } else if (ref.kind === 'checkpoint') {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `#${ref.id === entry.checkpointId ? entry.checkpointDisplayId ?? ref.id : ref.label ?? ref.id}`;
      button.onclick = () => openCheckpointThread(ref.id);
      nav.append(button);
    } else if (ref.kind === 'hero') {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `@${ref.label ?? ref.id}`;
      button.onclick = () => openConnectedEntity('hero', ref.id);
      nav.append(button);
    } else if (ref.kind === 'file' || ref.kind === 'skill') {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = ref.kind === 'skill' ? `/${ref.label ?? ref.id}` : `@${ref.label ?? ref.id}`;
      button.onclick = () => openConnectedEntity(ref.kind, ref.id);
      nav.append(button);
    }
  }
  return nav.childElementCount ? nav : null;
}

function feedEntry(agent, event) {
  const who = agent?.label ?? event.agentId;
  const at = new Date(event.ts).toLocaleTimeString([], { hour12: false });
  const payload = event.payload ?? {};

  if (event.kind === EVENT_KINDS.ORDER) {
    const to = state.agents[payload.toAgentId]?.label ?? payload.toAgentId ?? 'Avenger';
    return {
      at,
      who,
      text: payload.action === 'assign'
        ? String(payload.text ?? '')
        : `${payload.action.toUpperCase()} -> ${to}${payload.checkpointId ? ` · ${payload.checkpointId}` : ''}\n${payload.text}`,
      checkpointId: payload.checkpointId ?? null,
      references: payload.references ?? [],
      tone: 'tool',
      kind: payload.action === 'assign' ? 'assignment' : 'order',
    };
  }
  if (event.kind === EVENT_KINDS.ESCALATION) {
    const stateLabel = payload.state === 'resolved' ? 'RESOLVED' : String(payload.needs ?? 'decision').toUpperCase();
    const details = [payload.checkpointId, payload.why, payload.receipt ? `<- ${payload.receipt}` : null]
      .filter(Boolean).join('\n');
    return { at, who, text: `${stateLabel}\n${details}`, checkpointId: payload.checkpointId ?? null,
      references: payload.references ?? [], tone: payload.state === 'open' ? 'alert' : '' };
  }
  if (event.kind === EVENT_KINDS.LEASE) {
    return {
      at,
      who: '',
      text: `${payload.checkpointId ?? payload.workerId} ${payload.state}`,
      checkpointId: payload.checkpointId ?? null,
      tone: payload.state === 'expired' ? 'alert' : 'tool',
    };
  }
  if (event.kind === EVENT_KINDS.TOOL) {
    const target = String(payload.target ?? '');
    const short = payload.action === 'run' ? summariseCommand(target) : target.replace(/\s+/g, ' ').trim();
    const completed = payload.phase === 'completed';
    const result = completed ? (payload.ok === false ? ' - failed' : ' - done') : '';
    return {
      at,
      who,
      text: `${payload.action} ${short}${result}`,
      tone: completed && payload.ok === false ? 'alert' : 'tool',
      full: [target, payload.detail].filter(Boolean).join('\n\n'),
      operationId: payload.toolUseId
        ? `${event.agentId}:${payload.sessionId ?? ''}:${payload.toolUseId}`
        : null,
    };
  }
  if (event.kind === EVENT_KINDS.CLAIM) {
    const receipt = payload.receipt ? `  <- ${payload.receipt}` : '  <- no receipt';
    return { at, who, text: `${payload.text}${receipt}`, checkpointId: payload.checkpointId ?? null,
      references: payload.references ?? [], tone: payload.receipt ? '' : 'alert' };
  }
  if (event.kind === EVENT_KINDS.BLOCKED) {
    const reason = String(payload.reason ?? '');
    const short = reason.length > 90 ? `${reason.slice(0, 8)}${summariseCommand(reason.slice(8))}` : reason;
    return { at, who, text: `BLOCKED - ${short}`, tone: 'alert', full: reason };
  }
  if (event.kind === EVENT_KINDS.APPROVAL && !payload.resolved) {
    return { at, who, text: `NEEDS YOU - ${payload.summary ?? ''}`, tone: 'alert' };
  }
  if (event.kind === EVENT_KINDS.STATUS && payload.text) {
    return { at, who: '', text: payload.text, tone: '' };
  }
  return null;
}

let headerEl = null;
let feedBody = null;
let feedControls = null;
let feedChat = null;
let feedChatHost = null;
let checkpointsBody = null;

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

  feedControls = document.createElement('div');
  feedControls.className = 'feed-controls';

  const talk = document.createElement('footer');
  talk.className = 'feed-chat';
  feedChatHost = talk;
  feedChat = mountPanelComposer(talk, {
    getTarget: () => state.feedFilter ?? orchestratorId(),
    dispatch: ({ text, attachments }) => send(
      state.feedReplyTo ? 'replyConversation' : 'postConversation', {
        context: { kind: CONTEXT_KIND.MISSION, id: String(state.runId) },
        text, attachments, recipients: state.feedFilter ? [state.feedFilter] : [],
        replyToMessageId: state.feedReplyTo,
      },
    ).then((result) => {
      if (result.ok) state.feedReplyTo = null;
      return result;
    }),
  });

  win.append(bar, feedControls, feedBody, talk);
  document.body.append(win);

  dom.winFeed = win;
  dom.feed = feedBody;
  mountFeedButton();
}

function mountCheckpoints() {
  const win = document.createElement('section');
  win.id = 'winCheckpoints';
  win.className = 'win';
  const bar = document.createElement('div');
  bar.className = 'win-bar';
  checkpointsBody = document.createElement('div');
  checkpointsBody.className = 'win-body';
  checkpointsBody.id = 'checkpoints';
  win.append(bar, checkpointsBody);
  document.body.append(win);
  dom.winCheckpoints = win;
  dom.checkpoints = checkpointsBody;

  const sibling = dom.btnCrew ?? dom.btnDecisions;
  if (sibling?.parentElement) {
    const button = sibling.cloneNode(false);
    button.id = 'btnCheckpoints';
    button.textContent = 'CHECKPOINTS';
    sibling.parentElement.insertBefore(button, sibling);
    dom.btnCheckpoints = button;
  }
}

function openCheckpointThread(id) {
  openConnectedEntity('checkpoint', id);
}

async function openConnectedEntity(kind, id, { replace = false } = {}) {
  const events = Object.values(state.eventsByAgent).flat();
  let source = kind === 'hero'
    ? state.workspace?.heroes?.find((item) => item.id === id)
    : kind === 'checkpoint'
      ? state.workspace?.checkpoints?.find((item) => item.id === id)
      : kind === 'decision'
        ? state.workspace?.decisions?.find((item) => (item.key ?? item.id) === id)
        : kind === 'message'
          ? events.find((event) => event.payload?.message?.id === id)?.payload?.message
          : null;
  if ((kind === 'file' || kind === 'skill') && !source) {
    const response = await send('resolveResource', { reference: { kind, id } });
    source = response.result ?? null;
  }
  if (!source || !windows?.openEntity) return;
  if (kind === 'checkpoint' || kind === 'decision') {
    source = { ...source, messages: messagesForContext(events, { kind, id }) };
  }
  if (kind === 'message') {
    source = { ...source, messages: messagesForThread(events, source.context, source.id) };
  }
  let replyToMessageId = kind === 'message' ? source.id : null;
  let detailComposer = null;
  const conversational = ['checkpoint', 'decision', 'message'].includes(kind);
  const detail = renderEntityDetail({
    kind, source, agents: state.agents, events,
    onReply: conversational
      ? (message) => { replyToMessageId = message.id; detailComposer?.focus(); }
      : null,
    onReact: (message, reaction) => send('reactConversation', {
      context: message.context, messageId: message.id, reaction,
    }),
    onOpen: (reference) => openConnectedEntity(reference.kind, reference.id),
    runtimeHandlers: kind === 'hero' ? handlers : null,
  });
  if (conversational) {
    const context = kind === 'message'
      ? source.context
      : { kind, id };
    const recipients = kind === 'checkpoint' && source.owner?.id ? [source.owner.id]
        : kind === 'decision' && source.agentId ? [source.agentId]
          : kind === 'message' && source.authorId !== 'you' ? [source.authorId] : [];
    const host = document.createElement('footer');
    host.className = 'connected-entity-composer';
    detail.content.append(host);
    detailComposer = mountPanelComposer(host, {
      getTarget: () => context.id,
      dispatch: ({ text, attachments }) => send(
        replyToMessageId ? 'replyConversation' : 'postConversation', {
          context, text, attachments, recipients, replyToMessageId,
        },
      ).then((result) => {
        if (result.ok) replyToMessageId = null;
        return result;
      }),
    });
  }
  const entity = { kind, id, ...detail };
  if (replace) windows.replaceEntity(entity);
  else windows.openEntity(entity);
}

function refreshOpenEntity() {
  const current = windows?.currentEntity?.();
  if (!current) return;
  void openConnectedEntity(current.kind, current.id, { replace: true });
}

// The main console and both side-panel chats use createComposer. This shell
// only adapts that component to a fixed panel footer; it adds no send path.
function mountPanelComposer(host, { getTarget, extraActions = [], dispatch }) {
  const attachments = document.createElement('div');
  attachments.className = 'panel-attachments';
  attachments.hidden = true;

  const row = document.createElement('div');
  row.className = 'panel-compose-row';
  const input = document.createElement('div');
  input.className = 'panel-compose-input md';
  input.contentEditable = 'true';
  input.spellcheck = true;
  input.setAttribute('role', 'textbox');
  input.setAttribute('aria-multiline', 'true');
  input.setAttribute('aria-label', 'Message');
  const sendButton = document.createElement('button');
  sendButton.className = 'btn primary';
  sendButton.type = 'button';
  sendButton.textContent = 'SEND';
  row.append(input, sendButton);

  const actions = document.createElement('div');
  actions.className = 'panel-compose-actions';
  const attach = document.createElement('button');
  attach.className = 'dock-btn mini';
  attach.type = 'button';
  attach.textContent = '+FILE';
  const file = document.createElement('input');
  file.type = 'file';
  file.multiple = true;
  file.hidden = true;
  attach.onclick = () => file.click();

  actions.append(attach, ...extraActions, file);

  // Keep the complete composer in one fixed row. A separate action row can be
  // pushed below the panel edge when the conversation is tall.
  row.replaceChildren(actions, input, sendButton);

  const menu = document.createElement('div');
  menu.className = 'panel-mention-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'listbox');
  host.append(attachments, row, menu);

  return createComposer({
    dom: { input, send: sendButton, menu, attachments, file },
    send,
    getAgents: () => orderedAgents(),
    getReferences: () => [
      ...state.board.map((item) => ({ kind: 'checkpoint', id: item.id })),
      ...state.cards.map((item) => ({ kind: 'decision', id: item.key ?? item.id })),
    ],
    getTarget,
    getHistory: () => sentHistoryFor(getTarget()),
    setTarget: () => {},
    onSend: flyMessage,
    dispatch,
    dropTarget: host,
  });
}

// A switch on the console, cloned from its neighbours so it cannot drift out
// of style with them.
function mountFeedButton() {
  const sibling = dom.btnFlows ?? dom.btnCrew ?? dom.btnDecisions;
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
  intro.className = 'middleware-intro';
  intro.textContent = `DISPATCH ORDER / ${order.join(' / ')}`;

  middlewareBody.replaceChildren(intro, ...middlewareSteps.map(stepEditor));
}

function stepEditor(step) {
  const wrap = document.createElement('details');
  wrap.className = 'middleware-step';
  if (step.overridden) wrap.open = true;

  const head = document.createElement('summary');
  head.className = 'middleware-step-head';
  const name = document.createElement('span');
  name.textContent = step.name;
  if (step.overridden) {
    name.className = 'is-overridden';
  }
  head.append(name);

  const mode = document.createElement('span');
  mode.className = 'middleware-step-state';
  mode.textContent = step.overridden ? 'CUSTOM' : 'DEFAULT';
  head.append(mode);

  const editor = document.createElement('div');
  editor.className = 'middleware-editor';

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'control-button is-small';
  save.textContent = 'SAVE';

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'control-button is-small';
  reset.textContent = 'RESET';
  reset.disabled = !step.overridden;

  const box = document.createElement('textarea');
  box.value = step.text;
  box.rows = Math.max(4, Math.min(10, String(step.text ?? '').split('\n').length + 1));
  box.spellcheck = false;
  box.setAttribute('aria-label', `${step.name} prompt`);
  box.className = 'middleware-input';

  save.onclick = async () => {
    await send('setMiddleware', { name: step.name, text: box.value });
    await loadMiddleware();
  };
  reset.onclick = async () => {
    await send('resetMiddleware', { name: step.name });
    await loadMiddleware();
  };

  const actions = document.createElement('div');
  actions.className = 'middleware-actions';
  actions.append(save, reset);
  editor.append(box, actions);
  wrap.append(head, editor);
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
    // Clicking a desk walks the camera to that hero. Hero links inside the
    // side panel open the connected detail view instead.
    scene = createScene({
      canvas: dom.floor,
      palette,
      onSelect: focus,
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
    getReferences: () => [
      ...state.board.map((item) => ({ kind: 'checkpoint', id: item.id })),
      ...state.cards.map((item) => ({ kind: 'decision', id: item.key ?? item.id })),
    ],
    getTarget: () => state.target,
    getHistory: () => sentHistoryFor(state.target),
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
  mountCheckpoints();
  mountMiddleware();
  orderDockViews();

  // The console's extra row when a desk is focused.
  strip = createGoalStrip({
    handlers,
    console: dom.composer,
    renderDecisions: (root, items) => renderQueue(root, items, handlers),
  });

  windows = createSidePanel({
    entries: windowEntries(),
    labels: { runs: 'MISSION', flows: 'FLOW', checkpoints: 'CHECKPOINTS', feed: 'FEED',
              crew: 'AVENGERS', decisions: 'DECISIONS', middleware: 'MIDDLEWARE' },
    onChange: () => {
      state.open = new Set(windows?.openNames() ?? []);
      if (!restoringNavigation) setTabUrl(windows?.openNames()[0] ?? null);
      renderPanels();
    },
  });

  wireChrome();
  restorePanelFromUrl();
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
  dom.btnAttach?.addEventListener('click', () => {
    setConsoleCollapsed(false);
    dom.fileInput?.click();
  });
  addEventListener('popstate', async () => {
    const runId = runIdFromUrl() ?? state.runId;
    if (runId && runId !== state.selectedRunId) {
      await handlers.openRun(runId, { updateUrl: false });
    }
    restorePanelFromUrl();
  });
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

function orderDockViews() {
  const nav = dom.btnRuns?.parentElement;
  if (!nav) return;
  for (const button of [
    dom.btnRuns,
    dom.btnFlows,
    dom.btnCheckpoints,
    dom.btnFeed,
    dom.btnCrew,
    dom.btnDecisions,
    dom.btnMiddleware,
  ]) {
    if (button) nav.append(button);
  }
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
    'sceneZoom', 'sceneZoomOut', 'sceneZoomLevel', 'sceneZoomIn',
    'composer', 'composerTarget', 'composerInput', 'composerSend', 'composerCollapse', 'mentionMenu',
    'attachments', 'fileInput', 'btnAttach',
    'winDecisions', 'winDecisionsClose', 'queue', 'prayerHead', 'prayerChat',
    'bubbles', 'btnDecisions',
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
    .md { min-width: 0; white-space: normal; overflow-wrap: anywhere; line-height: 1.5; }
    .md p { margin: 3px 0; }
    .md h1, .md h2, .md h3, .md h4, .md h5, .md h6 {
      margin: 6px 0 2px; font-size: 11px; letter-spacing: .06em;
      text-transform: uppercase; color: var(--accent, #34d399);
    }
    .md ul, .md ol { margin: 4px 0; padding-left: 20px; }
    .md li { margin: 2px 0; }
    .md code { padding: 0 3px; border: 1px solid var(--line, #262626); overflow-wrap: normal; }
    .md pre {
      position: relative; margin: 6px 0; padding: 22px 10px 9px; overflow-x: auto;
      background: var(--sunk, #151515); border: 1px solid var(--line, #262626);
    }
    .md pre[data-lang]::before {
      content: attr(data-lang); position: absolute; top: 4px; left: 9px;
      color: var(--muted, #8a8a8a); font-size: 8px; letter-spacing: .14em;
      text-transform: uppercase;
    }
    .md pre code { display: block; min-width: max-content; white-space: pre; border: 0; padding: 0; }
    .md .tok-key { color: var(--accent, #34d399); }
    .md .tok-string { color: var(--text, #e8e8e8); }
    .md .tok-number, .md .tok-literal { color: var(--muted, #8a8a8a); }
    .md blockquote {
      margin: 4px 0; padding-left: 8px;
      border-left: 2px solid var(--line, #262626); color: var(--muted, #8a8a8a);
    }
    .md hr { border: 0; border-top: 1px solid var(--line, #262626); margin: 6px 0; }
    .md a { color: var(--accent, #34d399); }
    .md strong { color: var(--text, #e8e8e8); }
    .md table { width: 100%; border-collapse: collapse; margin: 6px 0; }
    .md th, .md td { border: 1px solid var(--line, #262626); padding: 4px 7px; text-align: left; }
    .md th { color: var(--accent, #34d399); font-size: 9px; letter-spacing: .08em; text-transform: uppercase; }
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

  headerEl.replaceChildren(chip, text);
}
