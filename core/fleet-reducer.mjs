import { EVENT_KINDS } from './events.mjs';
import { ensureWorkers, patchWorker, WORKER_STATE } from './workers.mjs';

export function applyFleetEvent(agents, event) {
  const agent = agents[event.agentId];
  if (!agent) return agents;
  const next = { ...agent, lastEventTs: event.ts };
  const workerId = event.payload?.workerId;

  if (workerId) {
    const worker = ensureWorkers(next).find((candidate) => candidate.id === workerId);
    if (!worker) return agents;
    const eventSessionId = event.payload?.sessionId;
    const knownSessionId = worker.sessionId ?? worker.resumeSessionId;
    if (knownSessionId && eventSessionId && knownSessionId !== eventSessionId) return agents;
    const eventEngine = event.payload?.engine ?? null;
    const expectedEngine = worker.engine ?? agent.engine;
    if (eventEngine && expectedEngine && eventEngine !== expectedEngine) return agents;

    // The runtime event can arrive before startWorkers() returns. Bind the
    // worker to its engine before persistence sees that first session event.
    // A worker-session row is one fact and must never be half populated.
    let projected = patchWorker(next, workerId, {
      engine: eventEngine ?? expectedEngine ?? null,
    });
    if (event.kind === EVENT_KINDS.STATUS && event.payload.state) {
      const ended = [WORKER_STATE.IDLE, WORKER_STATE.STOPPED].includes(event.payload.state);
      projected = patchWorker(projected, workerId, {
        state: event.payload.state,
        sessionId: ended ? null : eventSessionId,
        resumeSessionId: ended ? eventSessionId ?? worker.resumeSessionId : null,
        leaseStartedAt: ended ? null : worker.leaseStartedAt,
        leaseExpiresAt: ended ? null : worker.leaseExpiresAt,
      });
    }
    if (event.kind === EVENT_KINDS.BLOCKED) {
      projected = patchWorker(projected, workerId, { state: WORKER_STATE.BLOCKED });
      projected.blockedReason = event.payload.reason ?? null;
    }
    if (event.kind === EVENT_KINDS.DIFF) {
      projected.diffLines = event.payload.lines ?? agent.diffLines;
    }
    return { ...agents, [event.agentId]: projected };
  }

  // Seat-level facts are valid without a worker. Runtime state is not: only a
  // worker event can change sessions or worker lifecycle.
  if (event.kind === EVENT_KINDS.DIFF) next.diffLines = event.payload.lines ?? agent.diffLines;
  if (event.kind === EVENT_KINDS.BLOCKED) next.blockedReason = event.payload.reason ?? null;
  return { ...agents, [event.agentId]: next };
}
