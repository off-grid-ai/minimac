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
import { ENGINES } from '../core/roster.mjs';

const ENGINE_LABELS = [ENGINES.CODEX, ENGINES.CLAUDE];

// The status ladder is ordered, so a step's position on it is a number.
const LADDER = ['coded', 'wired', 'verified'];

const LADDER_MEANING = [
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
    el('span', 'name', nameOf(agent)),
    el('span', 'role', agent.role),
    statusChip(agent),
  );

  row.append(ident, engineToggle(agent, handlers), goalEditor(agent, handlers));
  return row;
}

function statusChip(agent) {
  const chip = el('span', 'status');
  chip.dataset.status = agent.status;
  chip.append(el('span', 'dot'), el('span', 'word', agent.status));
  return chip;
}

function goalEditor(agent, handlers) {
  const cell = el('div', 'goal');

  const label = el('div', 'goal-label', 'GOAL');
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
  button.title = off ? `Bring ${nameOf(agent)} onto this mission` : `Take ${nameOf(agent)} off this mission`;
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
    handlers.setEnabled(agent.id, off);
  };
  return button;
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

// ---------------------------------------------------------- flow contract

export function renderFlows(root, agent) {
  if (!agent?.flows?.length) {
    root.replaceChildren(emptyFlows(agent));
    return;
  }
  root.replaceChildren(...agent.flows.map(flowRow));
}

function flowRow(step) {
  const status = LADDER.includes(step.status) ? step.status : 'coded';
  const row = el('div', `flow${status === 'verified' ? ' is-verified' : ''}`);

  const head = el('div', 'flow-head');
  head.append(el('div', 'flow-result', step.user_visible_result ?? step.step), ladder(status));
  row.append(head, burn(step));
  return row;
}

function ladder(status) {
  const reached = LADDER.indexOf(status) + 1;
  const wrap = el('span', 'ladder');
  wrap.dataset.status = status;
  wrap.setAttribute('aria-label', `status: ${status}`);
  const pips = el('span', 'pips');
  for (let i = 0; i < LADDER.length; i += 1) pips.append(el('i', i < reached ? 'on' : ''));
  wrap.append(pips, el('span', 'word', status));
  return wrap;
}

// Actual against estimate. Under budget the bar simply fills; over budget it
// inverts and states the raw multiplier, because "a bit late" and "3.1x late"
// are different facts.
function burn(step) {
  const ratio = burnRatio(step);
  const over = ratio !== null && ratio > 1;
  const wrap = el('div', `burn${ratio === null ? ' none' : ''}${over ? ' over' : ''}`);

  const bar = el('div', 'bar');
  const fill = el('span');
  fill.style.transform = `scaleX(${Math.min(ratio ?? 0, 1)})`;
  bar.append(fill);

  const text = el('div', 'ratio', ratio === null ? '—' : `${ratio.toFixed(1)}×`);
  wrap.append(bar, text);
  wrap.setAttribute(
    'aria-label',
    ratio === null ? 'no estimate given' : `${ratio.toFixed(1)} times the estimate`,
  );
  return wrap;
}

function emptyFlows(agent) {
  const who = nameOf(agent) || 'this agent';
  const block = teach(
    `${who} has not published a contract yet`,
    'A contract lands here the moment the mission is accepted. Every row is something ' +
      'the user can see happen — never a command, a file or a lint count.',
  );

  const exampleHead = head('what a row looks like');
  exampleHead.append(el('span', 'ghost-tag', 'example'));
  block.append(exampleHead);
  const example = flowRow({
    user_visible_result: 'user scrubs to 14:02 and the meeting card appears',
    status: 'wired',
    estimateMs: 240_000,
    actualMs: 156_000,
  });
  example.classList.add('ghost');
  block.append(example);

  block.append(head('the status ladder'), list(LADDER_MEANING));
  block.append(head('the bar'), list([
    ['under', 'how much of the estimate this step has spent'],
    ['over', 'the bar inverts and states the raw multiple, e.g. 3.1×'],
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

  block.append(head('how a claim is graded'), list(GRADE_MEANING));
  const sampleHead = head('what a row looks like');
  sampleHead.append(el('span', 'ghost-tag', 'example'));
  block.append(sampleHead);
  const sample = el('div', 'ghost');
  sample.append(
    claimRow({
      grade: 'observed',
      text: '62 type errors remain',
      receipt: 'tsc --noEmit | grep -c error',
    }),
    claimRow({ grade: 'guessed', text: 'roughly 4,590 lines changed', receipt: '' }),
  );
  block.append(sample);
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
  const card = el('div', `decision ${kind}`);
  const header = el('div', 'head');
  header.append(el('span', 'who', nameOf(decision)), el('span', 'kind', kind));
  card.append(header, el('div', 'detail', decision.detail));
  card.append(actionRow(decision, handlers));
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
    const button = el('button', 'act', action.toUpperCase());
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
  const form = el('div', 'steer');
  const input = el('input');
  const who = nameOf(decision);
  input.placeholder = `tell ${who} what to do instead`;
  input.setAttribute('aria-label', `steer ${who}`);
  input.onkeydown = (event) => {
    event.stopPropagation();
    if (event.key === 'Enter' && input.value.trim()) {
      handlers.steer(decision.agentId, input.value.trim(), input.getBoundingClientRect());
      input.value = '';
    }
  };
  form.append(input, el('span', 'hint', '↵'));
  return form;
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
    : 'No saved conversations for this run - the agents will restart on the same goals';
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
  button.title = 'Start a new run with this mission and these goals';
  button.onclick = (event) => {
    event.stopPropagation();
    handlers.resumeRun(run.id);
  };
  return button;
}

export function renderRuns(root, runs, handlers) {
  // Runs arrive newest first, so the current run is the newest one that has
  // not ended. An older run with no end time crashed; saying "current" about
  // four of them at once would be a lie.
  const currentId = runs.find((run) => !run.ended_at)?.id ?? null;
  const rows = [newRunRow(handlers)];
  if (!runs.length) {
    rows.push(
      teach(
        'no earlier runs',
        'Every run is kept whole - the mission, the fleet and every event - so a ' +
          'morning that went wrong can be opened again and read back.',
      ),
    );
  } else {
    rows.push(...runs.map((run) => runRow(run, run.id === currentId, handlers)));
  }
  root.replaceChildren(...rows);
}

function newRunRow(handlers) {
  const row = el('button', 'run new', '+ NEW RUN');
  row.type = 'button';
  row.setAttribute('aria-label', 'Start a new run');
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
