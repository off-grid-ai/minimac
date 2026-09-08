// Worker instances are the runtime source of truth. An Avenger is a seat and
// role; each worker owns one engine conversation. The work board owns active
// checkpoint leases. Seat fields are read-only compatibility projections.

export const WORKER_STATE = Object.freeze({
  IDLE: 'idle',
  STARTING: 'starting',
  RUNNING: 'running',
  BLOCKED: 'blocked',
  STOPPING: 'stopping',
  STALE: 'stale',
  FAILED: 'failed',
  STOPPED: 'stopped',
});

const TRANSITIONS = Object.freeze({
  [WORKER_STATE.IDLE]: new Set([WORKER_STATE.STARTING, WORKER_STATE.STOPPED]),
  [WORKER_STATE.STARTING]: new Set([WORKER_STATE.RUNNING, WORKER_STATE.FAILED, WORKER_STATE.STOPPING]),
  [WORKER_STATE.RUNNING]: new Set([WORKER_STATE.BLOCKED, WORKER_STATE.STOPPING, WORKER_STATE.STALE, WORKER_STATE.FAILED]),
  [WORKER_STATE.BLOCKED]: new Set([WORKER_STATE.RUNNING, WORKER_STATE.STOPPING, WORKER_STATE.STALE, WORKER_STATE.FAILED]),
  [WORKER_STATE.STOPPING]: new Set([WORKER_STATE.STOPPED, WORKER_STATE.FAILED]),
  [WORKER_STATE.STALE]: new Set([WORKER_STATE.STARTING, WORKER_STATE.STOPPED]),
  [WORKER_STATE.FAILED]: new Set([WORKER_STATE.STARTING, WORKER_STATE.STOPPED]),
  [WORKER_STATE.STOPPED]: new Set([WORKER_STATE.STARTING, WORKER_STATE.IDLE]),
});

export function transitionWorker(worker, state, changes = {}, now = Date.now()) {
  if (!Object.values(WORKER_STATE).includes(state)) {
    return { worker, error: `unknown worker state ${state}` };
  }
  if (worker.state !== state && !TRANSITIONS[worker.state]?.has(state)) {
    return { worker, error: `${worker.id} cannot move from ${worker.state} to ${state}` };
  }
  return {
    worker: {
      ...worker,
      ...changes,
      state,
      stateChangedAt: worker.state === state ? worker.stateChangedAt : now,
    },
  };
}

export function workerHealth(
  worker,
  { engineState = null, heartbeatAt = worker?.heartbeatAt, now = Date.now(), staleAfterMs = 120_000 } = {},
) {
  if (!worker) return { state: WORKER_STATE.FAILED, reason: 'worker does not exist' };
  if (['failed', 'error'].includes(engineState)) {
    return { state: WORKER_STATE.FAILED, reason: 'engine session failed' };
  }
  if (['stopped', 'closed'].includes(engineState)) {
    return { state: WORKER_STATE.STOPPED, reason: 'engine session stopped' };
  }
  if (worker.sessionId && Number.isFinite(heartbeatAt) && now - heartbeatAt > staleAfterMs) {
    return { state: WORKER_STATE.STALE, reason: 'engine heartbeat expired' };
  }
  return { state: worker.state, reason: null };
}

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
    heartbeatAt: saved.heartbeatAt ?? saved.startedAt ?? null,
    stateChangedAt: saved.stateChangedAt ?? saved.startedAt ?? null,
    failureReason: saved.failureReason ?? null,
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
  const priority = [
    WORKER_STATE.FAILED, WORKER_STATE.STALE, WORKER_STATE.BLOCKED,
    WORKER_STATE.STOPPING, WORKER_STATE.STARTING, WORKER_STATE.RUNNING,
  ];
  const activeState = priority.find((state) => workers.some((worker) => worker.state === state));
  const status = activeState
    ?? (live.length > 0 ? WORKER_STATE.RUNNING
      : agent.enabled === false
        ? WORKER_STATE.STOPPED
        : WORKER_STATE.IDLE);
  return {
    ...agent,
    workers,
    sessionId: live[0]?.sessionId ?? null,
    sessionIds: live.map((worker) => worker.sessionId),
    resumeSessionId: workers.find((worker) => worker.resumeSessionId)?.resumeSessionId ?? null,
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
