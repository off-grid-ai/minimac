// Mission Flows are a projection of the checkpoint board, never a second
// progress record. Checkpoints own the outcome, scope, gates, evidence, and
// lifecycle. This module only changes that canonical model into the quieter
// user-journey view used by the Flow panel.

import {
  compareQueueOrder,
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
  return itemsOf(board)
    .filter((item) => !['cancelled', 'superseded'].includes(item.disposition))
    .sort(compareQueueOrder)
    .map((item) => ({
      id: item.id,
      checkpointId: item.id,
      step: item.title,
      user_visible_result: item.outcome || item.title,
      scope: item.scope,
      status: deliveryStatus(board, item),
      estimateMs: item.estimateMs,
      actualMs: item.closedAt
        ? Math.max(0, item.closedAt - item.createdAt)
        : item.lease?.startedAt
          ? Math.max(0, now - item.lease.startedAt)
          : 0,
      evidence: item.evidence,
    }));
}
