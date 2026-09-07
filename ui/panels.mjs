// The panels. Every render is a pure function of the view model - the DOM
// holds no truth of its own. Nothing here reads state; everything it draws
// arrives as an argument.
//
// Two rules drive the shapes below:
//   1. Work is expressed as USER FLOWS, never as commands or file paths.
//   2. Every claim carries its receipt, and an unbacked claim must LOOK
//      unbacked rather than merely be labelled.
//
// Before a mission starts there is nothing to report, so each panel teaches
// what it will hold instead of showing an empty box.

import { burnRatio } from '../core/derive.mjs';
import { rollup, remaining } from '../core/flows.mjs';
import { compareQueueOrder, nextGate, isDone, unmetDeps } from '../core/board.mjs';
import { EFFORT_OPTIONS, ENGINES, MODEL_OPTIONS } from '../core/roster.mjs';

const ENGINE_LABELS = [ENGINES.CODEX, ENGINES.CLAUDE];

// The status ladder is ordered, so a step's position on it is a number.
const LADDER = ['coded', 'wired', 'verified'];
const FLOW_STATES = new Set(['pending', 'running', 'blocked', ...LADDER]);

const LADDER_MEANING = [
  ['pending', 'not started'],
  ['running', 'happening now, nothing delivered yet'],
  ['blocked', 'stopped, waiting on something'],
  ['coded', 'the change exists in the tree'],
  ['wired', 'it runs in the real app'],
  ['verified', 'someone watched it happen'],
];

const GRADE_MEANING = [
  ['observed', 'a command produced this number'],
  ['derived', 'computed from observed numbers'],
  ['guessed', 'nothing behind it — struck through'],
];

const DECISION_TRIGGERS = [
  ['approval', 'an engine is parked, asking your permission'],
  ['loop', 'the same file or command, three times over'],
  ['overrun', 'a step past twice its own estimate'],
  ['blocked', 'an agent is waiting on your answer'],
  ['silent', 'no output at all for two minutes'],
];

// ------------------------------------------------------------------- crew

// A persona keeps its seat visible, so nobody has to remember that Vision is
// the UX agent. core/roster.mjs computes the label; the id stays the routing
// key and never appears here.
function nameOf(subject) {
  return subject?.label ?? subject?.agentLabel ?? subject?.name ?? subject?.agentName ?? '';
}


export function renderRoster(root, agents, handlers) {
  if (!agents.length) {
    root.replaceChildren(teach('waiting for the fleet', 'The roster arrives from the server.'));
    return;
  }
  root.replaceChildren(...agents.map((agent) => agentRow(agent, handlers)));
}

function agentRow(agent, handlers) {
  const row = el('div', `agent${agent.enabled === false ? ' is-off' : ''}`);
  if (agent.enabled === false) row.style.opacity = '0.55';
  row.setAttribute('role', 'button');
  row.setAttribute('tabindex', '0');
  row.setAttribute('aria-selected', String(agent.selected));
  row.setAttribute('aria-label', `${nameOf(agent)}, ${agent.role}, ${agent.status}`);
  const pick = () => handlers.select(agent.id);
  row.onclick = pick;
  row.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      pick();
    }
  };

  const ident = el('div', 'ident');
  ident.append(
    enabledToggle(agent, handlers),
    el('span', 'name', crewName(agent)),
    el('span', 'role', agent.role),
    statusChip(agent),
  );

  row.append(
    ident,
    crewSize(agent, handlers),
    engineToggle(agent, handlers),
    runtimeControls(agent, handlers),
    goalEditor(agent, handlers),
    createAgentChat(agent, handlers).el,
  );
  return row;
}

// The one word for where this seat stands. A benched agent is never dispatched,
// so calling it "idle" said the same thing as a hero who is simply between
// turns - and left the toggle as the only place the bench was visible.
// Everywhere else a persona carries its seat - "Strange (auditor)" - because
// there is nothing else on the line to say which seat it is. Here the role is
// already its own word one gap away, so on the seats where the id IS the role
// that parenthesis said "auditor" twice. The id survives wherever it still
// tells you something the role does not: Thor (minimac), Wanda (pm).
function crewName(agent) {
  return agent.id === agent.role ? agent.name : nameOf(agent);
}

function statusChip(agent) {
  const benched = agent.enabled === false;
  const state = benched ? 'benched' : agent.status;
  const chip = el('span', 'status');
  chip.dataset.status = state;
  chip.title = benched
    ? `${nameOf(agent)} is off this mission - nothing is dispatched to this seat`
    : `${nameOf(agent)} is ${agent.status}`;
  chip.append(el('span', 'dot'), el('span', 'word', state));
  return chip;
}

