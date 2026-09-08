import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorkPlanningService } from '../application/work-planning.mjs';
import { createBoard } from '../core/board.mjs';
import { createRoster, DEFAULT_ROSTER } from '../core/roster.mjs';

const stage = (name, owner) => ({
  stage: name, owner, required: true, plan: `do ${name}`, verify: `prove ${name}`,
  estimateMs: 60_000,
});

test('publishing and regrouping expose no partial state and save parents with stages', () => {
  let board = createBoard();
  let saved = null;
  const service = createWorkPlanningService({
    getBoard: () => board,
    setBoard: (next) => { board = next; },
    getAgents: () => createRoster(DEFAULT_ROSTER),
    saveWorkPlan: (next) => { saved = next; },
    workerLimitMs: 480_000,
  });
  const result = service.publishWorkPlan([{
    id: 'w1', title: 'Ship outcome', outcome: 'outcome works', scope: 'core', blockedBy: [],
    stages: [stage('pw', 'pm'), stage('cw', 'coder'), stage('rw', 'reviewer')],
  }]);
  assert.equal(result.error, undefined);
  assert.deepEqual(board.workUnits.map((unit) => unit.id), ['w1']);
  assert.deepEqual(board.items.map((item) => item.id), [
    'w1.pw', 'w1.cw', 'w1.rw', 'release.prepush', 'release.push',
  ]);
  assert.deepEqual(board.items.find((item) => item.id === 'release.prepush').blockedBy, ['w1.rw']);
  assert.equal(saved, board);

  const regrouped = service.publishWorkPlan([{
    id: 'w2', title: 'Another', outcome: 'another', scope: 'core', blockedBy: [],
    stages: [stage('cw', 'coder')],
  }]);
  assert.equal(regrouped.error, undefined);
  assert.equal(regrouped.mode, 'regroup');
  assert.deepEqual(board.workUnits.map((unit) => unit.id), ['w2']);
  assert.equal(board.items.find((item) => item.id === 'w1.cw').disposition, 'cancelled');
  assert.equal(saved, board);

  board = createBoard();
  const before = board;
  const refused = service.publishWorkPlan([{
    id: 'bad', title: 'Bad', outcome: 'bad', scope: 'core', blockedBy: [],
    stages: [stage('cw', 'ux')],
  }]);
  assert.match(refused.error, /coder owner/);
  assert.equal(board, before);
});
