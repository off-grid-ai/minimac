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
// It holds no truth. The goal it shows arrives in render(); editing it goes
// straight back out through the handlers it was built with.

export function createGoalStrip({ handlers, console: consoleEl }) {
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

  root.append(who, goal, power, close);
  (consoleEl?.parentElement ?? document.body).insertBefore(root, consoleEl ?? null);

  let agentId = null;
  let saved = '';
  let enabled = true;

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
    if (agentId) handlers.setEnabled(agentId, !enabled);
  };

  // The strip sits on the console, and the console moves as its input grows.
  const follow = () => {
    if (root.hidden || !consoleEl) return;
    const box = consoleEl.getBoundingClientRect();
    root.style.left = `${box.left}px`;
    root.style.width = `${box.width}px`;
    root.style.bottom = `${Math.max(0, window.innerHeight - box.top)}px`;
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
    },

    render(agent) {
      if (!agent) return this.close();
      const fresh = agent.id !== agentId;
      agentId = agent.id;
      root.hidden = false;

      who.textContent = agent.label ?? agent.name;
      who.dataset.status = agent.status;

      enabled = agent.enabled !== false;
      power.setAttribute('aria-checked', String(enabled));
      power.setAttribute('aria-label', `${agent.label ?? agent.name} on this mission`);
      power.title = enabled
        ? `Take ${agent.label ?? agent.name} off this mission`
        : `Bring ${agent.label ?? agent.name} onto this mission`;

      // Never rewritten under the keyboard: an event arriving must not swallow
      // what is being typed.
      const objective = agent.goal?.objective ?? '';
      if (document.activeElement !== goal && (fresh || objective !== saved)) {
        saved = objective;
        goal.value = objective;
      }
      follow(); // places the strip and measures the field at its real width
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
      align-items: flex-start;
      gap: calc(var(--step) * 2);
      padding: calc(var(--step) * 2) calc(var(--step) * 2.5);
      background: var(--glass);
      backdrop-filter: blur(10px) saturate(1.1);
      border: 1px solid var(--line);
      border-bottom: 0;
      font-family: var(--mono);
      animation: hud-in 160ms cubic-bezier(0.2, 0.7, 0.3, 1);
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