function goalEditor(agent, handlers) {
  const cell = el('div', `goal${agent.goal?.source === 'derived' ? ' is-default' : ''}`);

  // A goal Thor has not written yet is a role template, not a plan for THIS
  // mission. Showing it plain made six identical blurbs read as decisions
  // somebody had made about the work.
  const derived = agent.goal?.source === 'derived';
  const label = el('div', 'goal-label', derived ? 'GOAL · default' : 'GOAL');
  if (derived) {
    label.title = 'a role default - Thor has not set this agent\'s goal for this mission yet';
  }
  const box = document.createElement('textarea');
  box.className = 'goal-input';
  box.rows = 2;
  box.value = agent.goal?.objective ?? '';
  box.placeholder = 'no goal - this agent would start blind';
  box.setAttribute('aria-label', `${nameOf(agent)} goal`);

  // The goal is the single most important editable thing in this panel, so it
  // is a real multi-line field: the whole objective is visible and rewritable.
  const commit = () => {
    const next = box.value.trim();
    if (next !== (agent.goal?.objective ?? '')) handlers.setGoal(agent.id, next);
  };
  box.onblur = commit;
  box.onclick = (event) => event.stopPropagation();
  box.onkeydown = (event) => {
    event.stopPropagation();
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      commit();
      box.blur();
    }
    if (event.key === 'Escape') {
      box.value = agent.goal?.objective ?? '';
      box.blur();
    }
  };

  cell.append(label, box);
  return cell;
}

// Not every mission needs every role. A disabled agent keeps its seat in this
// list so it can be brought back, but it is never dispatched and never appears
// on the floor.
function enabledToggle(agent, handlers) {
  const off = agent.enabled === false;
  const button = el('button', 'switch');
  button.type = 'button';
  button.role = 'switch';
  button.setAttribute('aria-checked', String(!off));
  button.setAttribute('aria-label', `${nameOf(agent)} on this mission`);
  button.title = off ? `Add ${nameOf(agent)} to this mission` : `Bench ${nameOf(agent)}`;
  button.style.cssText = [
    'flex:none', 'box-sizing:border-box', 'position:relative',
    'width:26px', 'height:14px', 'min-width:26px', 'padding:0', 'margin:0',
    'cursor:pointer', 'border-radius:9px',
    `border:1px solid ${off ? 'var(--line)' : 'var(--accent)'}`,
    `background:${off ? 'transparent' : 'var(--accent)'}`,
  ].join(';');

  const knob = el('span');
  knob.style.cssText = [
    'position:absolute', 'top:2px', 'width:8px', 'height:8px', 'border-radius:50%',
    `left:${off ? '2px' : '14px'}`,
    `background:${off ? 'var(--muted)' : 'var(--bg)'}`,
    'transition:left 120ms ease-out',
  ].join(';');
  button.append(knob);

  button.onclick = (event) => {
    event.stopPropagation();
    handlers.setActive(agent.id, off);
  };
  return button;
}

// How many of this hero are working. Three PRs to review is three Capt.
// Marvels, each on its own slice - the server has spawned several workers to a
// seat since the beginning and there has never been a way to ask for it.
function crewSize(agent, handlers) {
  const group = el('div', 'copies');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', `how many ${nameOf(agent)}`);
  const count = Math.max(1, agent.instances ?? 1);

  const step = (delta, label, enabled) => {
    const button = el('button', '', label);
    button.type = 'button';
    button.disabled = !enabled;
    button.title = delta > 0 ? `one more ${nameOf(agent)}` : `one fewer ${nameOf(agent)}`;
    button.onclick = (event) => {
      event.stopPropagation();
      handlers.setInstances(agent.id, count + delta);
    };
    return button;
  };

  const readout = el('span', 'copies-count', `\u00d7${count}`);
  readout.title = count > 1
    ? `${count} workers share this seat, each on its own slice`
    : 'one worker on this seat';
  group.dataset.many = count > 1 ? 'yes' : 'no';
  group.append(step(-1, '\u2212', count > 1), readout, step(1, '+', count < 4));
  return group;
}

function engineToggle(agent, handlers) {
  const group = el('div', 'engine');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', `${nameOf(agent)} engine`);
  for (const engine of ENGINE_LABELS) {
    const button = el('button', '', engine.toUpperCase());
    button.type = 'button';
    button.setAttribute('aria-pressed', String(agent.engine === engine));
    button.setAttribute('aria-label', `${nameOf(agent)} on ${engine}`);
    button.onclick = (event) => {
      event.stopPropagation();
      handlers.assignEngine(agent.id, engine);
    };
    group.append(button);
  }
  return group;
}

function runtimeControls(agent, handlers) {
  const group = el('div', 'runtime-controls');
  const model = runtimeSelect(
    `${nameOf(agent)} model`,
    MODEL_OPTIONS[agent.engine] ?? [],
    agent.model ?? '',
    (value) => handlers.configureRuntime(agent.id, { model: value }),
  );
  const effort = runtimeSelect(
    `${nameOf(agent)} effort`,
    (EFFORT_OPTIONS[agent.engine] ?? []).map((value) => ({ value, label: value.toUpperCase() })),
    agent.effort ?? 'medium',
    (value) => handlers.configureRuntime(agent.id, { effort: value }),
  );
  group.append(model, effort);
  return group;
}

