import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorkPlanningService } from '../application/work-planning.mjs';
import { createBoard } from '../core/board.mjs';
import { createRoster, DEFAULT_ROSTER } from '../core/roster.mjs';

const stage = (name, owner) => ({
  stage: name, owner, required: true, plan: `do ${name}`, verify: `prove ${name}`,
  estimateMs: 60_000,
});

test('publishing a plan exposes no partial state and saves parents with stages', () => {
  let board = createBoard();
  let saved = null;
  const service = createWorkPlanningService({
    getBoard: () => board,
    setBoard: (next) => { board = next; },
    getAgents: () => createRoster(DEFAULT_ROSTER),
    saveWorkPlan: (next) => { saved = next; },
    workerLimitMs: 480_000,
  });
  const result = service.publishInitialPlan([{
    id: 'w1', title: 'Ship outcome', outcome: 'outcome works', scope: 'core', blockedBy: [],
    stages: [stage('pw', 'pm'), stage('cw', 'coder'), stage('rw', 'reviewer')],
  }]);
  assert.equal(result.error, undefined);
  assert.deepEqual(board.workUnits.map((unit) => unit.id), ['w1']);
  assert.deepEqual(board.items.map((item) => item.id), ['w1.pw', 'w1.cw', 'w1.rw']);
  assert.equal(saved, board);

  const before = board;
  const refused = service.publishInitialPlan([{
    id: 'bad', title: 'Bad', outcome: 'bad', scope: 'core', blockedBy: [],
    stages: [stage('cw', 'ux')],
  }]);
  assert.match(refused.error, /coder owner/);
  assert.equal(board, before);
});
