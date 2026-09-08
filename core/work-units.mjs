import { createItem, findItem, isClosed, isDone, stateOf } from './board.mjs';
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

export function createReleaseCheckpoints(workUnits, agents, acceptance = null, now = Date.now()) {
  const tester = Object.values(agents).find((agent) => agent.role === ROLES.TESTER)?.id ?? null;
  const coder = Object.values(agents).find((agent) => agent.role === ROLES.CODER)?.id ?? null;
  const finalStages = workUnits.map((workUnit) =>
    stageCheckpointId(workUnit.id, workUnit.stages.at(-1)));
  const required = new Set(acceptance?.required ?? ['prepush', 'push']);
  return [
    {
      id: 'release.prepush', title: 'Prove the complete mission before push',
      plan: 'Run the repository pre-push contract against the integrated work.',
      outcome: 'The complete integrated mission passes its pre-push contract.',
      verify: 'Run the repository pre-push command and record its result.',
      scope: 'release', owner: tester, needs: ['prepush'], blockedBy: finalStages,
      estimateMs: 480_000, files: [], createdAt: now,
    },
    {
      id: 'release.push', title: 'Publish the verified mission to GitHub',
      plan: 'Push the verified commits to the configured GitHub remote.',
      outcome: 'The verified mission is available on GitHub.',
      verify: 'Record the pushed branch and remote revision.',
      scope: 'release', owner: coder, needs: ['push'],
      blockedBy: required.has('prepush') ? ['release.prepush'] : finalStages,
      estimateMs: 240_000, files: [], createdAt: now,
    },
  ].filter((item) => item.needs.some((gate) => required.has(gate)));
}

export function reconcileReleaseCheckpoints(board, agents, acceptance, now = Date.now()) {
  const expected = createReleaseCheckpoints(board?.workUnits ?? [], agents, acceptance, now);
  const expectedById = new Map(expected.map((item) => [item.id, item]));
  const seen = new Set();
  const items = (board?.items ?? []).map((item) => {
    if (!item.id.startsWith('release.')) return item;
    const spec = expectedById.get(item.id);
    if (!spec) {
      return isClosed(item) ? item : {
        ...item, disposition: 'cancelled', lease: null, paused: false, closedAt: now,
      };
    }
    seen.add(item.id);
    if (isClosed(item) && item.disposition !== 'active') return createItem(spec, now);
    return { ...item, blockedBy: spec.blockedBy, owner: spec.owner };
  });
  for (const spec of expected) {
    if (!seen.has(spec.id)) items.push(createItem(spec, now));
  }
  return { ...board, items };
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

function findingKey(value) {
  return String(value ?? 'failure')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || 'failure';
}

// A failed verification stage creates coding work. The failed checkpoint
// stays authoritative and runs again only after each correction passes.
export function createRemediationWork(board, sourceId, findings, agents, now = Date.now()) {
  const source = findItem(board, sourceId);
  if (!source) return { board, error: `no item ${sourceId}` };
  if (!['tw', 'aw', 'rw'].includes(source.stage) && source.id !== 'release.prepush') {
    return { board, error: `${sourceId} is not a verification checkpoint` };
  }
  const coder = Object.values(agents).find(
    (agent) => agent.role === ROLES.CODER && agent.enabled !== false,
  ) ?? Object.values(agents).find((agent) => agent.role === ROLES.CODER);
  if (!coder) return { board, error: 'no coder can own remediation work' };

  const entries = Array.isArray(findings) && findings.length
    ? findings
    : [{ id: 'reported-failure', title: source.title, receipt: '' }];
  const workUnits = [...(board.workUnits ?? [])];
  const items = [...(board.items ?? [])];
  const created = [];
  const correctionIds = [];

  for (const [index, finding] of entries.entries()) {
    const unitId = `${source.workUnitId ?? source.id}.repair-${findingKey(finding.id ?? index + 1)}`
      + `-a${Math.max(1, Number(source.attempt) || 1)}`;
    const checkpointId = stageCheckpointId(unitId, 'cw');
    correctionIds.push(checkpointId);
    if (workUnits.some((unit) => unit.id === unitId)) continue;
    const title = String(finding.title ?? `Fix failure found by ${source.id}`).trim();
    const outcome = String(
      finding.outcome ?? `The failure found by ${source.id} is fixed and ready to verify again.`,
    ).trim();
    workUnits.push(createWorkUnit({
      id: unitId,
      title,
      outcome,
      scope: finding.scope ?? source.scope,
      blockedBy: [],
      stages: [{ stage: 'cw', required: true }],
    }, now + index));
    const checkpoint = createItem({
      id: checkpointId,
      workUnitId: unitId,
      stage: 'cw',
      title: `${title} · CW`,
      plan: `Fix the verified failure. Use this evidence: ${finding.receipt || 'the failed checkpoint receipt'}`,
      outcome,
      verify: `Run the focused proof, then return ${source.id} to ${source.owner} for verification.`,
      scope: finding.scope ?? source.scope,
      files: finding.files ?? source.files ?? [],
      owner: coder.id,
      needs: STAGE_GATES.cw,
      blockedBy: source.blockedBy ?? [],
      estimateMs: Math.min(480_000, source.estimateMs ?? 480_000),
    }, now + index);
    checkpoint.remediationFor = source.id;
    checkpoint.findingId = finding.id ?? `finding-${index + 1}`;
    items.push(checkpoint);
    created.push(checkpoint);
  }

  const nextItems = items.map((item) => item.id === source.id
    ? { ...item, blockedBy: [...new Set([...(item.blockedBy ?? []), ...correctionIds])] }
    : item);
  return { board: { ...board, workUnits, items: nextItems }, sourceId, created };
}

export function splitCheckpoint(board, id, parts, now = Date.now()) {
  const source = findItem(board, id);
  if (!source) return { board, error: `no item ${id}` };
  if (isClosed(source)) return { board, error: `${id} is already closed` };
  if (!Array.isArray(parts) || parts.length < 2) return { board, error: 'a split needs at least two parts' };
  const ids = new Set((board.items ?? []).map((item) => item.id));
  for (const part of parts) {
    if (!part.id || ids.has(part.id)) return { board, error: `split id is missing or already used: ${part.id ?? ''}` };
    if (!part.title || !part.plan || !part.outcome || !part.verify) {
      return { board, error: 'every split part needs title, plan, outcome, and verify' };
    }
    ids.add(part.id);
  }
  const created = parts.map((part, index) => createItem({
    ...source,
    ...part,
    id: part.id,
    needs: Object.keys(source.gates ?? {}),
    blockedBy: index === 0 ? source.blockedBy : [parts[index - 1].id],
    lease: null,
  }, now + index));
  const replacementId = created.at(-1).id;
  const retired = {
    ...source,
    disposition: 'superseded',
    replacedBy: replacementId,
    paused: false,
    lease: null,
    closedAt: now,
  };
  const items = (board.items ?? []).map((item) => {
    if (item.id === id) return retired;
    if (!(item.blockedBy ?? []).includes(id)) return item;
    return { ...item, blockedBy: item.blockedBy.map((dependency) => dependency === id ? replacementId : dependency) };
  });
  return { board: { ...board, items: [...items, ...created] }, item: retired, parts: created };
}
