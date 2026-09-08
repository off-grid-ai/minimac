import { createControlButton } from './controls.mjs';

export function createContextPanel({ host, onClose }) {
  const stack = [];
  const panel = document.createElement('section');
  panel.className = 'connected-context';
  panel.hidden = true;
  const bar = document.createElement('header');
  bar.className = 'connected-context-bar';
  const back = createControlButton('‹', { variant: 'quiet' });
  back.classList.add('is-icon');
  back.setAttribute('aria-label', 'Back');
  const identity = document.createElement('div');
  identity.className = 'connected-context-identity';
  const trailing = document.createElement('div');
  trailing.className = 'connected-context-actions';
  back.onclick = () => closeEntity();
  bar.append(back, identity, trailing);
  const body = document.createElement('div');
  body.className = 'connected-context-body';
  panel.append(bar, body);
  host.append(panel);

  function paint({ kind, id, title = '', subtitle = '', content, trailing: actions = null }) {
    identity.replaceChildren(label(title || id), label(subtitle));
    trailing.replaceChildren(...(actions ? [actions] : []));
    body.replaceChildren(content);
    panel.hidden = false;
  }

  function openEntity(entity, { replace = false } = {}) {
    const current = stack.at(-1);
    if (replace && current) stack[stack.length - 1] = entity;
    else if (current?.kind === entity.kind && current?.id === entity.id) stack[stack.length - 1] = entity;
    else stack.push(entity);
    paint(stack.at(-1));
  }

  function closeEntity() {
    if (stack.length > 1) {
      stack.pop();
      paint(stack.at(-1));
      return;
    }
    stack.length = 0;
    panel.hidden = true;
    body.replaceChildren();
    onClose?.();
  }

  function reset() {
    stack.length = 0;
    panel.hidden = true;
    body.replaceChildren();
  }

  return Object.freeze({
    openEntity,
    replaceEntity(entity) { openEntity(entity, { replace: true }); },
    closeEntity,
    reset,
    current() { return stack.at(-1) ? { kind: stack.at(-1).kind, id: stack.at(-1).id } : null; },
    element: panel,
  });
}

function label(value) {
  const span = document.createElement('span');
  span.textContent = value;
  return span;
}
