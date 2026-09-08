import { isDone, stateOf } from './board.mjs';
import { ROLES } from './roster.mjs';

export const STAGE_ORDER = Object.freeze(['pw', 'dw', 'cw', 'tw', 'aw', 'rw']);

export const STAGE_ROLE = Object.freeze({
  pw: ROLES.PRODUCT,
  dw: ROLES.UX,
  cw: ROLES.CODER,
  tw: ROLES.TESTER,
  aw: ROLES.AUDITOR,
  rw: ROLES.REVIEWER,
});

export const STAGE_GATES = Object.freeze({
  pw: Object.freeze(['product']),
  dw: Object.freeze(['design']),
  cw: Object.freeze(['coding', 'wiring', 'lint', 'commits']),
  tw: Object.freeze(['test']),
  aw: Object.freeze(['audit']),
  rw: Object.freeze(['review']),
});

export const WORK_UNIT_STATE = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  BLOCKED: 'blocked',
  FAILED: 'failed',
  DONE: 'done',
});

export function stageCheckpointId(workUnitId, stage) {
  return `${workUnitId}.${stage}`;
}

export function createWorkUnit(spec, now = Date.now()) {
  return {
    id: String(spec.id ?? '').trim(),
    title: String(spec.title ?? '').trim(),
    outcome: String(spec.outcome ?? '').trim(),
    scope: String(spec.scope ?? '').trim(),
    blockedBy: [...(spec.blockedBy ?? [])],
    stages: STAGE_ORDER.filter((stage) => spec.stages?.some(
      (candidate) => candidate.stage === stage && candidate.required !== false,
    )),
    createdAt: now,
  };
}

export function validateWorkPlan(specs, agents, workerLimitMs) {
  if (!Array.isArray(specs) || specs.length === 0) return { error: 'assemble needs work units' };
  const ids = new Set();
  for (const spec of specs) {
    if (!spec?.id || !spec.title || !spec.outcome || !spec.scope) {
      return { error: 'every work unit needs id, title, outcome, and scope' };
    }
    if (ids.has(spec.id)) return { error: `duplicate work unit ${spec.id}` };
    ids.add(spec.id);
    const required = (spec.stages ?? []).filter((stage) => stage.required !== false);
    if (required.length === 0) return { error: `${spec.id} needs at least one required stage` };
    for (const stage of required) {
      if (!STAGE_ORDER.includes(stage.stage)) return { error: `${spec.id} has unknown stage ${stage.stage}` };
      if (!stage.plan || !stage.verify) return { error: `${spec.id}.${stage.stage} needs plan and verify` };
      if (!Number.isFinite(stage.estimateMs) || stage.estimateMs <= 0 || stage.estimateMs > workerLimitMs) {
        return { error: `${spec.id}.${stage.stage} must finish within ${workerLimitMs}ms` };
      }
      const owner = Object.values(agents).find(
        (agent) => agent.id === stage.owner && agent.role === STAGE_ROLE[stage.stage],
      );
      if (!owner) return { error: `${spec.id}.${stage.stage} needs a ${STAGE_ROLE[stage.stage]} owner` };
    }
  }
  for (const spec of specs) {
    const unknown = (spec.blockedBy ?? []).find((id) => !ids.has(id));
    if (unknown) return { error: `${spec.id} depends on unknown work unit ${unknown}` };
    if ((spec.blockedBy ?? []).includes(spec.id)) return { error: `${spec.id} cannot depend on itself` };
  }
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  function cyclic(id) {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if ((byId.get(id)?.blockedBy ?? []).some(cyclic)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  if (specs.some((spec) => cyclic(spec.id))) return { error: 'work-unit dependencies contain a cycle' };
  return { workUnits: specs.map((spec) => createWorkUnit(spec)) };
}

export function expandWorkUnit(spec, workUnits, now = Date.now()) {
  const required = STAGE_ORDER
    .map((stage) => spec.stages.find((candidate) => candidate.stage === stage))
    .filter((stage) => stage && stage.required !== false);
  const dependencyEnds = (spec.blockedBy ?? []).map((id) => {
    const dependency = workUnits.find((candidate) => candidate.id === id);
    const finalStage = dependency?.stages?.at(-1);
    return finalStage ? stageCheckpointId(id, finalStage) : null;
  }).filter(Boolean);
  return required.map((stage, index) => ({
    id: stageCheckpointId(spec.id, stage.stage),
    workUnitId: spec.id,
    stage: stage.stage,
    title: `${spec.title} · ${stage.stage.toUpperCase()}`,
    plan: String(stage.plan).trim(),
    outcome: spec.outcome,
    verify: String(stage.verify).trim(),
    scope: spec.scope,
    files: [...(stage.files ?? [])],
    owner: stage.owner,
    needs: [...STAGE_GATES[stage.stage]],
    blockedBy: index === 0
      ? dependencyEnds
      : [stageCheckpointId(spec.id, required[index - 1].stage)],
    estimateMs: stage.estimateMs,
    required: true,
    createdAt: now,
  }));
}

export function workUnitState(board, workUnit) {
  const stages = (board.items ?? []).filter((item) => item.workUnitId === workUnit.id);
  if (stages.length > 0 && stages.every(isDone)) return WORK_UNIT_STATE.DONE;
  if (stages.some((item) => Object.values(item.gates ?? {}).includes('fail'))) {
    return WORK_UNIT_STATE.FAILED;
  }
  if (stages.some((item) => stateOf(board, item) === 'working')) return WORK_UNIT_STATE.RUNNING;
  if (stages.some((item) => stateOf(board, item) === 'blocked')) return WORK_UNIT_STATE.BLOCKED;
  return WORK_UNIT_STATE.PENDING;
}

export function releaseReady(board) {
  const workUnits = board.workUnits ?? [];
  return workUnits.length > 0 && workUnits.every((workUnit) => {
    const finalId = stageCheckpointId(workUnit.id, workUnit.stages.at(-1));
    const final = (board.items ?? []).find((item) => item.id === finalId);
    return Boolean(final && isDone(final));
  });
}