function runtimeSelect(label, options, selected, change) {
  const select = el('select');
  select.setAttribute('aria-label', label);
  select.title = label;
  for (const option of options) {
    const item = el('option', '', option.label);
    item.value = option.value;
    item.selected = option.value === selected;
    select.append(item);
  }
  select.onclick = (event) => event.stopPropagation();
  select.onchange = (event) => {
    event.stopPropagation();
    change(select.value);
  };
  return select;
}

// ---------------------------------------------------------- flow contract

// Zoomed out is the group; zoomed in is one step. Same row shape at every
// altitude, so a repo reads exactly like the step inside it and you can scan a
// column of gates straight down a multi-repo mission.
//
// Which nodes are open is per-agent and lives here, not in the view model: it
// is how you are LOOKING, not something true about the work.
const opened = new Map();

// How far in you are standing. Zooming out is not "collapse everything" - it is
// a question about altitude: the whole mission, one repo, one feature in it, or
// the steps themselves.
export const ZOOM = Object.freeze([
  { id: 'group', label: 'group', depth: 0, blurb: 'the whole mission, one row' },
  { id: 'repo', label: 'repo', depth: 1, blurb: 'one row per repository' },
  { id: 'feature', label: 'feature', depth: 2, blurb: 'the areas inside each repo' },
  { id: 'step', label: 'step', depth: 9, blurb: 'every step, all the way down' },
]);

const zoomOf = new Map(); // agentId -> zoom id

function isOpen(agentId, path, depth) {
  const key = `${agentId}|${path}`;
  if (opened.has(key)) return opened.get(key);
  const zoom = ZOOM.find((z) => z.id === (zoomOf.get(agentId) ?? 'repo')) ?? ZOOM[1];
  return depth < zoom.depth;
}

// Checkpoints, as one shared tree. Seven private self-reports could never answer
// "which repo is the hold-up"; one list with owners and gate chains can.
let addingCheckpoint = false;

export function renderBoard(root, board, velocity, agents = [], handlers = {}) {
  const items = board ?? [];
  const redraw = () => renderBoard(root, board, velocity, agents, handlers);
  const frag = document.createDocumentFragment();
  const workers = agents.filter((agent) => agent.role !== 'orchestrator');
  const activeIds = new Set(workers.flatMap((agent) =>
    agent.sessionId ? (agent.workItemIds ?? []) : []));
  const ordered = items.filter((item) => !isDone(item)).sort(compareQueueOrder);
  const running = ordered.filter((item) => activeIds.has(item.id));
  const pending = ordered.filter((item) => !activeIds.has(item.id));
  const done = items.filter(isDone);
  const slots = workers
    .filter((agent) => agent.enabled !== false)
    .reduce((sum, agent) => sum + Math.max(1, agent.instances ?? 1), 0);
  const inUse = workers.reduce((sum, agent) =>
    sum + (agent.sessionIds?.length || (agent.sessionId ? 1 : 0)), 0);

  const summary = el('div', 'checkpoint-summary');
  summary.append(
    summaryCount(running.length, 'running'),
    summaryCount(pending.length, 'pending'),
    summaryCount(done.length, 'done'),
    summaryCount(Math.max(0, slots - inUse), 'free'),
  );
  const toolbar = el('div', 'checkpoint-toolbar');
  const add = el('button', 'btn primary checkpoint-add', '+ CHECKPOINT');
  add.type = 'button';
  add.setAttribute('aria-expanded', String(addingCheckpoint));
  add.onclick = () => {
    addingCheckpoint = !addingCheckpoint;
    redraw();
  };
  toolbar.append(summary, add);
  frag.append(toolbar);

  if (addingCheckpoint) frag.append(checkpointComposer(workers, handlers, redraw));
  if (items.length === 0) {
    frag.append(emptyBoard());
    root.replaceChildren(frag);
    return;
  }

  frag.append(checkpointSection('running now', running, items, workers, activeIds, handlers));
  frag.append(checkpointSection('pending', pending, items, workers, activeIds, handlers));
  root.replaceChildren(frag);
}

function checkpointComposer(agents, handlers, redraw) {
  const form = el('form', 'checkpoint-create');
  form.setAttribute('aria-label', 'Add checkpoint');

  const outcome = checkpointInput('CHECKPOINT', 'Required result on the path to done', true, 'is-wide');
  const owner = checkpointOwnerInput(agents);
  const plan = checkpointInput('PLAN', 'Steps to produce this result', true);
  const proof = checkpointInput('PROOF', 'Command or check that proves it', true);
  const actions = el('div', 'checkpoint-create-actions');
  const cancel = el('button', 'btn', 'CANCEL');
  cancel.type = 'button';
  cancel.onclick = () => {
    addingCheckpoint = false;
    redraw();
  };
  const submit = el('button', 'btn primary', 'ADD');
  submit.type = 'submit';
  actions.append(cancel, submit);
  form.append(outcome.field, owner.field, plan.field, proof.field, actions);

  form.onsubmit = async (event) => {
    event.preventDefault();
    submit.disabled = true;
    const response = await handlers.add?.({
      title: outcome.control.value.trim(),
      outcome: outcome.control.value.trim(),
      owner: owner.control.value,
      plan: plan.control.value.trim(),
      verify: proof.control.value.trim(),
      blockedBy: [],
      estimateMs: 480_000,
    });
    if (response?.ok === false) {
      submit.disabled = false;
      return;
    }
    addingCheckpoint = false;
    form.remove();
  };
  queueMicrotask(() => outcome.control.focus());
  return form;
}

