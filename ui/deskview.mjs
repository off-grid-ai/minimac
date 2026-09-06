// The desk view: the conversation, in the room, at the desk it belongs to.
//
// Clicking an agent pushes the camera in and opens this. It is the whole of
// what used to be three global tabs - FLOW, EVIDENCE and CREW - plus the
// thread and a reply box, all pinned to one desk, because a contract, a claim
// and a goal belong to an agent and never to the floor.
//
// It holds no truth. Everything it draws arrives in render(); everything it
// does goes straight back out through the handlers it was built with.

import { renderFlows, renderEvidence } from './panels.mjs';
import { renderMarkdown } from './markdown.mjs';
import { TURN } from '../core/thread.mjs';
import { ENGINES } from '../core/roster.mjs';

const THREAD_W = 420;
const CARD_W = 300;
const GAP = 12;
const MARGIN = 10;
const HEAD_CLEAR = 22; // the bubbles sit this far above the head

export function createDeskView({ handlers }) {
  style();

  const root = document.createElement('div');
  root.className = 'desk';
  root.hidden = true;

  const column = document.createElement('div');
  column.className = 'desk-column';

  const thread = document.createElement('div');
  thread.className = 'desk-thread';
  thread.setAttribute('role', 'log');
  thread.setAttribute('aria-live', 'polite');

  const answers = document.createElement('div');
  answers.className = 'desk-answers';
  answers.hidden = true;

  const reply = document.createElement('form');
  reply.className = 'desk-reply';
  const input = document.createElement('input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  const sendButton = document.createElement('button');
  sendButton.type = 'submit';
  sendButton.className = 'desk-send';
  sendButton.textContent = 'SEND';
  reply.append(input, sendButton);

  column.append(thread, answers, reply);

  const card = document.createElement('aside');
  card.className = 'desk-card';

  const cardHead = document.createElement('header');
  cardHead.className = 'desk-card-head';
  const who = document.createElement('span');
  who.className = 'desk-who';
  const status = document.createElement('span');
  status.className = 'desk-status';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'desk-close';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'back to the room');
  close.onclick = () => handlers.close();
  cardHead.append(who, status, close);

  const engine = document.createElement('div');
  engine.className = 'engine desk-engine';
  engine.setAttribute('role', 'group');

  const goalLabel = section('goal');
  const goal = document.createElement('textarea');
  goal.className = 'desk-goal';
  goal.rows = 3;
  goal.placeholder = 'no goal - this agent would start blind';

  const flowsLabel = section('flow');
  const flows = document.createElement('div');
  flows.className = 'desk-sub';

  const evidenceLabel = section('evidence');
  const evidence = document.createElement('div');
  evidence.className = 'desk-sub';

  card.append(cardHead, engine, goalLabel, goal, flowsLabel, flows, evidenceLabel, evidence);
  root.append(column, card);
  document.body.append(root);

  let agentId = null;
  let signature = '';
  let question = null;

  reply.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || !agentId) return;
    handlers.steer(agentId, text, input.getBoundingClientRect());
    input.value = '';
  });

  // Escape belongs to the room: it steps back out to the whole floor.
  root.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      handlers.close();
    }
  });

  goal.addEventListener('blur', () => {
    if (agentId && goal.value.trim() !== (goal.dataset.saved ?? '')) {
      handlers.setGoal(agentId, goal.value.trim());
    }
  });

  return {
    get agentId() {
      return agentId;
    },

    close() {
      agentId = null;
      signature = '';
      root.hidden = true;
    },

    // Called on every frame the desk is open. Cheap when nothing changed:
    // only the anchor moves, and the thread is rebuilt on a new signature.
    render(view) {
      if (!view?.agent) return this.close();
      const fresh = view.agent.id !== agentId;
      if (fresh) {
        agentId = view.agent.id;
        signature = '';
        root.hidden = false;
        input.value = '';
      }

      input.placeholder = `reply to ${view.agent.label ?? view.agent.name}`;
      input.setAttribute('aria-label', `reply to ${view.agent.label ?? view.agent.name}`);
      who.textContent = view.agent.label ?? view.agent.name;
      status.textContent = view.agent.status;
      status.dataset.status = view.agent.status;

      renderEngine(engine, view.agent, handlers);

      const objective = view.agent.goal?.objective ?? '';
      if (goal.dataset.saved !== objective && document.activeElement !== goal) {
        goal.dataset.saved = objective;
        goal.value = objective;
      }

      const next = threadSignature(view);
      if (next !== signature) {
        signature = next;
        paintThread(thread, view.thread, fresh);
        question = view.question ?? null;
        paintAnswers(answers, question, view.agent.id, handlers);
        renderFlows(flows, view.agent);
        renderEvidence(evidence, view.claims ?? []);
      }

      place(root, view.at);
      if (fresh) input.focus({ preventScroll: true });
    },
  };
}

// --------------------------------------------------------------- painting

