import { createControlButton } from './controls.mjs';
import { renderThread } from './conversation.mjs';

export function renderEntityDetail({
  kind, source, agents = {}, events = [], onOpen, onReply, onReact, onCapacity,
}) {
  const content = el('div', 'connected-entity-content');
  const detail = kind === 'hero'
    ? heroDetail(source, onOpen, onCapacity)
    : kind === 'checkpoint'
      ? checkpointDetail(source, onOpen)
      : kind === 'decision'
        ? decisionDetail(source, agents)
        : resourceDetail(kind, source, agents);
  content.append(...detail.sections);

  const messages = kind === 'message' ? [source] : source.messages ?? [];
  if (messages.length || ['hero', 'checkpoint', 'decision'].includes(kind)) {
    const thread = el('section', 'connected-entity-thread');
    renderThread(thread, messages, { agents, events, onReply, onReact, onOpen });
    content.append(thread);
  }

  return {
    content,
    title: detail.title ?? source.label ?? source.title ?? source.name ?? source.id,
    subtitle: detail.subtitle ?? '',
    trailing: detail.trailing ?? null,
  };
}

function heroDetail(hero, onOpen, onCapacity) {
  const checkpoints = hero.checkpoints ?? [];
  const goal = hero.goal?.objective ?? hero.goal ?? 'No goal set';
  const trailing = el('div', 'connected-context-trailing');
  trailing.append(status(hero.status ?? 'idle'));
  if (onCapacity) {
    const select = document.createElement('select');
    select.setAttribute('aria-label', `${hero.label ?? hero.name} capacity`);
    for (let value = 1; value <= 4; value += 1) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = `×${value}`;
      option.selected = Number(hero.instances ?? 1) === value;
      select.append(option);
    }
    select.onchange = () => onCapacity(Number(select.value));
    trailing.append(select);
  }
  return {
    title: hero.label ?? hero.name ?? hero.id,
    subtitle: hero.role ?? '',
    trailing,
    sections: [
      copy('GOAL', goal),
      metrics([
        ['RUNNING', hero.running?.length ?? 0],
        ['QUEUED', hero.queued?.length ?? 0],
        ['DONE', hero.completed?.length ?? 0],
      ]),
      links('WORK', checkpoints, (checkpoint) => ({
        id: checkpoint.id,
        text: checkpoint.title ?? checkpoint.outcome ?? '',
        state: checkpoint.closedAt ? 'done' : checkpoint.lease?.state ?? 'queued',
        onClick: () => onOpen?.({ kind: 'checkpoint', id: checkpoint.id }),
      })),
    ],
  };
}

function checkpointDetail(checkpoint, onOpen) {
  const owner = checkpoint.owner?.label ?? checkpoint.owner?.name ?? 'Unassigned';
  const trailing = el('div', 'connected-context-trailing');
  trailing.append(status(checkpoint.status?.state ?? 'pending'), text('span', owner));
  const metadata = metrics([
    ['STAGE', checkpoint.stage ?? '—'],
    ['WORK UNIT', checkpoint.workUnitId ?? '—'],
    ['DEPENDS', checkpoint.dependencies?.length ?? 0],
  ]);
  const sections = [metadata, copy('OUTCOME', checkpoint.outcome ?? checkpoint.title)];
  if (checkpoint.plan) sections.push(copy('PLAN', checkpoint.plan));
  if (checkpoint.verify) sections.push(copy('PROOF', checkpoint.verify));
  if (checkpoint.dependencies?.length) {
    sections.push(links('DEPENDS ON', checkpoint.dependencies, (dependency) => ({
      id: dependency.id,
      text: dependency.title ?? dependency.outcome ?? '',
      state: dependency.closedAt ? 'done' : dependency.lease?.state ?? 'queued',
      onClick: () => onOpen?.({ kind: 'checkpoint', id: dependency.id }),
    })));
  }
  return {
    title: `${checkpoint.id} · ${checkpoint.title ?? checkpoint.outcome ?? ''}`,
    subtitle: checkpoint.stage ?? '',
    trailing,
    sections,
  };
}

function decisionDetail(decision, agents) {
  const hero = agents[decision.agentId]?.label ?? decision.agentId ?? 'MINIMAC';
  const trailing = el('div', 'connected-context-trailing');
  trailing.append(status(decision.resolved ? 'resolved' : 'open'), text('span', hero));
  return {
    title: decision.title ?? decision.summary ?? 'Decision',
    subtitle: hero,
    trailing,
    sections: [copy('NEEDS YOU', decision.reason ?? decision.summary ?? decision.detail)],
  };
}

function resourceDetail(kind, source, agents) {
  if (kind === 'message') {
    return {
      title: `Message from ${agents[source.authorId]?.label ?? source.authorId}`,
      subtitle: `${source.context.kind}:${source.context.id}`,
      sections: [],
    };
  }
  const resource = document.createElement('pre');
  resource.className = 'connected-resource';
  resource.textContent = source.content ?? '';
  return { title: source.label ?? source.id, subtitle: kind, sections: [resource] };
}

function metrics(values) {
  const row = el('dl', 'connected-entity-facts');
  for (const [label, value] of values) {
    const item = el('div');
    item.append(text('dt', label), text('dd', String(value)));
    row.append(item);
  }
  return row;
}

function copy(label, value) {
  const section = el('section', 'connected-copy');
  section.append(text('h3', label), text('p', value ?? '—'));
  return section;
}

function links(label, items, project) {
  const section = el('section', 'connected-links');
  section.append(text('h3', label));
  const list = el('div', 'connected-work-list');
  for (const item of items) {
    const value = project(item);
    const button = createControlButton('', { variant: 'quiet' });
    button.classList.add('connected-work-row');
    button.append(text('b', value.id), text('span', value.text), text('small', value.state));
    button.onclick = value.onClick;
    list.append(button);
  }
  if (!items.length) list.append(text('p', 'conversation-empty', 'No related work.'));
  section.append(list);
  return section;
}

function status(value) {
  const node = el('span', 'connected-status');
  node.dataset.state = String(value).toLowerCase();
  node.append(el('i'), text('span', String(value).toUpperCase()));
  return node;
}

function text(tag, className, value) {
  if (value === undefined) return text(tag, '', className);
  const node = el(tag, className);
  node.textContent = value;
  return node;
}

function el(tag, className = '', value = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value) node.textContent = value;
  return node;
}