function checkpointInput(label, placeholder, required, className = '') {
  const field = el('label', `checkpoint-field ${className}`.trim());
  const control = el('input');
  control.type = 'text';
  control.required = required;
  control.placeholder = placeholder;
  field.append(el('span', '', label), control);
  return { field, control };
}

function checkpointOwnerInput(agents) {
  const field = el('label', 'checkpoint-field');
  const control = el('select');
  control.required = true;
  const prompt = el('option', '', 'Choose an Avenger');
  prompt.value = '';
  prompt.disabled = true;
  prompt.selected = true;
  control.append(prompt);
  for (const agent of agents) {
    const option = el('option', '', agent.name);
    option.value = agent.id;
    control.append(option);
  }
  field.append(el('span', '', 'OWNER'), control);
  return { field, control };
}

function summaryCount(value, label) {
  const count = el('span', 'checkpoint-count');
  count.append(el('strong', '', String(value)), document.createTextNode(` ${label}`));
  return count;
}

function checkpointSection(label, items, all, agents, activeIds, handlers) {
  const section = el('section', 'checkpoint-section');
  const heading = el('h3', 'checkpoint-section-title', label);
  heading.append(el('span', '', String(items.length)));
  section.append(heading);
  if (!items.length) {
    section.append(el('p', 'checkpoint-empty', label === 'running now'
      ? 'Nothing is running.' : 'Nothing is waiting.'));
    return section;
  }
  items.forEach((item, index) => section.append(checkpointRow(
    item, all, agents, activeIds.has(item.id), handlers,
    { canMoveUp: index > 0, canMoveDown: index < items.length - 1 },
  )));
  return section;
}

function checkpointRow(item, all, agents, running, handlers, movement) {
  const row = el('article', `checkpoint-row${running ? ' is-running' : ''}`);
  const waiting = unmetDeps({ items: all }, item);
  const owner = agents.find((agent) => agent.id === item.owner);
  const ownerBusy = owner?.sessionId && !(owner.workItemIds ?? []).includes(item.id);
  const label = item.outcome || item.title;
  const line = el('div', 'checkpoint-line');
  line.append(
    el('span', 'checkpoint-label', label),
    el('span', 'checkpoint-state', checkpointStatus(item, running, waiting, owner)),
  );
  row.append(line);

  const controls = el('div', 'checkpoint-controls');
  if (!running) {
    controls.append(
      checkpointButton('UP', () => handlers.move?.(item.id, -1), !movement.canMoveUp),
      checkpointButton('DOWN', () => handlers.move?.(item.id, 1), !movement.canMoveDown),
    );
  }
  controls.append(
    ownerSelect(item, agents, handlers),
    checkpointButton(item.paused ? 'RESUME' : 'PAUSE',
      () => handlers.pause?.(item.id, !item.paused)),
  );
  if (!running) {
    const cannotStart = !item.owner || waiting.length > 0 || ownerBusy;
    const start = checkpointButton('START NOW', () => handlers.start?.(item.id), cannotStart);
    if (cannotStart) start.title = !item.owner
      ? 'Assign an owner first'
      : waiting.length ? 'Waiting on another checkpoint' : `${owner?.name ?? 'Owner'} is already working`;
    controls.append(start);
  }
  row.append(controls, checkpointDetails(item));
  return row;
}

function checkpointStatus(item, running, waiting, owner) {
  const who = owner?.name ?? 'No owner';
  if (running) return `${who} - ${nextGate(item) ?? 'finishing'}`;
  if (item.paused) return `${who} - paused`;
  if (waiting.length) return `${who} - waiting`;
  if (!item.owner) return 'Needs owner';
  return `${who} - ready`;
}

function checkpointButton(label, action, disabled = false) {
  const button = el('button', 'checkpoint-button', label);
  button.type = 'button';
  button.disabled = disabled;
  button.onclick = action;
  return button;
}

function ownerSelect(item, agents, handlers) {
  const select = el('select', 'checkpoint-owner');
  select.setAttribute('aria-label', `Owner for ${item.outcome || item.title}`);
  const empty = el('option', '', 'ASSIGN');
  empty.value = '';
  empty.disabled = true;
  empty.selected = !item.owner;
  select.append(empty);
  for (const agent of agents) {
    const option = el('option', '', agent.name);
    option.value = agent.id;
    option.selected = agent.id === item.owner;
    select.append(option);
  }
  select.onchange = () => handlers.reassign?.(item.id, select.value);
  return select;
}

