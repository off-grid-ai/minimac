import { EVENT_KINDS } from './events.mjs';
import { ensureWorkers, patchWorker, WORKER_STATE } from './workers.mjs';

function mergeFlows(existing, incoming) {
  return incoming.map((step, index) => {
    const previous = step?.id
      ? existing.find((candidate) => candidate?.id === step.id)
      : existing[index];
    return {
      ...step,
      estimateMs: previous?.estimateMs ?? step.estimateMs ?? null,
      actualMs: step.actualMs ?? previous?.actualMs ?? 0,
    };
  });
}

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

    let projected = next;
    if (event.kind === EVENT_KINDS.STATUS && event.payload.state) {
      const ended = [WORKER_STATE.IDLE, WORKER_STATE.STOPPED].includes(event.payload.state);
      projected = patchWorker(next, workerId, {
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
    if (event.kind === EVENT_KINDS.PLAN) {
      projected.flows = mergeFlows(agent.flows, event.payload.steps ?? []);
    }
    if (event.kind === EVENT_KINDS.DIFF) {
      projected.diffLines = event.payload.lines ?? agent.diffLines;
    }
    return { ...agents, [event.agentId]: projected };
  }

  // Seat-level facts are valid without a worker. Runtime state is not: only a
  // worker event can change sessions or worker lifecycle.
  if (event.kind === EVENT_KINDS.PLAN) {
    next.flows = mergeFlows(agent.flows, event.payload.steps ?? []);
  }
  if (event.kind === EVENT_KINDS.DIFF) next.diffLines = event.payload.lines ?? agent.diffLines;
  if (event.kind === EVENT_KINDS.BLOCKED) next.blockedReason = event.payload.reason ?? null;
  return { ...agents, [event.agentId]: next };
}
