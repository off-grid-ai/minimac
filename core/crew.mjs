import { canWork } from './board.mjs';
import { isActive, ROLES } from './roster.mjs';

function wanted(agent, desired) {
  return desired
    ? desired[agent.id] === true || Number(desired[agent.id]) > 0
    : agent.enabled !== false;
}

export function activationPlan(agents, board, desired = null) {
  const workers = Object.values(agents).filter((agent) => agent.role !== ROLES.ORCHESTRATOR);
  const selected = workers.filter((agent) => wanted(agent, desired));
  const readyOwners = new Set(board.items
    .filter((item) => item.owner
      && selected.some((agent) => agent.id === item.owner)
      && canWork(board, item, item.owner))
    .map((item) => item.owner));

  return workers.map((agent) => ({
    agentId: agent.id,
    member: wanted(agent, desired),
    running: isActive(agent),
    shouldRun: wanted(agent, desired) && readyOwners.has(agent.id),
  }));
}
