// One side panel, one tab strip. Replaces the floating windows: they competed
// for space, covered the room and had to be arranged by hand. A panel has one
// place, one width, and shows one thing at a time.
//
// It adopts the existing window elements as its tab bodies, so the panels do
// not know they moved.

import { createContextPanel } from './context-panel.mjs';

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
  const context = createContextPanel({ host: bodies, onClose: () => active && show(active) });

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
    context.reset();
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
    openEntity(entity, options) {
      panel.hidden = false;
      for (const entry of Object.values(entries)) if (entry?.el) entry.el.hidden = true;
      context.openEntity(entity, options);
      applyWidth();
    },
    replaceEntity(entity) {
      panel.hidden = false;
      for (const entry of Object.values(entries)) if (entry?.el) entry.el.hidden = true;
      context.replaceEntity(entity);
      applyWidth();
    },
    currentEntity: () => context.current(),
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

    .connected-context {
      width: 100%; min-height: 0; overflow: auto; padding: 8px 12px 12px;
      background: var(--surface, #121212);
    }
    .connected-context-bar {
      position: sticky; top: 0; z-index: 2; display: grid;
      grid-template-columns: 24px minmax(0, 1fr) auto; align-items: center;
      min-height: 36px; gap: 4px; padding: 0; background: var(--surface, #121212);
      border-bottom: 1px solid var(--line, #262626);
    }
    .connected-context-identity {
      min-width: 0; display: flex; align-items: baseline; gap: 6px;
      overflow: hidden; white-space: nowrap;
    }
    .connected-context-identity span:first-child {
      overflow: hidden; color: var(--text, #e8e8e8); font-size: 12px;
      text-overflow: ellipsis;
    }
    .connected-context-identity span:nth-child(2) {
      color: var(--faint, #5a5a5a); font-size: 9px; letter-spacing: .1em;
      text-transform: uppercase;
    }
    .connected-context-actions,
    .connected-context-trailing { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .connected-context-trailing .agent-runtime { margin-left: 0; }
    .connected-context-trailing .agent-runtime select { padding: 2px 16px 2px 5px; }
    .connected-context-trailing > span:last-child { color: var(--faint, #5a5a5a); font-size: 9px; }
    .connected-context-trailing select {
      min-height: 24px; border: 1px solid var(--line, #262626); background: var(--bg, #0a0a0a);
      color: var(--muted, #8a8a8a); font: 9px Menlo, monospace; padding: 1px 4px;
    }
    .connected-status { display: inline-flex; align-items: center; gap: 4px; color: var(--faint, #5a5a5a); font-size: 9px; }
    .connected-status i { width: 7px; height: 7px; border-radius: 50%; background: #d49a28; }
    .connected-status[data-state="active"] i,
    .connected-status[data-state="running"] i,
    .connected-status[data-state="resolved"] i,
    .connected-status[data-state="done"] i { background: var(--accent, #34d399); }
    .connected-status[data-state="stopped"] i,
    .connected-status[data-state="failed"] i,
    .connected-status[data-state="blocked"] i { background: var(--danger, #f87171); }
    .connected-context-body, .connected-entity-content { display: grid; gap: 8px; }
    .connected-context-body { min-height: 0; }
    .connected-entity-content { grid-template-rows: auto; }
    .connected-entity-facts { display: flex; flex-wrap: wrap; gap: 16px; margin: 0; padding: 6px 0; }
    .connected-entity-facts > div { display: grid; grid-template-columns: auto auto; gap: 5px; align-items: baseline; }
    .connected-entity-facts dt,
    .connected-copy h3,
    .connected-links h3 { margin: 0; color: var(--faint, #5a5a5a); font: 400 9px/1.2 Menlo, monospace; letter-spacing: .1em; }
    .connected-entity-facts dd { margin: 0; color: var(--text, #e8e8e8); font-size: 10px; }
    .connected-copy, .connected-links { display: grid; gap: 4px; margin: 0; padding: 4px 0; }
    .connected-copy h3, .connected-copy p { margin: 0; }
    .connected-copy p { color: var(--muted, #8a8a8a); font-size: 11px; line-height: 1.4; }
    .connected-work-list { display: grid; border-top: 1px solid var(--line, #262626); }
    .connected-work-row {
      width: 100%; min-height: 30px !important; display: grid !important;
      grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px;
      padding: 3px 4px !important; text-align: left; border: 0 !important;
      border-bottom: 1px solid var(--line, #262626) !important;
    }
    .connected-work-row b { color: var(--accent, #34d399); font-weight: 400; }
    .connected-work-row span { overflow: hidden; color: var(--text, #e8e8e8); text-overflow: ellipsis; white-space: nowrap; }
    .connected-work-row small { color: var(--faint, #5a5a5a); font-size: 9px; }
    .connected-resource {
      max-height: 55vh; overflow: auto; margin: 0; padding: 10px;
      background: var(--nested, #171717); border-left: 1px solid var(--line, #262626);
      color: var(--text, #e8e8e8); font: 10px/1.55 Menlo, monospace; white-space: pre-wrap;
    }
    .connected-entity-thread { min-height: 0; border-top: 1px solid var(--line, #262626); }
    .conversation-group { padding: 8px 0; border-bottom: 1px solid var(--line, #262626); }
    .conversation-group-head { display: flex; justify-content: space-between; gap: 8px; color: var(--faint, #5a5a5a); font-size: 9px; }
    .conversation-group-head span:first-child { color: var(--text, #e8e8e8); }
    .conversation-message { display: grid; gap: 5px; padding: 4px 0 0; }
    .conversation-message[data-reply-to] { padding-left: 10px; border-left: 1px solid var(--line, #262626); }
    .conversation-body { color: var(--text, #e8e8e8); font-size: 11px; line-height: 1.5; }
    .conversation-body > :first-child { margin-top: 0; }
    .conversation-body > :last-child { margin-bottom: 0; }
    .conversation-actions, .conversation-references, .conversation-attachments {
      display: flex; flex-wrap: wrap; align-items: center; gap: 4px;
    }
    .conversation-actions { opacity: 0; transition: opacity 120ms ease-out; }
    .conversation-message:hover .conversation-actions,
    .conversation-message:focus-within .conversation-actions { opacity: 1; }
    .conversation-references .control-button { min-height: 20px; padding: 1px 5px; }
    .conversation-thread-link { width: 22px; padding: 0 !important; }
    .conversation-thread-link svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.2; }
    .conversation-attachment { color: var(--accent, #34d399); font-size: 9px; text-decoration: none; }
    .conversation-attachment img { display: block; width: 112px; height: 72px; object-fit: cover; border: 1px solid var(--line, #262626); }
    .conversation-empty { margin: 0; padding: 8px 0; color: var(--faint, #5a5a5a); font-size: 10px; }
    .feed-thread-index {
      display: flex; align-items: center; gap: 4px; min-width: 0; overflow-x: auto;
      padding: 4px 0 6px; border-bottom: 1px solid var(--line, #262626);
    }
    .feed-thread-index > span {
      flex: 0 0 auto; margin-right: 2px; color: var(--faint, #5a5a5a);
      font-size: 9px; letter-spacing: .1em;
    }
    .feed-thread-index .control-button { flex: 0 0 auto; min-height: 22px; padding: 1px 6px; }
    .feed-thread-button {
      width: 22px; min-height: 20px; padding: 0; border: 0; background: transparent;
      color: var(--faint, #5a5a5a); cursor: pointer;
    }
    .feed-thread-button:hover, .feed-thread-button:focus-visible { color: var(--accent, #34d399); }
    .feed-thread-button svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.2; }
    .connected-entity-composer {
      position: sticky; bottom: -12px; z-index: 2; display: grid; gap: 4px;
      padding: 6px 0 0; background: var(--surface, #121212); border-top: 1px solid var(--line, #262626);
    }
    .connected-entity-composer .panel-compose-row {
      grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: "actions input send";
      gap: 4px; align-items: center;
    }
    .connected-entity-composer .panel-compose-input { min-height: 34px; padding: 6px 8px; font-size: 11px; }
    .connected-entity-composer .panel-compose-actions { align-items: center; }

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
