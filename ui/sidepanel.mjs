// One side panel, one tab strip. Replaces the floating windows: they competed
// for space, covered the room and had to be arranged by hand. A panel has one
// place, one width, and shows one thing at a time.
//
// It adopts the existing window elements as its tab bodies, so the panels do
// not know they moved.

const MIN_W = 320;
const MAX_W = 900;
const DEFAULT_W = 560;
const STORE_KEY = 'minimac.panel';

export function createSidePanel({ entries, labels = {}, onChange }) {
  const saved = load();
  // Width is remembered; being open is not. A reload should show the room, not
  // whatever panel happened to be up last time.
  let active = null;
  let width = clamp(saved.width ?? DEFAULT_W, MIN_W, MAX_W);

  const panel = document.createElement('aside');
  panel.className = 'sidepanel';
  panel.hidden = true;

  const grip = document.createElement('div');
  grip.className = 'sidepanel-grip';
  grip.setAttribute('aria-hidden', 'true');

  const tabs = document.createElement('div');
  tabs.className = 'sidepanel-tabs';
  tabs.setAttribute('role', 'tablist');

  const missionNav = document.createElement('div');
  missionNav.className = 'sidepanel-mission-nav';
  const missionButton = document.createElement('button');
  missionButton.type = 'button';
  missionButton.className = 'sidepanel-mission-button';
  missionButton.textContent = 'MISSIONS';
  missionButton.onclick = () => show('runs');
  const missionContext = document.createElement('span');
  missionContext.className = 'sidepanel-mission-context';
  missionNav.append(missionButton, missionContext);

  const bodies = document.createElement('div');
  bodies.className = 'sidepanel-bodies';

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'sidepanel-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'close panel');
  close.onclick = () => hide();

  panel.append(grip, missionNav, tabs, bodies, close);
  document.body.append(panel);
  applyWidth();
  style();

  // Each window element becomes a tab body. Its own title bar goes away - the
  // tab strip already says what you are looking at.
  const tabButtons = new Map();
  const badges = new Map();
  for (const [name, entry] of Object.entries(entries)) {
    if (!entry?.el) continue;
    entry.el.classList.add('sidepanel-body');
    entry.el.hidden = true;
    entry.bar?.remove();
    bodies.append(entry.el);

    if (name === 'runs') continue;

    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'sidepanel-tab';
    tab.textContent = labels[name] ?? name.toUpperCase();
    // A tab can carry a count. Only the queue does today, and it is the one
    // number worth seeing without opening anything.
    const badge = document.createElement('i');
    badge.className = 'sidepanel-count';
    badge.dataset.view = name;
    badge.hidden = true;
    tab.append(badge);
    badges.set(name, badge);
    tab.setAttribute('role', 'tab');
    tab.onclick = () => show(name);
    tabs.append(tab);
    tabButtons.set(name, tab);
  }

  function show(name) {
    if (!entries[name]?.el) return;
    active = name;
    panel.hidden = false;
    for (const [key, entry] of Object.entries(entries)) {
      if (entry?.el) entry.el.hidden = key !== name;
      tabButtons.get(key)?.setAttribute('aria-selected', String(key === name));
      entries[key]?.button?.setAttribute('aria-pressed', String(key === name));
    }
    missionButton.setAttribute('aria-selected', String(name === 'runs'));
    applyWidth();
    save({ width });
    onChange?.();
  }

  function hide() {
    panel.hidden = true;
    for (const entry of Object.values(entries)) entry?.button?.setAttribute('aria-pressed', 'false');
    active = null;
    applyWidth();
    save({ width });
    onChange?.();
  }

  function applyWidth() {
    panel.style.width = `${width}px`;
    document.documentElement.style.setProperty('--panel-w', panel.hidden ? '0px' : `${width}px`);
    // The three.js canvas sizes itself from its element, so it has to be told
    // the element changed.
    dispatchEvent(new Event('resize'));
  }

  // Drag the panel's inner edge to resize. The room keeps the rest.
  grip.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const onMove = (move) => {
      width = clamp(startWidth + (startX - move.clientX), MIN_W, MAX_W);
      applyWidth();
    };
    const onUp = () => {
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      save({ width });
    };
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', onUp);
  });

  return {
    // How many things are waiting behind a tab. Zero hides it entirely - a
    // badge showing 0 is noise pretending to be information.
    setCount(name, count) {
      const badge = badges.get(name);
      if (!badge) return;
      badge.textContent = String(count);
      badge.hidden = !count;
    },
    setMissionContext({ id = null, title = '' } = {}) {
      missionContext.textContent = id ? `#${id}  ${title || 'No mission set'}` : 'NO MISSION SELECTED';
      missionContext.title = title || '';
    },
    open: show,
    close: hide,
    toggle(name) {
      const isActive = active === name && !panel.hidden;
      if (isActive) hide();
      else show(name);
      return !isActive;
    },
    isOpen(name) {
      return active === name && !panel.hidden;
    },
    openNames() {
      return active && !panel.hidden ? [active] : [];
    },
    reset() {
      width = DEFAULT_W;
      applyWidth();
      save({ width });
    },
  };
}

