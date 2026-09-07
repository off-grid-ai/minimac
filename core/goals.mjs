// Goal ownership. One canonical store for the orchestrator and every worker.
// Codex models goals natively; Claude does not. Keeping the truth here gives
// both engines the same behaviour and keeps the UI engine-agnostic.

import { ROLES } from './roster.mjs';

export const GOAL_STATUS = Object.freeze({
  ACTIVE: 'active',
  PAUSED: 'paused',
  BLOCKED: 'blocked',
  USAGE_LIMITED: 'usageLimited',
  BUDGET_LIMITED: 'budgetLimited',
  COMPLETE: 'complete',
});

export const GOAL_SOURCE = Object.freeze({ DERIVED: 'derived', MANUAL: 'manual' });

export function createGoal(objective, tokenBudget = null, status = GOAL_STATUS.ACTIVE) {
  return { objective, tokenBudget, status, source: GOAL_SOURCE.MANUAL, updatedAt: Date.now() };
}

export function setGoal(goals, agentId, objective, tokenBudget, status, source = GOAL_SOURCE.MANUAL) {
  const previous = goals[agentId];
  return {
    ...goals,
    [agentId]: {
      objective: objective ?? previous?.objective ?? '',
      tokenBudget: tokenBudget ?? previous?.tokenBudget ?? null,
      status: status ?? previous?.status ?? GOAL_STATUS.ACTIVE,
      source,
      updatedAt: Date.now(),
    },
  };
}

export function getGoal(goals, agentId) {
  return goals[agentId] ?? null;
}

export function clearGoal(goals, agentId) {
  const next = { ...goals };
  delete next[agentId];
  return next;
}

export function isGoalRunnable(goal) {
  return !!goal && goal.status === GOAL_STATUS.ACTIVE;
}

// A worker with no goal is the drift condition this whole tool exists to
// prevent, so the mission is decomposed into one goal per role the moment it
// is set. These are the floor, not the ceiling: the orchestrator may replace
// any of them later through the same setGoal path.
// A goal says what THIS role is for. It does not repeat the mission: the
// mission is in the header, in every dispatch, and identical for everyone -
// quoting it made all six goals read the same for their first four lines.
const ROLE_OBJECTIVES = Object.freeze({
  [ROLES.PRODUCT]:
    'Turn the mission into a flow contract: the steps, in the order a person '
    + 'experiences them, each with an acceptance criterion. Nothing else starts until it exists.',
  [ROLES.UX]:
    'Define what the person sees and does at each step, and reject any step that '
    + 'cannot be perceived. You own the final report Mac reads.',
  [ROLES.CODER]:
    'Make the smallest coherent change that satisfies the accepted flows. '
    + 'Touch only the files you own, and fix causes rather than symptoms.',
  [ROLES.TESTER]:
    'Prove each accepted flow on the real surface. A verdict is a command and its '
    + 'exit code, never an opinion, and never the local state when the truth is remote.',
  [ROLES.REVIEWER]:
    'Take every change to a merge-ready pull request. Read the diff that will actually '
    + 'land, leave comments that name a file and a line, and give one verdict: approve, or '
    + 'request changes with the blocking reasons. Green checks before an approval, always.',
  [ROLES.AUDITOR]:
    'Check the work against the engineering contract. Every finding names a file '
    + 'and a line, or a command and its output. Nothing weakened to make something pass.',
  // Kept only as the fallback for a fleet with no mission set. His real goal is
  // the mission itself - see objectiveForRole.
  [ROLES.ORCHESTRATOR]:
    'Route the work and hold the gates: the contract before the code, the proof '
    + 'before done. Escalate to Mac before anything destructive or irreversible.',
});

// The orchestrator's goal IS the mission. He is the one agent whose goal you
// set directly - the code even routes a goal on him to setMission - so
// answering with a role blurb threw away the sentence you had just typed and
// left him holding boilerplate that says nothing about this run.
export function objectiveForRole(role, mission) {
  if (role === ROLES.ORCHESTRATOR) return mission;
  return ROLE_OBJECTIVES[role] ?? mission;
}

// A goal you wrote yourself is yours and survives a new mission. A goal this
// function wrote follows the mission it came from, otherwise changing the
// mission would leave every agent working on the previous one.
export function deriveGoals(goals, agents, mission) {
  if (!mission) return goals;
  let next = goals;
  for (const agent of Object.values(agents)) {
    const existing = next[agent.id];
    if (existing?.objective && existing.source === GOAL_SOURCE.MANUAL) continue;
    next = setGoal(
      next,
      agent.id,
      objectiveForRole(agent.role, mission),
      null,
      GOAL_STATUS.ACTIVE,
      GOAL_SOURCE.DERIVED,
    );
  }
  return next;
}
