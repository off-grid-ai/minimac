import { canWork, compareQueueOrder, itemsFor } from './board.mjs';

function overlaps(left, right) {
  const a = String(left).replace(/^\.\//, '').replace(/\/$/, '');
  const b = String(right).replace(/^\.\//, '').replace(/\/$/, '');
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function conflictsWithActiveWork(board, item) {
  if (!(item?.files?.length > 0)) return null;
  return (board?.items ?? []).find((candidate) =>
    candidate.id !== item.id
    && candidate.lease?.state === 'running'
    && (candidate.files ?? []).some((active) => item.files.some((wanted) => overlaps(active, wanted))),
  ) ?? null;
}

export function whyNotRunnable(board, item, agentId) {
  if (!item) return 'checkpoint does not exist';
  if (item.owner !== agentId) return `assigned to ${item.owner ?? 'nobody'}`;
  if (item.paused) return 'paused';
  const dependency = (item.blockedBy ?? []).find((id) => {
    const candidate = board.items.find((other) => other.id === id);
    return candidate && Object.values(candidate.gates ?? {}).some((state) => state !== 'pass');
  });
  if (dependency) return `waiting for ${dependency}`;
  const conflict = conflictsWithActiveWork(board, item);
  if (conflict) return `waiting for files held by ${conflict.id}`;
  if (item.lease?.state === 'running') return 'already running';
  if (!item.plan || !item.outcome || !item.verify) return 'checkpoint instructions are incomplete';
  return null;
}

// The board is the source of truth for work readiness. Worker projections do
// not decide whether a checkpoint is active or ready.
export function readyCheckpoints(board, agentId, { limitMs, capacity = 1 } = {}) {
  const limit = Number.isFinite(limitMs) ? limitMs : Number.POSITIVE_INFINITY;
  const count = Math.max(0, Number(capacity) || 0);
  return itemsFor(board, agentId)
    .filter((item) => canWork(board, item, agentId))
    .filter((item) => !conflictsWithActiveWork(board, item))
    .filter((item) => item.lease?.state !== 'running')
    .filter((item) => item.plan && item.outcome && item.verify)
    .filter((item) => Number.isFinite(item.estimateMs) && item.estimateMs <= limit)
    .sort(compareQueueOrder)
    .slice(0, count);
}