function threadSignature(view) {
  const turns = view.thread ?? [];
  const last = turns[turns.length - 1];
  return [
    view.agent.id,
    turns.length,
    last?.at ?? 0,
    view.question?.id ?? '',
    view.agent.status,
    (view.claims ?? []).length,
    (view.agent.flows ?? []).length,
  ].join('|');
}

function paintThread(root, turns = [], jump) {
  const atBottom = jump || root.scrollHeight - root.scrollTop - root.clientHeight < 60;
  root.replaceChildren(...turns.map(bubble));
  if (atBottom) root.scrollTop = root.scrollHeight;
}

function bubble(turn) {
  const node = document.createElement('div');
  node.className = `turn ${turn.kind}${turn.mine ? ' mine' : ''}`;

  const body = document.createElement('div');
  body.className = 'turn-body md';
  // Prose is markdown; everything else is already one readable line from
  // core/readable.mjs and must never be re-parsed as markup.
  if (turn.markdown) body.innerHTML = renderMarkdown(turn.text);
  else body.textContent = turn.text;
  node.append(body);

  if (turn.kind === TURN.CLAIMED) {
    const note = document.createElement('div');
    note.className = `turn-note${turn.backed ? '' : ' unbacked'}`;
    note.textContent = turn.note;
    node.append(note);
  }

  if (turn.full && turn.full.length > turn.text.length) {
    body.title = turn.full;
    body.style.cursor = 'zoom-in';
    body.onclick = () => {
      const open = node.dataset.open === '1';
      body.textContent = open ? turn.text : turn.full;
      node.dataset.open = open ? '0' : '1';
    };
  }
  return node;
}

// The engine's own words, answerable where the question was asked.
function paintAnswers(root, question, id, handlers) {
  root.replaceChildren();
  root.hidden = !question?.id;
  if (!question?.id) return;

  const ask = document.createElement('div');
  ask.className = 'desk-ask';
  ask.textContent = question.summary ?? 'waiting on your answer';
  root.append(ask);

  const row = document.createElement('div');
  row.className = 'desk-choices';
  for (const choice of question.decisions ?? []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'act answer';
    button.dataset.choice = keyOf(choice);
    button.textContent = labelOf(choice);
    button.onclick = (event) =>
      handlers.approve(id, question.id, choice, event.currentTarget.getBoundingClientRect());
    row.append(button);
  }
  root.append(row);
}

function keyOf(choice) {
  const value = typeof choice === 'string' ? choice : choice?.value;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return Object.keys(value)[0] ?? 'answer';
  return 'answer';
}

function labelOf(choice) {
  if (typeof choice === 'string') return choice.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return choice?.label ?? keyOf(choice).replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

function renderEngine(root, agent, handlers) {
  const wanted = [ENGINES.CODEX, ENGINES.CLAUDE, ENGINES.SIM];
  if (root.childElementCount !== wanted.length) {
    root.replaceChildren(
      ...wanted.map((name) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = name.toUpperCase();
        button.dataset.engine = name;
        button.onclick = () => handlers.assignEngine(agent.id, name);
        return button;
      }),
    );
  }
  for (const button of root.children) {
    button.setAttribute('aria-pressed', String(agent.engine === button.dataset.engine));
    button.setAttribute('aria-label', `${agent.label ?? agent.name} on ${button.dataset.engine}`);
  }
}

// -------------------------------------------------------------- placement

// The whole view hangs off one point: just above that agent's head. It is
// clamped into the viewport rather than allowed to run off the edge, and the
// thread gives up height before anything is pushed under the top bar.
function place(root, at) {
  if (!at) return;
  const topbar = readPx('--topbar-h', 34);
  const width = THREAD_W + CARD_W + GAP;
  const half = width / 2;
  const left = Math.min(
    Math.max(at.x, half + MARGIN),
    Math.max(half + MARGIN, window.innerWidth - readPx('--panel-w', 0) - half - MARGIN),
  );
  const bottom = Math.max(at.y - HEAD_CLEAR, topbar + 120);
  root.style.setProperty('--desk-max', `${Math.max(160, bottom - topbar - MARGIN * 2)}px`);
  root.style.left = `${left}px`;
  root.style.top = `${bottom}px`;
}

