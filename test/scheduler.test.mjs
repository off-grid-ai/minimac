import test from 'node:test';
import assert from 'node:assert/strict';

import { createBoard, createItem } from '../core/board.mjs';
import { readyCheckpoints, whyNotRunnable } from '../core/scheduler.mjs';

function item(id, files, blockedBy = []) {
  return createItem({
    id, title: id, plan: 'do it', outcome: 'it works', verify: 'prove it', owner: 'coder',
    needs: ['coding'], files, blockedBy, estimateMs: 60_000,
  });
}

test('independent files can run in parallel and overlapping files wait', () => {
  const board = createBoard();
  const active = item('w1.cw', ['core/session']);
  active.lease = { state: 'running' };
  board.items = [active, item('w2.cw', ['ui/panels.mjs']), item('w3.cw', ['core/session/index.mjs'])];
  assert.deepEqual(readyCheckpoints(board, 'coder', { capacity: 3 }).map((row) => row.id), ['w2.cw']);
  assert.equal(whyNotRunnable(board, board.items[2], 'coder'), 'waiting for files held by w1.cw');
});

test('a stage reports the prior stage that blocks it', () => {
  const board = createBoard();
  board.items = [item('w1.pw', []), item('w1.cw', [], ['w1.pw'])];
  assert.equal(whyNotRunnable(board, board.items[1], 'coder'), 'waiting for w1.pw');
});
