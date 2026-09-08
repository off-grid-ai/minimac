// One native control boundary for compact operator actions. A CDN component
// can register before or after first render, so selecting the element type at
// runtime produced two visual systems on the same surface.

function available(name) {
  return Boolean(globalThis.customElements?.get(name));
}

export function createControlButton(text, { size = 'small' } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `control-button is-${size}`;
  button.textContent = text;
  return button;
}

export function createRelativeTime(value) {
  const date = new Date(value);
  if (available('wa-relative-time')) {
    const time = document.createElement('wa-relative-time');
    time.setAttribute('date', date.toISOString());
    time.setAttribute('format', 'narrow');
    time.setAttribute('sync', '');
    return time;
  }
  const time = document.createElement('time');
  time.className = 'relative-time-fallback';
  time.dateTime = date.toISOString();
  time.textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return time;
}

export function createDisclosure(summaryText) {
  if (available('wa-details')) {
    const details = document.createElement('wa-details');
    details.setAttribute('summary', summaryText);
    return details;
  }
  const details = document.createElement('details');
  details.className = 'control-details-fallback';
  const summary = document.createElement('summary');
  summary.textContent = summaryText;
  details.append(summary);
  return details;
}
