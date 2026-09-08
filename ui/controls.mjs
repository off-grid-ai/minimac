// Accessible controls with an optional Web Awesome presentation layer.
// Native HTML is the complete fallback, so a blocked CDN never removes an
// action, a timestamp, or a disclosure from the product.

function available(name) {
  return Boolean(globalThis.customElements?.get(name));
}

export function createControlButton(text, { size = 'small' } = {}) {
  if (available('wa-button')) {
    const button = document.createElement('wa-button');
    button.setAttribute('appearance', 'plain');
    button.setAttribute('size', size);
    button.textContent = text;
    return button;
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'control-fallback';
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
