import {
  addItem,
  advance,
  closeItem,
  findItem,
} from '../core/board.mjs';
import { createEvent, EVENT_KINDS } from '../core/events.mjs';
import { ROLES } from '../core/roster.mjs';
import { ORDER_ACTION } from '../core/coordination.mjs';

// Application boundary for checkpoint writes. The HTTP server wires
// storage and delivery into this service; it does not own these use cases.
export function createWorkBoard({
  getBoard,
  setBoard,
  getAgents,
  saveItem,
  emit,
  order,
  onChange = () => {},
  workerLimitMs,
}) {
  function add(spec, by) {
    if (!spec?.title) return { error: 'an item needs a title' };
    for (const field of ['plan', 'outcome', 'verify']) {
      if (!String(spec[field] ?? '').trim()) return { error: `an item needs ${field}` };
    }
    if (!Number.isFinite(spec.estimateMs) || spec.estimateMs > workerLimitMs) {
      return { error: `an item must finish within ${workerLimitMs}ms` };
    }

    const agents = getAgents();
    const owner = agents[spec.owner] ? spec.owner : null;
    const result = addItem(getBoard(), { ...spec, owner });
    if (result.error) return result;

    let board = result.board;
    if (spec.replaces) {
      const closed = closeItem(board, spec.replaces, 'superseded', result.item.id);
      if (closed.error) return { ...closed, board: getBoard() };
      board = closed.board;
    }

    setBoard(board);
    if (spec.replaces) {
      for (const item of board.items) saveItem(item);
    } else {
      saveItem(result.item);
    }
    if (result.duplicate) return { ...result, board };

    emit(createEvent(by, EVENT_KINDS.STATUS, {
      text: `${result.item.id}: ${result.item.title}`
        + (owner ? ` → ${agents[owner].label ?? owner}` : ' (nobody yet)'),
      from: 'you',
    }));
    if (owner) {
      order(
        owner,
        `${result.item.id}: ${result.item.title}`,
        ORDER_ACTION.ASSIGN,
        result.item.id,
      );
    }
    onChange();
    return { ...result, board };
  }

  function updateCheckpoint(agentId, move, workerId = null) {
    const agent = getAgents()[agentId];
    const current = getBoard();
    const target = findItem(current, move?.item);
    if (workerId && (
      target?.lease?.state !== 'running'
      || target.lease.workerId !== workerId
      || target.lease.agentId !== agentId
    )) {
      const error = `${move?.item} is not leased to ${workerId}`;
      emit(createEvent(agentId, EVENT_KINDS.STATUS, {
        text: `gate refused: ${error}`,
        from: 'you',
      }));
      return { board: current, error };
    }
    const result = advance(current, {
      id: move?.item,
      gate: move?.gate,
      state: move?.state,
      receipt: move?.receipt ?? '',
      by: agentId,
      evidenceBy: workerId ?? agentId,
      canManage: agent?.role === ROLES.ORCHESTRATOR,
    });
    if (result.error) {
      emit(createEvent(agentId, EVENT_KINDS.STATUS, {
        text: `gate refused: ${result.error}`,
        from: 'you',
      }));
      return result;
    }
    setBoard(result.board);
    const item = findItem(result.board, move.item);
    if (!result.duplicate) {
      saveItem(item);
      emit(createEvent(agentId, EVENT_KINDS.STATUS, {
        text: `${move.item} ${move.gate}: ${move.state}`,
        from: 'you',
        checkpointId: move.item,
        gate: move.gate,
        gateState: move.state,
      }));
      onChange();
    }
    return { ...result, item };
  }

  return Object.freeze({ add, updateCheckpoint });
}
