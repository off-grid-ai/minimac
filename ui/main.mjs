// Composition root for the view. Subscribes to the server, derives the view
// model with the same core functions the server uses, and hands it to the
// room, the docked windows and the composer. No rules live here.

import { EVENT_KINDS } from '../core/events.mjs';
import {
  agentPose,
  detectLoops,
  eventsPerMin,
  gradeClaims,
  pendingDecisions,
  stepTimings,
} from '../core/derive.mjs';
import { createScene, deskSpot } from './scene.mjs';
import * as panels from './panels.mjs';
import { renderRoster, renderFlows, renderEvidence, renderQueue } from './panels.mjs';
import { createComposer, MISSION_TARGET } from './composer.mjs';
import { createSidePanel } from './sidepanel.mjs';
import { renderMarkdown, markdownReady } from './markdown.mjs';
import { describeEvent, plainText, shortenDetail, summariseCommand } from '../core/readable.mjs';

const PULSE_MS = 900;
const PING_MS = 700;
const PANEL_THROTTLE_MS = 150;
const RUNS_REFRESH_MS = 3000;

const dom = pickDom();

const state = {
  agents: {},
  goals: {},
  claims: {},
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
};

const palette = readPalette();
let scene = null;
let composer = null;

// ------------------------------------------------------------------ server

// Names for what you just did, so an action is never silent. One place, so
// every button reads the same way in the feed.
const ACTION_WORDS = Object.freeze({
  start: 'start', interrupt: 'stop', say: 'send', steer: 'steer',
  approve: 'answer', setGoal: 'set goal', clearGoal: 'clear goal',
  assignEngine: 'switch engine', setMission: 'set mission', newRun: 'new run',
  continueRun: 'continue run', resumeRun: 'run again', stopRun: 'stop run',
  setRepo: 'change folder', claim: 'claim files', release: 'release files',
  setMiddleware: 'edit middleware', resetMiddleware: 'reset middleware',
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
  state.goals = snapshot.goals;
  state.claims = snapshot.claims;
  state.repo = snapshot.repo ?? state.repo;
  state.mission = snapshot.mission ?? state.mission;
  state.runId = snapshot.runId ?? state.runId;
  if (state.runId && !seeded) {
    seeded = true;
    seedFromRun(state.runId);
  }
  state.focus ??= firstWorker()?.id ?? null;
  if (dom.repoPath) dom.repoPath.textContent = state.repo;
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
});


const MOVE_COOLDOWN_MS = 4000;
const MOVE_LIFE_MS = 900;
const lastMoveAt = new Map();

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
    default:
      return null;
  }
}

// -------------------------------------------------------------- view model

function orderedAgents() {
  const all = Object.values(state.agents).filter((agent) => agent.enabled !== false);
  return [
    ...all.filter((agent) => agent.role !== 'orchestrator'),
    ...all.filter((agent) => agent.role === 'orchestrator'),
  ];
}

