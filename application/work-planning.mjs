import { addItem, createBoard } from '../core/board.mjs';
import { expandWorkUnit, validateWorkPlan } from '../core/work-units.mjs';

// One transaction publishes a plan. A partial plan is never visible and no
// stage exists without its parent work unit.
export function createWorkPlanningService({
  getBoard,
  setBoard,
  getAgents,
  saveWorkPlan,
  workerLimitMs,
}) {
  function publishInitialPlan(specs) {
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
    setBoard(board);
    saveWorkPlan(board);
    return { board, workUnits: board.workUnits, checkpoints: board.items };
  }

  return Object.freeze({ publishInitialPlan });
}
