// The identity and closed state of floor speech bubbles.
//
// Pure. Events, errands and decisions keep ownership of their identifiers;
// this module only gives those identifiers one namespace and one dismissal
// rule. The browser adapter decides where the serialized state is stored.

const PREFIX = Object.freeze({
  EVENT: 'event',
  ERRAND: 'errand',
  DECISION: 'decision',
});

export function eventBubbleKey(event) {
  const id = event?.payload?.message?.id ?? event?.payload?.id ?? event?.ts;
  if (!event?.agentId || !event?.kind || id == null) return null;
  return `${PREFIX.EVENT}:${event.agentId}:${event.kind}:${id}`;
}

export function errandBubbleKey(errand) {
  if (!errand?.key || errand?.queuedAt == null) return null;
  return `${PREFIX.ERRAND}:${errand.key}:${errand.queuedAt}`;
}

export function decisionBubbleKey(decision) {
  const id = decision?.key ?? decision?.id;
  return id == null ? null : `${PREFIX.DECISION}:${id}`;
}

export function restoreDismissed(serialized) {
  try {
    const keys = JSON.parse(serialized ?? '[]');
    return new Set(Array.isArray(keys) ? keys.filter((key) => typeof key === 'string') : []);
  } catch {
    return new Set();
  }
}

export function serializeDismissed(dismissed) {
  return JSON.stringify([...dismissed]);
}

export function dismiss(dismissed, keys) {
  const next = new Set(dismissed);
  for (const key of keys) if (key) next.add(key);
  return next;
}

export function isDismissed(dismissed, key) {
  return Boolean(key && dismissed.has(key));
}