// The crew panel is the one place that shows disabled agents, so they can be
// switched back on.
function allAgents(now) {
  const shown = new Map(viewAgents(now).map((agent) => [agent.id, agent]));
  return Object.values(state.agents).map((agent) => shown.get(agent.id) ?? {
    ...agent, selected: false, pose: 'idle', eventsPerMin: 0, loopCount: 0,
    goal: state.goals[agent.id] ?? null,
  });
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
      pose: agentPose(agent, events, now),
      eventsPerMin: eventsPerMin(events, now),
      loopCount: detectLoops(events)[0]?.count ?? 0,
      goal: state.goals[agent.id] ?? null,
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
    const declared = agent.flows?.[index] ?? {};
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

function decisions(now) {
  return orderedAgents().flatMap((agent) => {
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

function renderPanels() {
  const now = Date.now();
  const agents = viewAgents(now);
  const focused = agents.find((agent) => agent.selected) ?? agents[0];
  const queue = decisions(now);

  if (dom.roster) renderRoster(dom.roster, allAgents(now), handlers);
  if (dom.flows && focused) renderFlows(dom.flows, { ...focused, flows: measuredFlows(focused) });
  if (dom.evidence) renderEvidence(dom.evidence, focused ? claimsFor(focused.id) : []);
  if (dom.queue) renderQueue(dom.queue, queue, handlers);
  if (dom.queueCount) dom.queueCount.textContent = String(queue.length);
  if (dom.focusName) dom.focusName.textContent = focused?.name ?? '';
  composer?.setTarget(state.target, agents);
  renderBubbles(queue);
  renderHeader(agents);
  renderFeed();
  if (dom.runs) panels.renderRuns?.(dom.runs, state.runs, handlers);
  if (dom.roRuns) dom.roRuns.textContent = `${state.runs.length} RUNS`;
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

function bubbleTextFor(agentId, latest, now) {
  const held = shownBubble.get(agentId);
  if (held && now - held.at < BUBBLE_HOLD_MS) return held.text;
  const text = plainText(describeEvent(latest));
  if (!held || held.text !== text) shownBubble.set(agentId, { text, at: now });
  return text;
}

function renderActivity(agents) {
  if (!dom.bubbles) return [];
  const now = Date.now();
  return agents
    .map((agent) => {
      const events = state.eventsByAgent[agent.id] ?? [];
      const last = [...events].reverse().find((event) =>
        event.kind === EVENT_KINDS.TOOL || event.kind === EVENT_KINDS.MESSAGE);
      if (!last) return null;
      const at = scene?.screenPos?.(agent.id);
      if (!at) return null;
      return speechBubble({
        text: bubbleTextFor(agent.id, last, now),
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
function speechBubble({ text, x, y, tone, onClick }) {
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
  const TOP = 58;
  const BOTTOM = window.innerHeight - 150;
  const panelWidth = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--panel-w'),
  ) || 0;
  const RIGHT = window.innerWidth - panelWidth - 8;
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
  state.pulses = state.pulses.filter((pulse) => now - pulse.born < PULSE_MS);
  state.pings = state.pings.filter((ping) => now - ping.born < PING_MS);
  state.moves = state.moves.filter((move) => now - move.born < MOVE_LIFE_MS);

  scene?.render({
    agents: viewAgents(now),
    pulses: state.pulses.map((pulse) => ({ ...pulse, life: 1 - (now - pulse.born) / PULSE_MS })),
    pings: state.pings.map((ping) => ({ ...ping, life: 1 - (now - ping.born) / PING_MS })),
    moves: state.moves.map((move) => ({ ...move, life: 1 - (now - move.born) / MOVE_LIFE_MS })),
  });

  if (now - lastBubbleAt > 500) {
    lastBubbleAt = now;
    renderBubbles(decisions(now));
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------- the windows

const WINDOW_IDS = {
  flows: ['winFlows', 'btnFlows'],
  evidence: ['winEvidence', 'btnEvidence'],
  crew: ['winCrew', 'btnCrew'],
  decisions: ['winDecisions', 'btnDecisions'],
  runs: ['winRuns', 'btnRuns'],
  feed: ['winFeed', 'btnFeed'],
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
  steer: (agentId, text) => send('say', { target: agentId, text }),
  approve: (agentId, approvalId, decision) => send('approve', { agentId, approvalId, decision }),

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
  act: (action, decision) => {
    if (action === 'kill') return send('interrupt', { agentId: decision.agentId });
    if (action === 'split') {
      return send('say', {
        target: decision.agentId,
        text:
          'Stop. Split the current step into smaller steps and report the new flow contract ' +
          'before continuing.',
      });
    }
    return focus(decision.agentId);
  },
};

function focus(agentId) {
  state.focus = agentId;
  state.target = agentId;
  fireMove(agentId, 'neutral'); // selecting an agent plays its signature move
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
  dom.startAll?.addEventListener('click', () => {
    for (const agent of orderedAgents()) send('start', { agentId: agent.id });
  });

  dom.stopAll?.addEventListener('click', () => handlers.stopRun());

  for (const name of Object.keys(WINDOW_IDS)) {
    dom[WINDOW_IDS[name][1]]?.addEventListener('click', () => toggleWindow(name));
  }
  dom.winFlowsClose?.addEventListener('click', () => toggleWindow('flows'));
  dom.winEvidenceClose?.addEventListener('click', () => toggleWindow('evidence'));
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

  // One shortcut only: Cmd+\\ shows and hides the panel. Everything else on the
  // keyboard belongs to the browser and to whatever is being typed.
  addEventListener('keydown', (event) => {
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
  if (!feedBody || dom.winFeed?.hidden !== false) return;

  const lines = [];
  for (const [agentId, events] of Object.entries(state.eventsByAgent)) {
    if (state.feedFilter && agentId !== state.feedFilter) continue;
    const agent = state.agents[agentId];
    for (const event of events.slice(-300)) {
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
  feedBody.replaceChildren(...(state.feedFilter ? [filterChip(), ...rows] : rows));
  // Only follow the tail if the reader was already at it.
  if (atBottom) feedBody.scrollTop = feedBody.scrollHeight;
}

// A visible reminder that you are reading one agent, with the way back on it.
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

  const sibling = dom.btnFlows ?? dom.btnCrew;
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

// A sent message should be seen arriving. It leaves the console and lands on
// the desk it was addressed to, so "sent" is something you watch, not infer.
function flyMessage({ target, text, from }) {
  const agentId = target === MISSION_TARGET ? orchestratorId() : target;
  const to = scene?.screenPos?.(agentId);
  if (!to || !from) return;

  const note = document.createElement('div');
  note.className = 'flyer';
  note.textContent = text.length > 60 ? `${text.slice(0, 57)}…` : text || 'attachment';
  note.style.cssText = [
    'position:fixed', 'z-index:55', 'pointer-events:none', 'max-width:280px',
    'padding:4px 8px', 'font:11px/1.4 Menlo, monospace', 'white-space:nowrap',
    'overflow:hidden', 'text-overflow:ellipsis',
    'background:var(--surface, #121212)', 'color:var(--accent, #34d399)',
    'border:1px solid var(--accent, #34d399)',
    `left:${from.left + 16}px`, `top:${from.top}px`,
  ].join(';');
  document.body.append(note);

  const canvas = dom.floor?.getBoundingClientRect() ?? { left: 0, top: 0 };
  const dx = canvas.left + to.x - (from.left + 16);
  const dy = canvas.top + to.y - from.top;

  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    setTimeout(() => note.remove(), 200);
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
      // It landed: the desk acknowledges with the same pulse a verified step uses.
      const agent = viewAgents(Date.now()).find((candidate) => candidate.id === agentId);
      if (agent) state.pulses.push({ ...deskSpot(agent), born: Date.now() });
    });
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
    scene = createScene({ canvas: dom.floor, palette, onSelect: focus });
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

  windows = createSidePanel({
    entries: windowEntries(),
    labels: { flows: 'FLOW', evidence: 'EVIDENCE', crew: 'CREW',
              decisions: 'DECISIONS', runs: 'RUNS', feed: 'FEED',
              middleware: 'MIDDLEWARE' },
    onChange: () => renderPanels(),
  });

  wireChrome();
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
    'floor', 'topbar', 'repoPath', 'queueCount', 'startAll',
    'composer', 'composerTarget', 'composerInput', 'composerSend', 'mentionMenu',
    'attachments', 'fileInput', 'btnAttach',
    'winFlows', 'winFlowsClose', 'winEvidence', 'winEvidenceClose',
    'winCrew', 'winCrewClose', 'winDecisions', 'winDecisionsClose',
    'focusName', 'flows', 'evidence', 'roster', 'queue', 'bubbles',
      'btnFlows', 'btnEvidence', 'btnCrew', 'btnDecisions',
    'winRuns', 'winRunsClose', 'runs', 'roRuns', 'btnRuns', 'stopAll',
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
