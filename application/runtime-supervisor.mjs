import { recoveryCandidates } from '../core/scheduler.mjs';
import { ensureWorkers, workerHealth, WORKER_STATE } from '../core/workers.mjs';

// One application service turns engine and heartbeat observations into stale
// work recovery. It does not infer liveness from repository or file changes.
export function createRuntimeSupervisor({
  getBoard,
  getAgents,
  markStale,
  recover,
  inspect = async () => null,
  staleAfterMs = 120_000,
  now = Date.now,
}) {
  let reconciling = false;

  async function reconcileWorkers() {
    if (reconciling) return [];
    reconciling = true;
    const stale = [];
    try {
      const workers = Object.values(getAgents()).flatMap(ensureWorkers);
      const recovery = recoveryCandidates(getBoard(), workers, now(), staleAfterMs);
      const candidates = new Map(recovery
        .filter((item) => item.lease?.workerId)
        .map((item) => [item.lease.workerId, item]));
      const knownWorkers = new Set(workers.map((worker) => worker.id));
      for (const item of recovery) {
        const workerId = item.lease?.workerId;
        if (!workerId || knownWorkers.has(workerId)) continue;
        await markStale(
          item.lease.agentId ?? item.owner,
          workerId,
          'worker session no longer exists',
          WORKER_STATE.STALE,
        );
        stale.push(workerId);
      }
      for (const worker of workers) {
        const observed = worker.sessionId ? await inspect(worker).catch(() => null) : null;
        const health = workerHealth(worker, {
          engineState: observed?.state ?? null,
          now: now(),
          staleAfterMs,
        });
        const terminal = [WORKER_STATE.STALE, WORKER_STATE.FAILED, WORKER_STATE.STOPPED]
          .includes(health.state);
        const changed = health.state !== worker.state;
        if ((!terminal || !changed) && !candidates.has(worker.id)) continue;
        await markStale(
          worker.agentId,
          worker.id,
          health.reason ?? 'engine session is stale',
          health.state,
        );
        stale.push(worker.id);
      }
      if (stale.length > 0) await recover();
      return stale;
    } finally {
      reconciling = false;
    }
  }

  return Object.freeze({ reconcileWorkers });
}
