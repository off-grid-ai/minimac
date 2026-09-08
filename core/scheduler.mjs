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
  return readinessOf(board, item, agentId).detail;
}

export function readinessOf(board, item, agentId, now = Date.now()) {
  if (!item) return { ready: false, reason: 'missing', detail: 'checkpoint does not exist' };
  if (item.owner !== agentId) return { ready: false, reason: 'waiting for worker', detail: `assigned to ${item.owner ?? 'nobody'}` };
  if (item.paused) return { ready: false, reason: 'paused', detail: 'paused' };
  if (Number.isFinite(item.retryAt) && item.retryAt > now) {
    return { ready: false, reason: 'retry delay', detail: `retry after ${new Date(item.retryAt).toISOString()}` };
  }
  const dependency = (item.blockedBy ?? []).find((id) => {
    const candidate = board.items.find((other) => other.id === id);
    return candidate && Object.values(candidate.gates ?? {}).some((state) => state !== 'pass');
  });
  if (dependency) return { ready: false, reason: 'waiting for dependency', detail: `waiting for ${dependency}` };
  const conflict = conflictsWithActiveWork(board, item);
  if (conflict) return { ready: false, reason: 'file conflict', detail: `waiting for files held by ${conflict.id}` };
  if (item.lease?.state === 'running') return { ready: false, reason: 'running', detail: 'already running' };
  if (!item.plan || !item.outcome || !item.verify) {
    return { ready: false, reason: 'invalid', detail: 'checkpoint instructions are incomplete' };
  }
  return { ready: true, reason: null, detail: null };
}

// The board is the source of truth for work readiness. Worker projections do
// not decide whether a checkpoint is active or ready.
export function readyCheckpoints(board, agentId, { limitMs, capacity = 1 } = {}) {
  const limit = Number.isFinite(limitMs) ? limitMs : Number.POSITIVE_INFINITY;
  const count = Math.max(0, Number(capacity) || 0);
  return itemsFor(board, agentId)
    .filter((item) => canWork(board, item, agentId))
    .filter((item) => readinessOf(board, item, agentId).ready)
    .filter((item) => Number.isFinite(item.estimateMs) && item.estimateMs <= limit)
    .sort(compareQueueOrder)
    .slice(0, count);
}

export function recoveryCandidates(board, workers, now = Date.now(), staleAfterMs = 120_000) {
  const byId = new Map((workers ?? []).map((worker) => [worker.id, worker]));
  return (board?.items ?? []).filter((item) => {
    if (item.lease?.state !== 'running') return false;
    const worker = byId.get(item.lease.workerId);
    if (!worker || ['failed', 'stale', 'stopped'].includes(worker.state)) return true;
    const heartbeat = worker.heartbeatAt ?? worker.startedAt;
    return Number.isFinite(heartbeat) && now - heartbeat >= staleAfterMs;
  });
}
