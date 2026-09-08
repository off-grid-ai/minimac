import { readyCheckpoints } from '../core/scheduler.mjs';
import { freeWorkers } from '../core/workers.mjs';
import { ROLES } from '../core/roster.mjs';

export function createScheduler({ getBoard, getAgents, start, limitMs }) {
  let reconciling = false;

  async function reconcile() {
    if (reconciling) return [];
    reconciling = true;
    const started = [];
    try {
      for (const agent of Object.values(getAgents())) {
        if (agent.role === ROLES.ORCHESTRATOR || agent.enabled === false) continue;
        const ready = readyCheckpoints(getBoard(), agent.id, {
          limitMs,
          capacity: freeWorkers(agent).length,
        });
        if (ready.length === 0) continue;
        await start(agent.id, ready.map((item) => item.id));
        started.push(...ready.map((item) => item.id));
      }
      return started;
    } finally {
      reconciling = false;
    }
  }

  return Object.freeze({ reconcile });
}
