// Worker instances are the runtime source of truth. An Avenger is a seat and
// role; each worker owns one engine conversation. The work board owns active
// checkpoint leases. Seat fields are read-only compatibility projections.

export const WORKER_STATE = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  BLOCKED: 'blocked',
  EXPIRED: 'expired',
  STOPPED: 'stopped',
});

export function workerId(agentId, index) {
  return `${agentId}:${index + 1}`;
}

export function createWorker(agentId, index, saved = {}) {
  return {
    id: saved.id ?? workerId(agentId, index),
    agentId,
    sessionId: saved.sessionId ?? null,
    resumeSessionId: saved.resumeSessionId ?? null,
    checkpointId: saved.checkpointId ?? null,
    engine: saved.engine ?? null,
    state: saved.state ?? WORKER_STATE.IDLE,
    startedAt: saved.startedAt ?? null,
  };
}

export function ensureWorkers(agent) {
  const existing = agent?.workers ?? [];
  const wanted = Math.max(1, Number(agent?.instances) || 1);
  // Lowering capacity must not discard a live or resumable conversation.
  const count = Math.max(wanted, existing.length);
  return Array.from({ length: count }, (_, index) =>
    createWorker(agent.id, index, existing.find((worker) => worker.id === workerId(agent.id, index))));
}

export function projectWorkers(agent, workers = ensureWorkers(agent)) {
  const live = workers.filter((worker) => Boolean(worker.sessionId));
  const status = live.some((worker) => worker.state === WORKER_STATE.BLOCKED)
    ? WORKER_STATE.BLOCKED
    : live.length > 0
      ? WORKER_STATE.RUNNING
      : agent.enabled === false
        ? WORKER_STATE.STOPPED
        : WORKER_STATE.IDLE;
  return {
    ...agent,
    workers,
    sessionId: live[0]?.sessionId ?? null,
    sessionIds: live.map((worker) => worker.sessionId),
    resumeSessionId: workers.find((worker) => worker.resumeSessionId)?.resumeSessionId ?? null,
    workItemIds: live.map((worker) => worker.checkpointId).filter(Boolean),
    status,
  };
}

export function patchWorker(agent, id, changes) {
  const workers = ensureWorkers(agent).map((worker) =>
    worker.id === id ? { ...worker, ...changes } : worker);
  return projectWorkers(agent, workers);
}

export function workerForSession(agent, sessionId) {
  return ensureWorkers(agent).find((worker) =>
    worker.sessionId === sessionId || worker.resumeSessionId === sessionId) ?? null;
}

export function workerForCheckpoint(agent, checkpointId) {
  return ensureWorkers(agent).find((worker) => worker.checkpointId === checkpointId) ?? null;
}

export function freeWorkers(agent) {
  const capacity = Math.max(1, Number(agent?.instances) || 1);
  return ensureWorkers(agent).slice(0, capacity).filter((worker) => !worker.sessionId);
}

export function hydrateWorker(row) {
  return createWorker(row.agent_id, Number(String(row.worker_id).split(':').at(-1)) - 1, {
    id: row.worker_id,
    agentId: row.agent_id,
    sessionId: null,
    resumeSessionId: row.session_id,
    checkpointId: row.checkpoint_id,
    engine: row.engine,
    state: row.state ?? WORKER_STATE.IDLE,
    startedAt: row.started_at,
  });
}
