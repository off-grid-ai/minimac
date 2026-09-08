import { EVENT_KINDS } from './events.mjs';
import { CONTEXT_KIND, reactionsForMessage, threadSummary } from './conversation.mjs';
import { isCrosstalkEvent } from './coordination.mjs';

export const DETAIL_LEVELS = Object.freeze([
  { id: 'summary', label: 'summary' }, { id: 'detailed', label: 'detailed' },
  { id: 'verbose', label: 'verbose' },
]);
export const ACTIVITY_FILTERS = Object.freeze([
  { id: 'all', label: 'all' }, { id: 'crosstalk', label: 'crosstalk' },
  { id: 'signal', label: 'signal' }, { id: 'evidence', label: 'evidence' },
]);

const SUMMARY = new Set([
  EVENT_KINDS.CONVERSATION_MESSAGE, EVENT_KINDS.ORDER, EVENT_KINDS.ESCALATION,
  EVENT_KINDS.CLAIM, EVENT_KINDS.BLOCKED, EVENT_KINDS.APPROVAL, EVENT_KINDS.RESULT,
]);
const DETAILED = new Set([...SUMMARY, EVENT_KINDS.PING, EVENT_KINDS.LEASE, EVENT_KINDS.DELIVERY]);
const SIGNAL = new Set([
  EVENT_KINDS.ORDER, EVENT_KINDS.ESCALATION, EVENT_KINDS.BLOCKED,
  EVENT_KINDS.APPROVAL, EVENT_KINDS.RESULT, EVENT_KINDS.LEASE,
]);

export function alwaysVisible(event) {
  return event?.kind === EVENT_KINDS.BLOCKED
    || (event?.kind === EVENT_KINDS.APPROVAL && !event.payload?.resolved)
    || (event?.kind === EVENT_KINDS.ESCALATION && event.payload?.state === 'open');
}

export function visibilityOf(event) {
  if (SUMMARY.has(event?.kind)) return 'summary';
  if (DETAILED.has(event?.kind)) return 'detailed';
  return 'verbose';
}

export function activityForScope(events, { kind = CONTEXT_KIND.MISSION, id } = {}) {
  if (kind === CONTEXT_KIND.MISSION) return [...events];
  return events.filter((event) => {
    const context = event.payload?.message?.context ?? event.payload?.context;
    return (context?.kind === kind && context?.id === id)
      || (kind === CONTEXT_KIND.CHECKPOINT && event.payload?.checkpointId === id)
      || (kind === CONTEXT_KIND.DECISION && (event.payload?.id === id || event.payload?.approvalId === id));
  });
}

export function applyActivityFilters(events, {
  detail = 'summary', type = 'all', heroId = null, checkpointId = null,
  workUnitId = null, stage = null, query = '', board = [],
} = {}) {
  const rank = { summary: 0, detailed: 1, verbose: 2 };
  return events.filter((event) => {
    if (!alwaysVisible(event) && rank[visibilityOf(event)] > rank[detail]) return false;
    const message = event.payload?.message;
    if (heroId && event.agentId !== heroId && message?.authorId !== heroId
      && !message?.recipients?.includes(heroId)
      && !message?.references?.some((reference) => reference.kind === 'hero' && reference.id === heroId)) return false;
    const checkpoint = event.payload?.checkpointId
      ?? (message?.context?.kind === CONTEXT_KIND.CHECKPOINT ? message.context.id : null);
    const item = board.find((candidate) => candidate.id === checkpoint);
    if (checkpointId && checkpoint !== checkpointId) return false;
    if (workUnitId && item?.workUnitId !== workUnitId
      && !message?.references?.some((reference) => reference.kind === 'work-unit' && reference.id === workUnitId)) return false;
    if (stage && item?.stage !== stage) return false;
    if (type === 'crosstalk' && !isCrosstalkEvent(event)) return false;
    if (type === 'signal' && !SIGNAL.has(event.kind) && !isCrosstalkEvent(event)) return false;
    if (type === 'evidence' && ![EVENT_KINDS.CLAIM, EVENT_KINDS.RESULT].includes(event.kind)) return false;
    const needle = query.trim().toLowerCase();
    return !needle || JSON.stringify(event.payload ?? {}).toLowerCase().includes(needle);
  });
}

export function missionNarrative({ events = [], missionId, board = [], filters = {} }) {
  const visible = applyActivityFilters(events, { ...filters, board });
  const messages = visible
    .filter((event) => event.kind === EVENT_KINDS.CONVERSATION_MESSAGE
      && event.payload?.message?.context?.kind === CONTEXT_KIND.MISSION
      && event.payload.message.context.id === String(missionId))
    .map((event) => ({ kind: 'message', id: event.payload.message.id,
      at: event.payload.message.createdAt, message: event.payload.message,
      reactions: reactionsForMessage(events, event.payload.message.id) }));
  const milestones = visible
    .filter((event) => ![EVENT_KINDS.CONVERSATION_MESSAGE, EVENT_KINDS.ENGINE_OUTPUT].includes(event.kind))
    .map((event) => ({ kind: 'event', id: `${event.agentId}:${event.ts}:${event.kind}`, at: event.ts, event }));
  return [...messages, ...milestones].sort((left, right) => left.at - right.at);
}

export function checkpointThreadSummary(events, id) {
  return threadSummary(events, { kind: CONTEXT_KIND.CHECKPOINT, id });
}
