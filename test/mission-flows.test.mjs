import test from 'node:test';
import assert from 'node:assert/strict';

import { createBoard, createItem } from '../core/board.mjs';
import { projectMissionFlows } from '../core/mission-flows.mjs';

test('Flows projects one work unit with links to its checkpoint chain', () => {
  const board = createBoard();
  board.workUnits = [{
    id: 'w1', title: 'Connected work', outcome: 'The work is connected', scope: 'minimac/ui',
    stages: ['dw', 'cw'],
  }];
  board.items = [
    createItem({ id: 'w1.dw', workUnitId: 'w1', stage: 'dw', title: 'Design', needs: ['design'], owner: 'ux' }),
    createItem({ id: 'w1.cw', workUnitId: 'w1', stage: 'cw', title: 'Build', needs: ['coding'], owner: 'coder' }),
  ];

  const [flow] = projectMissionFlows(board, 1_000);
  assert.equal(flow.id, 'w1');
  assert.equal(flow.title, 'Connected work');
  assert.deepEqual(flow.checkpoints.map((checkpoint) => checkpoint.id), ['w1.dw', 'w1.cw']);
  assert.equal(flow.checkpoints[0].owner, 'ux');
  assert.equal(flow.status, 'pending');
});
