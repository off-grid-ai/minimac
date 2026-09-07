// The goal strip: the one piece of chrome that appears when you stand at a
// desk.
//
// Clicking an agent pushes the camera to that desk. The console already says
// who you are addressing and is already how you talk to them, so the only
// thing missing at a desk is the standing instruction that agent is working
// to - and the ability to change it without going looking for a panel.
//
// It is a row of the console, not a window over the room: same glass, same
// width, growing upward the way the attachment chips do, so it can never be
// clipped by the top bar and never covers the floor.
//
// Standing at a desk shows that agent's whole standing: the goal they are
// working to, the flow contract they accepted, and anything that needs a
// decision now. Evidence stays in the feed, where its history belongs.
//
// It holds no truth. Everything it shows arrives in render(); editing the goal
// goes straight back out through the handlers it was built with.

export function createGoalStrip({ handlers, console: consoleEl, renderDecisions }) {
  style();

  const root = document.createElement('div');
  root.className = 'goalstrip';
  root.hidden = true;

  const who = document.createElement('span');
  who.className = 'goalstrip-who';

  const goal = document.createElement('textarea');
  goal.className = 'goalstrip-goal';
  goal.rows = 1;
  goal.spellcheck = false;
  goal.placeholder = 'no goal - this agent would start blind';

  // The same switch shape as everywhere else: a boolean is never a button that
  // says ON.
  const power = document.createElement('button');
  power.type = 'button';
  power.className = 'switch';
  power.setAttribute('role', 'switch');
  power.append(document.createElement('i'));

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'goalstrip-close';
  close.textContent = '✕';
  close.title = 'back to the whole room';
  close.setAttribute('aria-label', 'back to the whole room');
  close.onclick = () => handlers.close();

  // The goal line, then the desk itself. The head row is what you steer with;
  // the body is what you are steering.
  const head = document.createElement('div');
  head.className = 'goalstrip-head';
  head.append(who, goal, power, close);

  const desk = document.createElement('div');
  desk.className = 'goalstrip-desk';

  const decisionPane = section('decisions', 'what needs you');
  desk.append(decisionPane.root);

  root.append(head, desk);
  (consoleEl?.parentElement ?? document.body).insertBefore(root, consoleEl ?? null);

  let agentId = null;
  let saved = '';
  let enabled = true;
  let decisionSignature = '';
  let pendingDecisions = null;

  const paintDecisions = (decisions) => {
    const signature = JSON.stringify(decisions);
    if (signature === decisionSignature) return;
    if (decisionPane.body.contains(document.activeElement)) {
      pendingDecisions = decisions;
      return;
    }
    pendingDecisions = null;
    decisionSignature = signature;
    decisionPane.setCount(decisions.length);
    renderDecisions?.(decisionPane.body, decisions);
  };

  decisionPane.body.addEventListener('focusout', () => {
    if (!pendingDecisions) return;
    queueMicrotask(() => paintDecisions(pendingDecisions ?? []));
  });

  const commit = () => {
    const next = goal.value.trim();
    if (!agentId || next === saved) return;
    saved = next;
    handlers.setGoal(agentId, next);
  };

  goal.addEventListener('blur', commit);
  goal.addEventListener('input', autosize);
  goal.addEventListener('keydown', (event) => {
    event.stopPropagation(); // typing a goal is not a shortcut
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      commit();
      goal.blur();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      goal.value = saved;
      autosize();
      goal.blur();
    }
  });

  power.onclick = () => {
    if (agentId) handlers.setActive(agentId, !enabled);
  };

  // The strip sits on the console, and the console moves as its input grows.
  const follow = () => {
    if (root.hidden || !consoleEl) return;
    const box = consoleEl.getBoundingClientRect();
    root.style.left = `${box.left}px`;
    root.style.width = `${box.width}px`;
    root.style.bottom = `${Math.max(0, window.innerHeight - box.top)}px`;
    // How much of the room this desk is standing in front of. The scene frames
    // the hero inside what is LEFT, so opening a desk never puts the panel on
    // top of the person it is about.
    const own = root.getBoundingClientRect();
    document.documentElement.style.setProperty(
      '--desk-h',
      `${Math.round(Math.max(0, window.innerHeight - own.top))}px`,
    );
    // The field wraps at the console's width, so it can only be measured once
    // that width is set. Measuring first gives a column an inch wide and a box
    // ten lines tall.
    autosize();
  };
  if (consoleEl) new ResizeObserver(follow).observe(consoleEl);
  addEventListener('resize', follow);

  function autosize() {
    if (root.hidden) return;
    goal.style.height = 'auto';
    const cap = Math.round(window.innerHeight * 0.2);
    goal.style.height = `${Math.min(goal.scrollHeight, cap)}px`;
    goal.style.overflowY = goal.scrollHeight > cap ? 'auto' : 'hidden';
  }

  return {
    get agentId() {
      return agentId;
    },

    close() {
      agentId = null;
      root.hidden = true;
      document.documentElement.style.setProperty('--desk-h', '0px');
    },

    render(agent) {
      if (!agent) return this.close();
      const fresh = agent.id !== agentId;
      agentId = agent.id;
      root.hidden = false;

      who.textContent = agent.label ?? agent.name;
      who.dataset.status = agent.status;

      enabled = agent.active === true;
      power.setAttribute('aria-checked', String(enabled));
      power.setAttribute('aria-label', `${agent.label ?? agent.name} working`);
      power.title = enabled
        ? `Stop ${agent.label ?? agent.name}`
        : `Start ${agent.label ?? agent.name}`;

      // Never rewritten under the keyboard: an event arriving must not swallow
      // what is being typed.
      const objective = agent.goal?.objective ?? '';
      if (document.activeElement !== goal && (fresh || objective !== saved)) {
        saved = objective;
        goal.value = objective;
      }
      paintDecisions(agent.decisions ?? []);

      follow(); // places the strip and measures the field at its real width
    },
  };
}

