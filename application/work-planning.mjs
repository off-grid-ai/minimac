import { addItem, createBoard, isClosed } from '../core/board.mjs';
import {
  createReleaseCheckpoints,
  expandWorkUnit,
  validateWorkPlan,
} from '../core/work-units.mjs';

// One transaction publishes a plan. A partial plan is never visible and no
// stage exists without its parent work unit.
export function createWorkPlanningService({
  getBoard,
  setBoard,
  getAgents,
  saveWorkPlan,
  getAcceptance = () => null,
  workerLimitMs,
}) {
  function buildWorkPlan(specs) {
    const validated = validateWorkPlan(specs, getAgents(), workerLimitMs);
    if (validated.error) return validated;
    const board = createBoard();
    board.workUnits = validated.workUnits;
    for (const spec of specs) {
      for (const checkpoint of expandWorkUnit(spec, validated.workUnits)) {
        const added = addItem(board, checkpoint);
        if (added.error) return added;
        board.items = added.board.items;
      }
    }
    for (const checkpoint of createReleaseCheckpoints(board.workUnits, getAgents(), getAcceptance())) {
      const added = addItem(board, checkpoint);
      if (added.error) return added;
      board.items = added.board.items;
    }
    return { board, workUnits: board.workUnits, checkpoints: board.items };
  }

  function reconcileWorkPlan(candidate, current = getBoard()) {
    const prior = new Map((current?.items ?? []).map((item) => [item.id, item]));
    const candidateIds = new Set(candidate.items.map((item) => item.id));
    const items = candidate.items.map((item) => {
      const old = prior.get(item.id);
      if (!old) return item;
      const sameContract = ['workUnitId', 'stage', 'title', 'plan', 'outcome', 'verify', 'scope', 'owner']
        .every((field) => JSON.stringify(old[field] ?? null) === JSON.stringify(item[field] ?? null))
        && JSON.stringify(old.files ?? []) === JSON.stringify(item.files ?? [])
        && JSON.stringify(Object.keys(old.gates ?? {})) === JSON.stringify(Object.keys(item.gates ?? {}));
      return sameContract ? { ...item, ...old, blockedBy: item.blockedBy } : item;
    });
    for (const old of current?.items ?? []) {
      if (candidateIds.has(old.id) || isClosed(old)) continue;
      items.push({
        ...old,
        disposition: 'cancelled',
        paused: false,
        lease: null,
        closedAt: Date.now(),
      });
    }
    return { ...candidate, items };
  }

  function publishWorkPlan(specs) {
    const mode = (getBoard()?.workUnits ?? []).length > 0 ? 'regroup' : 'initial';
    const built = buildWorkPlan(specs);
    if (built.error) return built;
    const board = reconcileWorkPlan(built.board);
    setBoard(board);
    saveWorkPlan(board);
    return { board, workUnits: board.workUnits, checkpoints: board.items, mode };
  }

  return Object.freeze({ buildWorkPlan, reconcileWorkPlan, publishWorkPlan });
}