function readPx(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

function section(text) {
  const node = document.createElement('div');
  node.className = 'desk-section';
  node.textContent = text;
  return node;
}

// ------------------------------------------------------------------ style

function style() {
  if (document.getElementById('deskview-style')) return;
  const sheet = document.createElement('style');
  sheet.id = 'deskview-style';
  sheet.textContent = `
    .desk {
      position: fixed;
      z-index: 44;
      display: flex;
      align-items: flex-end;
      gap: ${GAP}px;
      transform: translate(-50%, -100%);
      font-family: var(--mono);
      --desk-max: 40vh;
      animation: hud-in 170ms cubic-bezier(0.2, 0.7, 0.3, 1);
    }
    .desk-column { width: ${THREAD_W}px; display: flex; flex-direction: column; gap: 6px; }

    .desk-thread {
      max-height: min(var(--desk-max), 52vh);
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding-right: 4px;
      scrollbar-width: thin;
      scrollbar-color: var(--sunk) transparent;
    }
    .desk-thread::-webkit-scrollbar { width: 8px; }
    .desk-thread::-webkit-scrollbar-thumb { background: var(--sunk); }

    /* A turn is a bubble over the room, so it needs its own ground. */
    .turn {
      align-self: flex-start;
      max-width: 92%;
      padding: 6px 10px;
      background: var(--glass-solid);
      backdrop-filter: blur(6px);
      border: 1px solid var(--line);
      border-left: 2px solid var(--line);
      color: var(--text);
      font-size: 12px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .turn.said { border-left-color: var(--muted); }
    .turn.done { border-left-color: var(--accent); }
    .turn.mine {
      align-self: flex-end;
      border-left: 1px solid var(--accent-edge);
      border-right: 2px solid var(--accent);
      background: var(--accent-soft);
      color: var(--text);
    }
    .turn.worked {
      align-self: flex-start;
      max-width: 100%;
      padding: 2px 8px;
      background: transparent;
      backdrop-filter: none;
      border: 0;
      border-left: 1px solid var(--line);
      color: var(--faint);
      font-size: 11px;
    }
    .turn.blocked, .turn.asked { border-left-color: var(--danger); color: var(--text); }
    .turn.claimed { border-left-color: var(--muted); }
    .turn-note { color: var(--faint); font-size: 10px; margin-top: 2px; }
    .turn-note.unbacked { color: var(--danger); }

    .desk-answers {
      display: grid;
      gap: 6px;
      padding: 7px 9px;
      background: var(--surface);
      border: 1px solid var(--accent-edge);
      box-shadow: 0 0 14px -6px var(--accent-glow);
    }
    .desk-ask { color: var(--text); font-size: 12px; overflow-wrap: anywhere; }
    .desk-choices { display: flex; gap: 6px; flex-wrap: wrap; }

    .desk-reply { display: flex; gap: 6px; }
    .desk-reply input {
      flex: 1;
      min-width: 0;
      background: var(--bg);
      border: 1px solid var(--accent-edge);
      color: var(--text);
      font: inherit;
      font-size: 12px;
      padding: 6px 9px;
    }
    .desk-reply input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 12px -4px var(--accent-glow); }
    .desk-send {
      flex: none;
      background: var(--accent-soft);
      border: 1px solid var(--accent-edge);
      color: var(--accent);
      font: inherit;
      font-size: 10px;
      letter-spacing: 0.14em;
      padding: 0 11px;
      cursor: pointer;
    }
    .desk-send:hover { background: var(--accent); color: var(--accent-ink); }

    .desk-card {
      width: ${CARD_W}px;
      max-height: min(var(--desk-max), 52vh);
      overflow-y: auto;
      padding: 8px 10px 10px;
      background: var(--glass);
      backdrop-filter: blur(10px) saturate(1.1);
      border: 1px solid var(--line);
      scrollbar-width: thin;
      scrollbar-color: var(--sunk) transparent;
    }
    .desk-card::-webkit-scrollbar { width: 8px; }
    .desk-card::-webkit-scrollbar-thumb { background: var(--sunk); }

    .desk-card-head { display: flex; align-items: baseline; gap: 8px; }
    .desk-who { color: var(--accent); font-size: 12px; letter-spacing: 0.08em; min-width: 0;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .desk-status {
      margin-left: auto; flex: none;
      font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--faint);
    }
    .desk-status[data-status="running"] { color: var(--accent); }
    .desk-status[data-status="blocked"] { color: var(--danger); }
    .desk-close {
      flex: none; background: transparent; border: 0; color: var(--faint);
      font: inherit; font-size: 12px; line-height: 1; padding: 0 2px; cursor: pointer;
    }
    .desk-close:hover { color: var(--text); }

    .desk-engine { margin-top: 7px; }
    .desk-section {
      margin-top: 10px; padding-top: 6px;
      border-top: 1px solid var(--line-soft);
      font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--faint);
    }
    .desk-goal {
      width: 100%; margin-top: 4px; resize: vertical;
      background: var(--bg); border: 1px solid var(--line); color: var(--text);
      font: inherit; font-size: 11px; line-height: 1.45; padding: 5px 7px;
      white-space: pre-wrap; overflow-wrap: anywhere;
    }
    .desk-goal:focus { outline: none; border-color: var(--accent); }
    .desk-sub { font-size: 11px; }
    .desk-sub .teach-note { font-size: 10px; }

    @media (prefers-reduced-motion: reduce) { .desk { animation: none; } }
    @media (max-width: 900px) {
      .desk-card { display: none; }
    }
  `;
  document.head.append(sheet);
}
