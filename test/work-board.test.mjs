import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorkBoard } from '../application/work-board.mjs';
import { createBoard, createItem } from '../core/board.mjs';

test('a replaced worker cannot report against another worker lease', () => {
  let board = createBoard();
  const item = createItem({
    id: 'w1.cw', title: 'Code', plan: 'code', outcome: 'works', verify: 'test',
    owner: 'coder', needs: ['coding'], estimateMs: 60_000,
  });
  item.lease = { state: 'running', agentId: 'coder', workerId: 'coder:2' };
  board.items = [item];
  const events = [];
  const service = createWorkBoard({
    getBoard: () => board,
    setBoard: (next) => { board = next; },
    getAgents: () => ({ coder: { id: 'coder', role: 'coder' } }),
    saveItem: () => {}, emit: (event) => events.push(event), order: () => {},
    workerLimitMs: 480_000,
  });

  const result = service.updateCheckpoint('coder', {
    item: 'w1.cw', gate: 'coding', state: 'pass', receipt: 'test passed',
  }, 'coder:1');
  assert.match(result.error, /not leased/);
  assert.equal(board.items[0].gates.coding, 'pending');
  assert.equal(events.length, 1);
});