function style() {
  if (document.getElementById('sidepanel-style')) return;
  const sheet = document.createElement('style');
  sheet.id = 'sidepanel-style';
  sheet.textContent = `
    :root { --panel-w: 0px; }
    .sidepanel {
      position: fixed; top: var(--topbar-h, 46px); right: 0; bottom: 0;
      z-index: 40; display: flex; flex-direction: column;
      background: var(--surface, #121212);
      border-left: 1px solid var(--line, #262626);
      font: 12px/1.55 Menlo, monospace; color: var(--text, #e8e8e8);
    }
    .sidepanel-grip {
      position: absolute; left: -3px; top: 0; bottom: 0; width: 7px;
      cursor: ew-resize; z-index: 2;
    }
    .sidepanel-grip:hover { background: var(--accent, #34d399); opacity: .35; }
    .sidepanel-close {
      position: absolute; top: 12px; right: 14px; z-index: 3;
      background: transparent; border: 0; color: var(--muted, #8a8a8a);
      font: inherit; font-size: 15px; line-height: 1; cursor: pointer;
    }
    .sidepanel-mission-nav {
      display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center;
      gap: 10px; padding: 10px 40px 8px 16px;
      border-bottom: 1px solid var(--line, #262626); flex: none;
    }
    .sidepanel-mission-button {
      background: transparent; border: 0; color: var(--accent, #34d399);
      font: inherit; font-size: 10px; letter-spacing: .12em; padding: 4px 0;
      cursor: pointer;
    }
    .sidepanel-mission-button[aria-selected="true"] {
      box-shadow: inset 0 -1px 0 var(--accent, #34d399);
    }
    .sidepanel-mission-context {
      min-width: 0; overflow: hidden; color: var(--muted, #8a8a8a);
      font-size: 10px; text-overflow: ellipsis; white-space: nowrap;
    }
    .sidepanel-tabs {
      display: flex; flex-wrap: nowrap; gap: 0; padding: 6px 40px 6px 16px;
      border-bottom: 1px solid var(--line, #262626); flex: none;
      overflow-x: auto; scrollbar-width: none;
    }
    .sidepanel-tabs::-webkit-scrollbar { display: none; }
    .sidepanel-tab {
      flex: 0 0 auto; background: transparent; border: 0; border-bottom: 1px solid transparent;
      color: var(--muted, #8a8a8a); font: inherit; font-size: 9px;
      letter-spacing: .1em; padding: 5px 8px; cursor: pointer;
    }
    .sidepanel-tab:hover { color: var(--text, #e8e8e8); }
    .sidepanel-count {
      display: inline-block; margin-left: 5px;
      font-style: normal; font-size: 9px; line-height: 14px;
      color: var(--faint, #5a5a5a);
    }
    .sidepanel-count[data-view="decisions"] {
      padding: 0 4px; background: var(--danger, #f87171); color: #fff;
    }
    .sidepanel-tab[aria-selected="true"] {
      color: var(--accent, #34d399); border-bottom-color: var(--accent, #34d399);
    }
    .sidepanel-bodies { flex: 1; min-height: 0; display: flex; }
    .sidepanel-body {
      position: static !important;
      inset: auto !important;
      width: 100% !important; height: 100% !important; max-height: none !important;
      border: 0 !important; background: transparent !important;
      display: flex; flex-direction: column; min-height: 0;
    }
    .sidepanel-body .win-body,
    .sidepanel-body > div:last-child { flex: 1; min-height: 0; overflow: auto; }
    .sidepanel-body .win-body {
      padding: 12px 16px 20px 20px;
      background-position: 12px 0;
    }
    .sidepanel-body .win-grip { display: none !important; }

    /* The panel takes real space: the room and the console live in what is
       left, rather than sliding underneath it. */
    #floor { width: calc(100vw - var(--panel-w)) !important; }
    #composer {
      left: calc((100vw - var(--panel-w)) / 2) !important;
      width: min(920px, calc(100vw - var(--panel-w) - var(--gap, 12px) * 2)) !important;
    }
  `;
  document.head.append(sheet);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function save(value) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(value));
  } catch {
    // storage disabled: the panel simply forgets its width between reloads
  }
}
