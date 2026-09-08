import { createControlButton } from './controls.mjs';

export function createContextPanel({ host, onClose }) {
  const panel = document.createElement('section');
  panel.className = 'connected-context';
  panel.hidden = true;
  const bar = document.createElement('header');
  bar.className = 'connected-context-bar';
  const back = createControlButton('BACK');
  const identity = document.createElement('div');
  identity.className = 'connected-context-identity';
  back.onclick = () => closeEntity();
  bar.append(back, identity);
  const body = document.createElement('div');
  body.className = 'connected-context-body';
  panel.append(bar, body);
  host.append(panel);

  function openEntity({ kind, id, title = '', subtitle = '', content }) {
    identity.replaceChildren(label(kind.toUpperCase()), label(title || id), label(subtitle));
    body.replaceChildren(content);
    panel.hidden = false;
  }

  function closeEntity() {
    panel.hidden = true;
    body.replaceChildren();
    onClose?.();
  }

  return Object.freeze({ openEntity, closeEntity, element: panel });
}

function label(value) {
  const span = document.createElement('span');
  span.textContent = value;
  return span;
}
