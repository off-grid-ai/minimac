import { GATES, GATE_STATE } from './flows.mjs';
import { itemsOf } from './board.mjs';

export const ACCEPTANCE_STATE = Object.freeze({
  NOT_RUN: 'not run',
  RUNNING: 'running',
  PASSED: 'passed',
  FAILED: 'failed',
  NOT_REQUIRED: 'not required',
});

export function createAcceptancePolicy(spec = {}, now = Date.now()) {
  const required = [...new Set(spec.required ?? [
    'coding', 'wiring', 'lint', 'test', 'audit', 'review', 'commits', 'prepush', 'push',
  ])];
  return { required, createdAt: spec.createdAt ?? now, updatedAt: now };
}

export function validateAcceptancePolicy(policy) {
  if (!policy || !Array.isArray(policy.required)) return { error: 'acceptance needs required gates' };
  const unknown = policy.required.find((gate) => !GATES.includes(gate));
  if (unknown) return { error: `unknown acceptance gate ${unknown}` };
  if (policy.required.includes('push') && !policy.required.includes('prepush')) {
    return { error: 'push requires prepush' };
  }
  return { policy: createAcceptancePolicy(policy) };
}

export function acceptanceState(policy, board) {
  const required = new Set(policy?.required ?? []);
  return Object.fromEntries(GATES.map((gate) => {
    if (!required.has(gate)) return [gate, ACCEPTANCE_STATE.NOT_REQUIRED];
    const checkpoints = itemsOf(board)
      .filter((item) => !['cancelled', 'superseded'].includes(item.disposition))
      .filter((item) => item.gates?.[gate] !== undefined);
    if (checkpoints.some((item) => item.gates[gate] === GATE_STATE.FAIL)) {
      return [gate, ACCEPTANCE_STATE.FAILED];
    }
    if (checkpoints.length > 0 && checkpoints.every((item) => item.gates[gate] === GATE_STATE.PASS)) {
      return [gate, ACCEPTANCE_STATE.PASSED];
    }
    if (checkpoints.some((item) => item.gates[gate] === GATE_STATE.RUNNING)) {
      return [gate, ACCEPTANCE_STATE.RUNNING];
    }
    return [gate, ACCEPTANCE_STATE.NOT_RUN];
  }));
}

export function missionIsComplete(policy, board) {
  const states = acceptanceState(policy, board);
  return (policy?.required ?? []).every((gate) => states[gate] === ACCEPTANCE_STATE.PASSED);
}

export function reconcileAcceptanceChange(previous, next, board, now = Date.now()) {
  const before = new Set(previous?.required ?? []);
  const after = new Set(next?.required ?? []);
  const removed = [...before].filter((gate) => !after.has(gate));
  if (removed.length === 0) return { board, removed };
  return {
    board: {
      ...board,
      items: itemsOf(board).map((item) => {
        if (!item.gates || !Object.keys(item.gates).every((gate) => removed.includes(gate))) return item;
        return {
          ...item,
          disposition: 'cancelled',
          paused: false,
          lease: null,
          closedAt: now,
        };
      }),
    },
    removed,
  };
}
