import { canWork, compareQueueOrder, itemsFor } from './board.mjs';

// The board is the source of truth for work readiness. Worker projections do
// not decide whether a checkpoint is active or ready.
export function readyCheckpoints(board, agentId, { limitMs, capacity = 1 } = {}) {
  const limit = Number.isFinite(limitMs) ? limitMs : Number.POSITIVE_INFINITY;
  const count = Math.max(0, Number(capacity) || 0);
  return itemsFor(board, agentId)
    .filter((item) => canWork(board, item, agentId))
    .filter((item) => item.lease?.state !== 'running')
    .filter((item) => item.plan && item.outcome && item.verify)
    .filter((item) => Number.isFinite(item.estimateMs) && item.estimateMs <= limit)
    .sort(compareQueueOrder)
    .slice(0, count);
}