function checkpointDetails(item) {
  const details = el('details', 'checkpoint-details');
  details.append(el('summary', '', 'DETAILS'));
  const body = el('div', 'checkpoint-detail-body');
  body.append(
    detailLine('TASK', item.title),
    detailLine('PLAN', item.plan),
    detailLine('PROOF', item.verify),
    detailLine('STEP', nextGate(item) ?? 'done'),
  );
  details.append(body);
  return details;
}

function detailLine(label, value) {
  const line = el('div', 'checkpoint-detail-line');
  line.append(el('span', '', label), el('p', '', value || 'Not set'));
  return line;
}

function emptyBoard() {
  const card = el('div', 'decision hollow');
  const block = teach(
    'no checkpoints yet',
    'Add a checkpoint here, or press ASSEMBLE and Thor splits the mission into checkpoints.',
  );
  card.append(block);
  return card;
}

export function renderFlows(root, agent) {
  if (!agent?.flows?.length) {
    root.replaceChildren(emptyFlows(agent));
    return;
  }
  const redraw = () => renderFlows(root, agent);
  const tree = rollup(agent.flows);
  const left = remaining(agent.flows);
  const frag = document.createDocumentFragment();
  frag.append(zoomBar(agent, redraw), leftLine(left));
  const top = tree.children.length ? tree.children : [tree];
  for (const child of top) frag.append(...scopeRows(agent, child, 0, redraw));
  root.replaceChildren(frag);
}

// Zoom out to the mission, in to the steps. Changing it forgets every row you
// opened by hand - you asked for an altitude, not for your clicks preserved.
function zoomBar(agent, redraw) {
  const bar = el('div', 'zoom');
  const current = zoomOf.get(agent.id) ?? 'repo';
  for (const level of ZOOM) {
    const button = el('button', 'zoom-step', level.label);
    button.type = 'button';
    button.title = level.blurb;
    button.setAttribute('aria-pressed', String(level.id === current));
    button.onclick = () => {
      zoomOf.set(agent.id, level.id);
      for (const key of [...opened.keys()]) {
        if (key.startsWith(`${agent.id}|`)) opened.delete(key);
      }
      redraw();
    };
    bar.append(button);
  }
  return bar;
}

// "3 of 8 left · 62% done" - his question is never how long alone.
function leftLine(left) {
  const line = el('div', 'flow-left');
  line.append(
    el('span', 'flow-left-label', 'left'),
    el('span', 'flow-left-value', `${left.steps} of ${left.total} steps`),
    el('span', 'flow-left-pct', left.percentDone === null ? '' : `${left.percentDone}% done`),
  );
  return line;
}

function scopeRows(agent, node, depth, redraw) {
  const rows = [];
  // A leaf is not automatically open. Treating it as open made the altitude
  // buttons do nothing whenever a mission had no scopes: every step showed at
  // every level, so pressing GROUP changed nothing on screen.
  const open = isOpen(agent.id, node.path, depth);

  const row = el('div', `flow-scope${open ? ' is-open' : ''}`);
  row.style.paddingLeft = `${depth * 14}px`;

  const head = el('button', 'flow-scope-head');
  head.type = 'button';
  head.append(
    el('span', 'flow-caret', open ? '▾' : '▸'),
    el('span', 'flow-scope-name', node.name || 'all'),
    el('span', 'flow-scope-count', open ? '' : `${node.totals.steps} steps`),
    el('span', 'flow-scope-pct', node.percentDone === null ? '' : `${node.percentDone}%`),
  );
  head.onclick = () => {
    opened.set(`${agent.id}|${node.path}`, !open);
    redraw();
  };
  row.append(head);
  rows.push(row);

  if (!open) return rows;
  for (const child of node.children) rows.push(...scopeRows(agent, child, depth + 1, redraw));
  for (const step of node.steps) {
    const stepRow = flowRow(step);
    stepRow.style.paddingLeft = `${(depth + 1) * 14}px`;
    rows.push(stepRow);
  }
  return rows;
}

// One step: what a person will see, how far it has got, and its time.
function flowRow(step) {
  const status = FLOW_STATES.has(step.status) ? step.status : 'pending';
  const row = el('div', `flow${status === 'verified' ? ' is-verified' : ''}`);
  const head = el('div', 'flow-head');
  head.append(el('div', 'flow-result', step.user_visible_result ?? step.step), ladder(status));
  row.append(head, burn(step));
  return row;
}

function ladder(status) {
  const reached = LADDER.includes(status) ? LADDER.indexOf(status) + 1 : 0;
  const wrap = el('span', 'ladder');
  wrap.dataset.status = status;
  wrap.setAttribute('aria-label', `status: ${status}`);
  const pips = el('span', 'pips');
  for (let i = 0; i < LADDER.length; i += 1) pips.append(el('i', i < reached ? 'on' : ''));
  wrap.append(pips, el('span', 'word', status));
  return wrap;
}

