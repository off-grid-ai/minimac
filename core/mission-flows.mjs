// Mission Flows are a projection of the checkpoint board, never a second
// progress record. Checkpoints own the outcome, scope, gates, evidence, and
// lifecycle. This module only changes that canonical model into the quieter
// user-journey view used by the Flow panel. A row is a work unit, and its
// children are the canonical checkpoints that deliver it.

import {
  isDone,
  itemsOf,
  stateOf,
  ITEM_STATE,
} from './board.mjs';
import { GATE_STATE } from './flows.mjs';

const WIRED_GATES = new Set(['wiring', 'lint', 'test', 'commits', 'push']);

function deliveryStatus(board, item) {
  if (isDone(item)) return 'verified';
  const gates = Object.entries(item.gates ?? {});
  if (gates.some(([, value]) => value === GATE_STATE.FAIL)) return 'blocked';
  const checkpoint = stateOf(board, item);
  if ([ITEM_STATE.BLOCKED, ITEM_STATE.PAUSED].includes(checkpoint)) return 'blocked';
  if (gates.some(([gate, value]) => WIRED_GATES.has(gate) && value === GATE_STATE.PASS)) {
    return 'wired';
  }
  if (gates.some(([gate, value]) => gate === 'coding' && value === GATE_STATE.PASS)) {
    return 'coded';
  }
  if (item.lease?.state === 'running'
    || gates.some(([, value]) => value === GATE_STATE.RUNNING)) return 'running';
  return 'pending';
}

export function projectMissionFlows(board, now = Date.now()) {
  const checkpoints = itemsOf(board)
    .filter((item) => !['cancelled', 'superseded'].includes(item.disposition));
  return (board?.workUnits ?? []).map((workUnit, workUnitIndex) => {
    const stages = checkpoints.filter((item) => item.workUnitId === workUnit.id);
    const failed = stages.find((item) =>
      Object.values(item.gates ?? {}).includes(GATE_STATE.FAIL));
    const current = stages.find((item) => !isDone(item));
    const status = failed
      ? 'blocked'
      : current
        ? deliveryStatus(board, current)
        : stages.length > 0
          ? 'verified'
          : 'pending';
    return {
      id: workUnit.id,
      workUnitId: workUnit.id,
      displayId: `W${workUnitIndex + 1}`,
      title: workUnit.title,
      user_visible_result: workUnit.outcome || workUnit.title,
      scope: workUnit.scope,
      status,
      estimateMs: stages.reduce((sum, item) => sum + (item.estimateMs ?? 0), 0),
      actualMs: stages.reduce((sum, item) => sum + (item.closedAt
        ? Math.max(0, item.closedAt - item.createdAt)
        : item.lease?.startedAt
          ? Math.max(0, now - item.lease.startedAt)
          : 0), 0),
      checkpoints: stages.map((item) => {
        const siblings = stages.filter((candidate) => candidate.stage === item.stage);
        const part = siblings.length > 1 ? `.${siblings.indexOf(item) + 1}` : '';
        return {
          id: item.id,
          displayId: `${String(item.stage ?? '').toUpperCase()}${workUnitIndex + 1}${part}`,
          stage: item.stage,
          owner: item.owner,
          status: deliveryStatus(board, item),
        };
      }),
    };
  });
}
