import test from 'node:test';
import assert from 'node:assert/strict';

import {
  expandWorkUnit,
  releaseReady,
  stageCheckpointId,
  validateWorkPlan,
} from '../core/work-units.mjs';
import { createBoard, createItem } from '../core/board.mjs';
import { DEFAULT_ROSTER, createRoster } from '../core/roster.mjs';

const agents = createRoster(DEFAULT_ROSTER);
const stage = (name, owner) => ({
  stage: name,
  owner,
  required: true,
  plan: `complete ${name}`,
  verify: `verify ${name}`,
  estimateMs: 60_000,
});

test('a work plan expands role stages in sequence while work units remain parallel', () => {
  const specs = [
    { id: 'w1', title: 'First outcome', outcome: 'first works', scope: 'core/first', blockedBy: [],
      stages: [stage('pw', 'pm'), stage('cw', 'coder'), stage('tw', 'tester')] },
    { id: 'w2', title: 'Second outcome', outcome: 'second works', scope: 'core/second', blockedBy: [],
      stages: [stage('pw', 'pm'), stage('cw', 'coder')] },
  ];
  const result = validateWorkPlan(specs, agents, 480_000);
  assert.equal(result.error, undefined);
  const first = expandWorkUnit(specs[0], result.workUnits);
  const second = expandWorkUnit(specs[1], result.workUnits);
  assert.deepEqual(first.map((item) => item.id), ['w1.pw', 'w1.cw', 'w1.tw']);
  assert.deepEqual(first.map((item) => item.blockedBy), [[], ['w1.pw'], ['w1.cw']]);
  assert.deepEqual(second[0].blockedBy, []);
});

test('cross-work-unit dependencies wait for the final required stage', () => {
  const specs = [
    { id: 'w1', title: 'Foundation', outcome: 'foundation works', scope: 'core', blockedBy: [],
      stages: [stage('cw', 'coder'), stage('rw', 'reviewer')] },
    { id: 'w2', title: 'Consumer', outcome: 'consumer works', scope: 'ui', blockedBy: ['w1'],
      stages: [stage('dw', 'ux'), stage('cw', 'coder')] },
  ];
  const { workUnits } = validateWorkPlan(specs, agents, 480_000);
  const items = expandWorkUnit(specs[1], workUnits);
  assert.deepEqual(items[0].blockedBy, ['w1.rw']);
});

test('invalid roles, oversized stages, and cycles are rejected before dispatch', () => {
  const base = { id: 'w1', title: 'Outcome', outcome: 'works', scope: 'core', blockedBy: [] };
  assert.match(validateWorkPlan([{ ...base, stages: [stage('cw', 'ux')] }], agents, 480_000).error, /coder owner/);
  assert.match(validateWorkPlan([{ ...base, stages: [{ ...stage('cw', 'coder'), estimateMs: 480_001 }] }], agents, 480_000).error, /finish within/);
  const cyclic = [
    { ...base, blockedBy: ['w2'], stages: [stage('cw', 'coder')] },
    { ...base, id: 'w2', blockedBy: ['w1'], stages: [stage('cw', 'coder')] },
  ];
  assert.match(validateWorkPlan(cyclic, agents, 480_000).error, /cycle/);
});

test('release waits for every final stage receipt', () => {
  const board = createBoard();
  board.workUnits = [{ id: 'w1', stages: ['cw', 'rw'] }];
  board.items = [createItem({ id: stageCheckpointId('w1', 'rw'), title: 'Review', needs: ['review'] })];
  assert.equal(releaseReady(board), false);
  board.items[0].gates.review = 'pass';
  assert.equal(releaseReady(board), true);
});
