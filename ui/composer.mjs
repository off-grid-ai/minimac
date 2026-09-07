// The composer. One input for everything you can say to the fleet: set the
// mission, steer whoever is selected, and name files, skills or agents inline.
//
// It owns no state beyond what is being typed. Where a message goes and what
// it means are decided by core/mentions.mjs and the server.

import { activeMention, applyMention, parseMentions } from '../core/mentions.mjs';

export const MISSION_TARGET = 'mission';
// Speak once, three ways. MISSION replaces what the run is for. POLICY binds
// every agent on every dispatch and every steer, forever, with no model in the
// path. THOR is the judgement lane: say it once and he decides who needs it.
export const POLICY_TARGET = 'policy';
export const ROUTE_TARGET = 'thor';
export const SPEAK_TARGETS = Object.freeze([
  { id: MISSION_TARGET, label: 'MISSION', blurb: 'what this run is for' },
  { id: POLICY_TARGET, label: 'POLICY', blurb: 'binds every agent, every message, forever' },
  { id: ROUTE_TARGET, label: 'THOR', blurb: 'say it once, he decides who needs it' },
]);

export function createComposer({
  dom,
  send,
  getAgents,
  getTarget,
  getHistory = () => [],
  setTarget,
  onSend,
  dropTarget = globalThis,
}) {
  if (!dom.input) return { setTarget() {}, focus() {} };

  let suggestions = [];
  let highlighted = 0;
  let token = 0;
  let attachments = [];
  let lastMission = '';
  let historyIndex = null;
  let historyDraft = '';
  let historyTarget = null;
  const localHistory = new Map();

  function agentIds() {
    return getAgents().map((agent) => agent.id);
  }

  async function fetchSuggestions(mention) {
    const mine = ++token;
    const list = await lookup(mention, agentIds());
    if (mine !== token) return; // a later keystroke already won
    suggestions = list;
    highlighted = 0;
    renderMenu();
  }

  function renderMenu() {
    if (!dom.menu) return;
    if (suggestions.length === 0) {
      dom.menu.hidden = true;
      dom.menu.replaceChildren();
      return;
    }
    dom.menu.replaceChildren(
      ...suggestions.map((value, index) => {
        const row = document.createElement('div');
        row.className = 'mention-row';
        row.textContent = value;
        row.setAttribute('aria-selected', String(index === highlighted));
        row.onmousedown = (event) => {
          event.preventDefault();
          accept(index);
        };
        return row;
      }),
    );
    dom.menu.hidden = false;
  }

  function closeMenu() {
    suggestions = [];
    renderMenu();
  }

  function accept(index) {
    const mention = activeMention(dom.input.value, dom.input.selectionStart);
    const value = suggestions[index];
    if (!mention || value === undefined) return;
    dom.input.value = applyMention(dom.input.value, mention, value);
    autosize();
    dom.input.selectionStart = dom.input.value.length;
    dom.input.selectionEnd = dom.input.value.length;
    closeMenu();
    dom.input.focus();
  }

  function submit() {
    const text = dom.input.value.trim();
    if (!text && attachments.length === 0) return;
    const target = getTarget();
    if (text) {
      const sent = localHistory.get(target) ?? [];
      localHistory.set(target, [...sent, text]);
    }
    onSend?.({ target, text, attachments, from: dom.input.getBoundingClientRect() });
    send('say', { target, text, attachments });
    dom.input.value = '';
    historyIndex = null;
    historyDraft = '';
    autosize();
    attachments = [];
    renderAttachments();
    closeMenu();
  }

  function browseHistory(direction) {
    const saved = getHistory()
      .map((message) => String(message ?? '').trim())
      .filter(Boolean);
    const pending = localHistory.get(getTarget()) ?? [];
    let overlap = Math.min(saved.length, pending.length);
    while (overlap > 0 && !pending.slice(0, overlap)
      .every((message, index) => message === saved[saved.length - overlap + index])) {
      overlap -= 1;
    }
    const history = [...saved, ...pending.slice(overlap)];
    if (history.length === 0) return false;

    if (historyIndex === null) {
      historyIndex = history.length;
      historyDraft = dom.input.value;
    }
    historyIndex = Math.max(0, Math.min(history.length, historyIndex + direction));
    dom.input.value = historyIndex === history.length ? historyDraft : history[historyIndex];
    autosize();
    dom.input.selectionStart = dom.input.value.length;
    dom.input.selectionEnd = dom.input.value.length;
    return true;
  }

  function atHistoryEdge(direction) {
    if (dom.input.selectionStart !== dom.input.selectionEnd) return false;
    const value = dom.input.value;
    if (!value.includes('\n')) return true;
    if (direction < 0) return dom.input.selectionStart <= value.indexOf('\n');
    return dom.input.selectionStart > value.lastIndexOf('\n');
  }

  // Files travel to disk first: an agent is given a path, never bytes.
  async function attach(files) {
    for (const file of files) {
      const response = await fetch('/upload', {
        method: 'POST',
        headers: { 'x-filename': encodeURIComponent(file.name) },
        body: file,
      });
      const body = await response.json();
      if (body.ok) attachments = [...attachments, body.file];
      else showError(body.error);
    }
    renderAttachments();
  }

  function renderAttachments() {
    if (!dom.attachments) return;
    dom.attachments.replaceChildren(
      ...attachments.map((file) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.title = `${file.type} · ${Math.round(file.bytes / 1024)}KB`;
        // Baseline so a chip is always readable and removable, with or without
        // the stylesheet: the label truncates, the × never does.
        chip.style.cssText = [
          'display:inline-flex', 'align-items:center', 'gap:6px', 'max-width:280px',
          'padding:2px 6px', 'border:1px solid var(--line,#262626)', 'margin:0 4px 4px 0',
        ].join(';');

        // An image says what it is far better than its filename does.
        if (String(file.type ?? '').startsWith('image/')) {
          const thumb = document.createElement('img');
          thumb.src = `/attachment?path=${encodeURIComponent(file.path)}`;
          thumb.alt = file.name;
          thumb.style.cssText =
            'width:34px;height:34px;object-fit:cover;display:block;flex:none;'
            + 'border:1px solid var(--line,#262626)';
          chip.style.padding = '2px 6px 2px 2px';
          chip.append(thumb);
        } else {
          const label = document.createElement('span');
          label.textContent = file.name;
          label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
          chip.append(label);
        }

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'chip-x';
        remove.textContent = '×';
        remove.setAttribute('aria-label', `remove ${file.name}`);
        remove.style.cssText = [
          'flex:none', 'background:transparent', 'border:0', 'cursor:pointer',
          'color:var(--muted,#8a8a8a)', 'font:inherit', 'font-size:14px', 'line-height:1',
          'padding:0 2px',
        ].join(';');
        remove.onclick = () => {
          attachments = attachments.filter((candidate) => candidate !== file);
          renderAttachments();
        };
        chip.append(remove);
        return chip;
      }),
    );
    dom.attachments.hidden = attachments.length === 0;
  }

  function showError(message) {
    if (!dom.attachments) return;
    dom.attachments.hidden = false;
    const line = document.createElement('span');
    line.className = 'chip error';
    line.textContent = message;
    dom.attachments.append(line);
    setTimeout(() => line.remove(), 5000);
  }

  // The box grows with the text, up to a point, then scrolls. Nothing typed is
  // ever hidden behind a one-line window.
  const MAX_HEIGHT = () => Math.round(window.innerHeight * 0.35);

  function autosize() {
    if (dom.input.tagName !== 'TEXTAREA') return;
    dom.input.style.height = 'auto';
    const wanted = dom.input.scrollHeight;
    const cap = MAX_HEIGHT();
    dom.input.style.height = `${Math.min(wanted, cap)}px`;
    dom.input.style.overflowY = wanted > cap ? 'auto' : 'hidden';
  }

  dom.input.addEventListener('input', () => {
    historyIndex = null;
    historyDraft = '';
    autosize();
    const mention = activeMention(dom.input.value, dom.input.selectionStart);
    if (!mention) return closeMenu();
    fetchSuggestions(mention);
  });
  addEventListener('resize', autosize);

  dom.input.addEventListener('keydown', (event) => {
    if (suggestions.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        highlighted = (highlighted + step + suggestions.length) % suggestions.length;
        return renderMenu();
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        return accept(highlighted);
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        return closeMenu();
      }
    }
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown')
      && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const direction = event.key === 'ArrowUp' ? -1 : 1;
      if (atHistoryEdge(direction) && browseHistory(direction)) {
        event.preventDefault();
        return;
      }
    }
    // Nothing to dismiss, so Escape steps back out to the mission.
    if (event.key === 'Escape' && getTarget() !== MISSION_TARGET) {
      event.preventDefault();
      return setTarget?.(MISSION_TARGET);
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });

  // The target chip is the way back: it says who you are talking to, and
  // pressing it returns you to the mission.
  if (dom.targetChip) {
    dom.targetChip.setAttribute('role', 'button');
    dom.targetChip.setAttribute('tabindex', '0');
    dom.targetChip.title = 'Click to address the mission instead';
    dom.targetChip.style.cursor = 'pointer';
    // Clicking the chip cycles the three ways of speaking once: MISSION, then
    // POLICY, then THOR. Standing at a desk, the first click steps back out.
    const toMission = () => {
      const here = getTarget?.();
      const index = SPEAK_TARGETS.findIndex((t) => t.id === here);
      const next = index === -1
        ? MISSION_TARGET
        : SPEAK_TARGETS[(index + 1) % SPEAK_TARGETS.length].id;
      setTarget?.(next);
      dom.input.focus();
    };
    dom.targetChip.addEventListener('click', toMission);
    dom.targetChip.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toMission();
      }
    });
  }

  dom.send?.addEventListener('click', submit);
  dom.file?.addEventListener('change', () => {
    attach([...dom.file.files]);
    dom.file.value = '';
  });

  // Dropping anywhere on the window attaches, so you never have to aim.
  const stop = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  for (const type of ['dragenter', 'dragover']) {
    dropTarget.addEventListener(type, (event) => {
      stop(event);
      document.body.classList.add('dropping');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    dropTarget.addEventListener(type, (event) => {
      stop(event);
      if (type === 'dragleave' && event.relatedTarget) return;
      document.body.classList.remove('dropping');
    });
  }
  dropTarget.addEventListener('drop', (event) => {
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length > 0) attach(files);
  });

  dom.input.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length > 0) {
      event.preventDefault();
      attach(files);
    }
  });
  dom.input.addEventListener('blur', () => setTimeout(closeMenu, 120));

  return {
    // Addressing the mission shows the mission that is already set, so it can
    // be edited rather than retyped from memory. Never while you are typing:
    // a redraw must not overwrite what is in your hands.
    setTarget(target, agents, mission = '') {
      if (historyTarget !== target) {
        historyTarget = target;
        historyIndex = null;
        historyDraft = '';
      }
      if (dom.targetChip) {
        const agent = agents.find((candidate) => candidate.id === target);
        const preset = SPEAK_TARGETS.find((t) => t.id === target);
        dom.targetChip.textContent = agent
          ? `→ ${agent.label ?? agent.name}`
          : (preset?.label ?? 'MISSION');
        dom.targetChip.title = preset?.blurb ?? '';
      }
      if (!dom.input) return;
      const targetAgent = agents.find((candidate) => candidate.id === target);
      const toMission = target === MISSION_TARGET;
      dom.input.placeholder = toMission
        ? 'set the mission · @file /skill @agent'
        : target === POLICY_TARGET
          ? 'a rule every agent obeys, on every message, from now on'
          : target === ROUTE_TARGET
            ? 'say it once - Thor decides who needs to hear it'
            : `talk to ${targetAgent?.label ?? target} · @file /skill @agent`;

      const typing = document.activeElement === dom.input;
      if (typing) return;
      if (toMission) {
        // Only when the box holds nothing of yours, or the last mission we put
        // there ourselves - never clobber a draft.
        if (!dom.input.value || dom.input.value === lastMission) {
          dom.input.value = mission ?? '';
          lastMission = mission ?? '';
        }
      } else if (dom.input.value && dom.input.value === lastMission) {
        dom.input.value = ''; // that was the mission, not a steer for this agent
      }
    },
    focus() {
      dom.input.focus();
    },
    parse(text) {
      return parseMentions(text, { agentIds: agentIds() });
    },
  };
}

async function lookup(mention, agentIds) {
  if (mention.sigil === '/') {
    const { skills } = await getJson('/skills');
    return filter(skills, mention.query);
  }
  const named = filter(agentIds, mention.query);
  const { files } = await getJson(`/files?q=${encodeURIComponent(mention.query)}`);
  return [...named, ...files].slice(0, 20);
}

async function getJson(url) {
  try {
    const response = await fetch(url);
    return await response.json();
  } catch {
    return {};
  }
}

function filter(list = [], query) {
  if (!query) return list.slice(0, 8);
  const needle = query.toLowerCase();
  return list.filter((value) => value.toLowerCase().includes(needle)).slice(0, 8);
}