// One titled pane of the desk. The count is on the title so an empty flow or
// an unproved claim list is visible without opening anything.
function section(name, blurb) {
  const root = document.createElement('section');
  root.className = `goalstrip-pane goalstrip-${name}`;

  const title = document.createElement('div');
  title.className = 'goalstrip-title';
  const label = document.createElement('span');
  label.textContent = name;
  const count = document.createElement('span');
  count.className = 'goalstrip-count';
  title.append(label, count);

  const hint = document.createElement('span');
  hint.className = 'goalstrip-blurb';
  hint.textContent = blurb;
  title.append(hint);

  const body = document.createElement('div');
  body.className = 'goalstrip-body';

  root.append(title, body);
  return {
    root,
    body,
    setCount(n) {
      count.textContent = String(n);
      root.dataset.empty = n ? '' : 'yes';
    },
  };
}

function style() {
  if (document.getElementById('goalstrip-style')) return;
  const sheet = document.createElement('style');
  sheet.id = 'goalstrip-style';
  sheet.textContent = `
    /* Another row of the console, not a window over the room. */
    .goalstrip {
      position: fixed;
      z-index: 49;
      display: flex;
      flex-direction: column;
      /* It grows upward from the console and must stop at the crew bar. Without
         a ceiling a tall desk ran off both ends of the screen. */
      max-height: min(48vh, 520px);
      min-height: 0;
      overflow: auto;
      gap: calc(var(--step) * 1.5);
      padding: calc(var(--step) * 2) calc(var(--step) * 2.5);
      background: var(--glass);
      backdrop-filter: blur(10px) saturate(1.1);
      border: 1px solid var(--line);
      border-bottom: 0;
      font-family: var(--mono);
      animation: hud-in 160ms cubic-bezier(0.2, 0.7, 0.3, 1);
    }

    .goalstrip-head {
      display: flex;
      align-items: flex-start;
      gap: calc(var(--step) * 2);
    }

    /* Two columns while there is room for two, one when there is not. */
    .goalstrip-desk {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: calc(var(--step) * 2);
      min-height: 0;
      overflow: hidden;
    }
    .goalstrip-pane {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      border-top: 1px solid var(--line);
      padding-top: calc(var(--step) * 1.5);
    }
    .goalstrip-title {
      display: flex;
      align-items: baseline;
      gap: calc(var(--step));
      color: var(--muted);
      font-size: 9px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }
    .goalstrip-count {
      color: var(--accent);
      font-variant-numeric: tabular-nums;
    }
    .goalstrip-pane[data-empty="yes"] .goalstrip-count { color: var(--faint); }
    .goalstrip-blurb {
      margin-left: auto;
      color: var(--faint);
      letter-spacing: 0.04em;
      text-transform: none;
    }
    .goalstrip-body {
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      padding-top: calc(var(--step));
    }

    .goalstrip-who {
      flex: 0 0 auto;
      max-width: 30%;
      padding-top: 4px;
      color: var(--accent);
      font-size: 9px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .goalstrip-who[data-status="blocked"] { color: var(--danger); }

    .goalstrip-goal {
      flex: 1 1 auto;
      min-width: 0;
      resize: none;
      overflow-y: auto;
      background: var(--bg);
      border: 1px solid var(--line);
      color: var(--text);
      font: inherit;
      font-size: 12px;
      line-height: 1.45;
      padding: 4px 8px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .goalstrip-goal::placeholder { color: var(--faint); }
    .goalstrip-goal:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 12px -4px var(--accent-glow);
    }

    .goalstrip .switch { flex: 0 0 auto; margin-top: 5px; }

    .goalstrip-close {
      flex: 0 0 auto;
      background: transparent; border: 0; color: var(--faint);
      font: inherit; font-size: 12px; line-height: 1; padding: 4px 2px 0; cursor: pointer;
    }
    .goalstrip-close:hover { color: var(--text); }

    @media (prefers-reduced-motion: reduce) { .goalstrip { animation: none; } }
  `;
  document.head.append(sheet);
}