// Is this step running late?
//
// The agent says in its own report how long a step will take. The room times
// how long it actually takes. One line, three parts: what it is, the two
// durations, and how far past the promise it is.
//
// The segmented bar is gone. It looked like a progress bar, it was not one,
// and a row of blocks cannot say "13m against a promised 5m" - which is the
// only fact here worth having.
function mins(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

function burn(step) {
  const ratio = burnRatio(step);
  const over = ratio !== null && ratio > 1;
  const wrap = el('div', `burn${ratio === null ? ' none' : ''}${over ? ' over' : ''}`);

  wrap.append(el('span', 'burn-label', 'time'));
  if (ratio === null) {
    wrap.append(el('span', 'burn-value', 'no estimate given'));
  } else {
    wrap.append(
      el('span', 'burn-value', `${mins(step.actualMs ?? 0)} of ${mins(step.estimateMs)}`),
      el('span', 'burn-pct', ratio > 3 ? `${ratio.toFixed(1)}x over` : `${Math.round(ratio * 100)}%`),
    );
    wrap.title = over ? 'this step is running late' : 'still inside its estimate';
  }
  wrap.setAttribute('aria-label', `time ${wrap.textContent}`);
  return wrap;
}

function emptyFlows(agent) {
  const who = nameOf(agent) || 'this agent';
  const block = teach(
    `${who} has not published a contract yet`,
    'A contract lands here the moment the mission is accepted. Every row is something ' +
      'the user can see happen — never a command, a file or a lint count.',
  );

  // No invented row here. A made-up contract in the same shape as a real one is
  // the floor asserting something no agent said - and the whole point of this
  // panel is that nothing on it is invented. The ladder says what a row means
  // without pretending one exists.
  block.append(head('the status ladder'), list(LADDER_MEANING));
  block.append(head('the bar'), list([
    ['under', 'how much of the estimate this step has spent'],
    ['over', 'the bar turns red and says how far past the estimate it is'],
  ]));
  return block;
}

// ---------------------------------------------------------- evidence tape

export function renderEvidence(root, claims) {
  if (!claims.length) {
    root.replaceChildren(emptyEvidence());
    return;
  }
  root.replaceChildren(...claims.slice(-40).reverse().map(claimRow));
}

function claimRow(claim) {
  const row = el('div', `claim ${claim.grade}`);
  const grade = el('div', 'grade', claim.grade.toUpperCase());
  const body = el('div');
  body.append(
    el('div', 'text', claim.text),
    el('div', 'receipt', claim.receipt || 'no command behind this'),
  );
  row.append(grade, body);
  return row;
}

function emptyEvidence() {
  const block = teach(
    'no claims yet',
    'Everything an agent asserts lands here, newest first, graded by the receipt ' +
      'behind it. A number with no command behind it is struck through, so a ' +
      'confident guess can never read as a measurement.',
  );

  // Same rule as the flow panel: an example claim is a claim nobody made.
  block.append(head('how a claim is graded'), list(GRADE_MEANING));
  return block;
}

// -------------------------------------------------------------- decisions

export function renderQueue(root, decisions, handlers) {
  if (!decisions.length) {
    root.replaceChildren(emptyQueue());
    return;
  }
  // An approval has the engine parked until it is answered, so it outranks
  // anything merely observed about an agent that is still moving.
  const ordered = [...decisions].sort((a, b) => urgency(a) - urgency(b));
  root.replaceChildren(...ordered.map((decision) => decisionCard(decision, handlers)));
}

// A partial payload must never render a broken row: without the answerable
// part, an approval is just another blocked agent.
function isApproval(decision) {
  return decision.kind === 'approval' && !!decision.approval?.id;
}

function urgency(decision) {
  return isApproval(decision) ? 0 : 1;
}

function decisionCard(decision, handlers) {
  return isApproval(decision)
    ? approvalCard(decision, handlers)
    : observationCard(decision, handlers);
}

// What the floor derived on its own: a loop, an overrun, a silence.
function observationCard(decision, handlers) {
  const kind = decision.kind === 'approval' ? 'blocked' : decision.kind;
  const kindLabel = kind === 'loop' ? 'loop detected' : kind;
  const card = el('div', `decision ${kind}`);
  const header = el('div', 'head');
  header.append(
    el('span', 'who', nameOf(decision)),
    cardTime(decision),
    el('span', 'kind', kindLabel),
  );
  card.append(header, el('div', 'detail', decision.detail));

  // A prayer is a QUESTION, not an observation. It does not get the same
  // "tell them what to do instead" line as a loop or an overrun, because a
  // one-shot answer is not how you settle a question - it opens a thread you
  // can go back and forth in until you say it is settled.
  if (decision.kind === 'prayer') {
    const answer = el('button', 'act answer', 'ANSWER');
    answer.type = 'button';
    answer.title = 'open the conversation with them';
    answer.onclick = () => handlers.act('answer', decision);
    const row = el('div', 'actions answers');
    row.append(answer);
    const ignore = el('button', 'act', 'DISMISS');
    ignore.type = 'button';
    ignore.onclick = (event) =>
      handlers.act('dismiss', decision, event.currentTarget.getBoundingClientRect());
    row.append(ignore);
    card.append(row);
    return card;
  }

  const actions = actionRow(decision, handlers);
  const dismiss = el('button', 'act', 'DISMISS');
  dismiss.type = 'button';
  dismiss.onclick = (event) =>
    handlers.act('dismiss', decision, event.currentTarget.getBoundingClientRect());
  actions.append(dismiss);
  card.append(actions);
  if (decision.actions.includes('steer')) card.append(steerRow(decision, handlers));
  return card;
}

// What the engine is asking for. This is a request, not an observation: the
// agent is frozen until one of these buttons is pressed, so the ask is the
// primary line and the answers are the loudest thing on the card.
function approvalCard(decision, handlers) {
  const { approval } = decision;
  const card = el('div', 'decision approval');

  const header = el('div', 'head');
  header.append(
    el('span', 'who', nameOf(decision)),
    cardTime(decision),
    el('span', 'frozen', 'frozen'),
    el('span', 'kind', approval.approvalKind ?? 'approval'),
  );
  card.append(header, el('div', 'ask', approval.summary ?? decision.detail));

  const why = approval.detail ?? decision.detail;
  if (why && why !== approval.summary) card.append(el('div', 'why', why));

  if (approval.paths?.length) {
    const paths = el('div', 'paths');
    for (const path of approval.paths) paths.append(el('div', 'path', path));
    card.append(paths);
  }

  const context = [approval.engine, approval.cwd].filter(Boolean).join(' · ');
  if (context) card.append(el('div', 'context', context));

  // Render exactly what the event advertises: engines differ on what they
  // offer, and one real Codex daemon offered no "decline" at all.
  const answers = el('div', 'actions answers');
  for (const choice of approval.decisions ?? []) {
    const button = el('button', 'act answer', choiceLabel(choice));
    button.type = 'button';
    button.dataset.choice = choiceKey(choice);
    button.onclick = (event) =>
      handlers.approve(decision.agentId, approval.id, choice, event.currentTarget.getBoundingClientRect());
    answers.append(button);
  }
  card.append(answers);

  // Prose is still a valid answer, so the steer line stays.
  card.append(steerRow(decision, handlers));
  return card;
}

function cardTime(decision) {
  const stamp = el('time', 'card-time');
  const date = new Date(decision.raisedAt);
  if (!Number.isFinite(date.getTime())) return stamp;
  stamp.dateTime = date.toISOString();
  stamp.textContent = date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return stamp;
}

// A choice is either a bare string or a { value, label } pair. The engine's
// own label wins when it gives one; otherwise the value is made readable
// ('acceptForSession' is an identifier, not a label).
function choiceLabel(choice) {
  if (typeof choice === 'string') return humanise(choice);
  return choice.label ?? humanise(choiceKey(choice));
}

// One stable word for styling and testing, whatever shape the value takes.
function choiceKey(choice) {
  const value = typeof choice === 'string' ? choice : choice?.value;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return Object.keys(value)[0] ?? 'answer';
  return 'answer';
}

function humanise(text) {
  return String(text).replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

function actionRow(decision, handlers) {
  const actions = el('div', 'actions');
  for (const action of decision.actions ?? []) {
    const button = el('button', 'act', action === 'kill' ? 'STOP' : action.toUpperCase());
    button.type = 'button';
    button.dataset.action = action;
    // The rect is where the action was pressed: main.mjs flies a token from
    // there to the desk, so nothing you click is silent.
    button.onclick = (event) => handlers.act(action, decision, event.currentTarget.getBoundingClientRect());
    actions.append(button);
  }
  return actions;
}

function steerRow(decision, handlers) {
  return createAgentChat(decision, handlers, {
    placeholder: `tell ${nameOf(decision)} what to do instead`,
  }).el;
}

// One message control everywhere an agent can be addressed. It always calls
// the same handler, which sends through the server middleware whether the
// agent is already running or must be started by this message.
export function createAgentChat(agent, handlers, options = {}) {
  const form = el('div', 'steer');
  const input = el('input');
  let target = null;

  const setAgent = (next) => {
    target = next ?? null;
    const who = target ? nameOf(target) : 'an Avenger';
    const agentId = target?.id ?? target?.agentId ?? 'none';
    input.dataset.field = `chat:${agentId}`;
    input.placeholder = options.placeholder ?? `talk to ${who}`;
    input.setAttribute('aria-label', `talk to ${who}`);
    input.disabled = !target;
  };

  form.onclick = (event) => event.stopPropagation();
  input.onkeydown = (event) => {
    event.stopPropagation();
    if (event.key === 'Enter' && target && input.value.trim()) {
      const agentId = target.id ?? target.agentId;
      handlers.steer(agentId, input.value.trim(), input.getBoundingClientRect());
      input.value = '';
      handlers.openChat?.(agentId);
    }
  };
  form.append(input, el('span', 'hint', '↵'));
  setAgent(agent);
  return { el: form, input, setAgent };
}

// An idle queue still says what it is for, as a quiet hollow card rather
// than an alarm - it is the first thing a new user opens.
function emptyQueue() {
  const card = el('div', 'decision hollow');
  const block = teach(
    'nothing needs you',
    'This is the only thing allowed to interrupt you. Clearing it is how you govern ' +
      'the fleet; everything else can wait until you feel like reading it.',
  );
  block.append(head('a card appears when'), list(DECISION_TRIGGERS));
  card.append(block);
  return card;
}

// ------------------------------------------------------------------- runs

// Every run row can be reopened to read, or run again with its own mission and
// goals restored into a fresh run.
// Continuing keeps the agents' own memory of the run; running again starts
// the same mission from nothing. Both are useful, and they are not the same.
function continueButton(run, handlers) {
  const resumable = (run.sessions ?? 0) > 0;
  const button = el('button', 'act run-continue', 'CONTINUE');
  button.type = 'button';
  button.style.flex = 'none';
  // Always enabled: where a conversation survives it is resumed, and where it
  // does not the agent restarts on the same goal.
  button.title = resumable
    ? 'Pick these conversations up where they stopped'
    : 'No saved conversations for this mission - the agents will restart on the same goals';
  if (!resumable) button.style.opacity = '0.7';
  button.onclick = (event) => {
    event.stopPropagation();
    handlers.continueRun(run.id);
  };
  return button;
}

function runAgainButton(run, handlers) {
  const button = el('button', 'act run-again', 'RUN AGAIN');
  button.type = 'button';
  button.style.flex = 'none';
  button.title = 'Start this mission again from nothing, on the same goals';
  button.onclick = (event) => {
    event.stopPropagation();
    handlers.resumeRun(run.id);
  };
  return button;
}

export function renderRuns(root, runs, currentId, handlers) {
  // The server owns which run is current. An unfinished database row may be a
  // crashed old process; guessing from ended_at made STOP target another run.
  const rows = [newRunRow(handlers)];
  if (!runs.length) {
    rows.push(
      teach(
        'no earlier missions',
        'Every mission is kept whole - the fleet, the checkpoints and every event - so a ' +
          'morning that went wrong can be opened again and read back.',
      ),
    );
  } else {
    rows.push(...runs.map((run) => runRow(
      run,
      run.id === currentId && !run.ended_at,
      handlers,
    )));
  }
  root.replaceChildren(...rows);
}

function newRunRow(handlers) {
  const row = el('button', 'run new', '+ NEW MISSION');
  row.type = 'button';
  row.setAttribute('aria-label', 'Start a new mission');
  row.onclick = () => handlers.newRun();
  return row;
}

function runRow(run, live, handlers) {
  const row = el('div', `run${live ? ' is-live' : ''}`);
  row.setAttribute('role', 'button');
  row.setAttribute('tabindex', '0');
  const open = () => handlers.openRun(run.id);
  row.onclick = open;
  row.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  };

  const head = el('div', 'run-head');
  // A long mission must never push the controls off the row: the text gives
  // way, the buttons do not.
  head.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0';
  const mission = el('div', 'run-mission', run.mission || 'untitled run');
  mission.style.cssText =
    'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  mission.title = run.mission || 'untitled run';
  head.append(mission);
  if (live) head.append(el('span', 'run-live', 'current'), stopButton(handlers));
  else head.append(continueButton(run, handlers), runAgainButton(run, handlers));
  row.append(head);

  const meta = el('div', 'run-meta');
  meta.append(
    el('span', '', formatMoment(run.started_at)),
    el('span', 'sep', '·'),
    el('span', live ? 'running' : '', runDuration(run, live)),
    el('span', 'sep', '·'),
    el('span', 'count', `${run.events ?? 0} events`),
  );
  row.append(meta);

  if (run.repo) row.append(el('div', 'run-repo', run.repo));
  return row;
}

// Stopping is the other thing someone looks for on the current run, so it
// lives on the row rather than only in the topbar.
function stopButton(handlers) {
  const button = el('button', 'run-stop', 'stop');
  button.type = 'button';
  button.setAttribute('aria-label', 'Stop the current run');
  button.onclick = (event) => {
    event.stopPropagation();
    handlers.stopRun();
  };
  return button;
}

function formatMoment(value) {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return 'unknown time';
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function runDuration(run, live) {
  if (!run.ended_at) return live ? 'running' : 'never finished';
  const ms = new Date(run.ended_at).getTime() - new Date(run.started_at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${pad2(total % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${pad2(minutes % 60)}m`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// ------------------------------------------------------------- primitives

function teach(lede, note) {
  const block = el('div', 'teach');
  block.append(el('div', 'teach-lede', lede), el('div', 'teach-note', note));
  return block;
}

function head(text) {
  return el('div', 'teach-head', text);
}

function list(pairs) {
  const wrap = el('div', 'teach-list');
  for (const [key, value] of pairs) {
    const item = el('div', 'teach-item');
    item.append(el('span', 'teach-key', key), el('span', 'teach-val', value));
    wrap.append(item);
  }
  return wrap;
}

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
