import { statusOf } from '../core/board.mjs';
import { CONTEXT_KIND, messagesForContext, messagesForHero, threadSummary } from '../core/conversation.mjs';
import { missionNarrative } from '../core/activity.mjs';

export function createWorkspaceQuery({ getState, resolveResource = async () => null }) {
  const item = (state, id) => state.board.find((candidate) => candidate.id === id) ?? null;
  function mission(filters = {}) {
    const state = getState();
    return { id: String(state.runId), title: state.mission, progress: state.progress,
      narrative: missionNarrative({ events: state.events, missionId: String(state.runId), board: state.board, filters }),
      risks: state.contradictions, decisions: state.cards,
      filters: {
        heroes: Object.values(state.agents).map(({ id, label, name }) => ({ id, label: label ?? name ?? id })),
        checkpoints: state.board.map(({ id, title }) => ({ id, label: title ?? id })),
        workUnits: [...new Set(state.board.map((entry) => entry.workUnitId).filter(Boolean))],
        stages: [...new Set(state.board.map((entry) => entry.stage).filter(Boolean))],
      } };
  }
  function hero(id) {
    const state = getState();
    const agent = state.agents[id];
    if (!agent) return null;
    const checkpoints = state.board.filter((candidate) => candidate.owner === id);
    return { ...agent, goal: state.goals[id] ?? null, checkpoints,
      running: checkpoints.filter((candidate) => candidate.lease?.state === 'running'),
      queued: checkpoints.filter((candidate) => !candidate.closedAt && candidate.lease?.state !== 'running'),
      completed: checkpoints.filter((candidate) => Boolean(candidate.closedAt)),
      messages: messagesForHero(state.events, id, state.board),
      decisions: state.cards.filter((card) => card.agentId === id) };
  }
  function checkpoint(id) {
    const state = getState();
    const checkpoint = item(state, id);
    if (!checkpoint) return null;
    const context = { kind: CONTEXT_KIND.CHECKPOINT, id };
    return { ...checkpoint, status: statusOf({ items: state.board }, checkpoint),
      owner: state.agents[checkpoint.owner] ?? null, messages: messagesForContext(state.events, context),
      thread: threadSummary(state.events, context),
      dependencies: (checkpoint.blockedBy ?? []).map((entryId) => item(state, entryId)).filter(Boolean) };
  }
  function decision(id) {
    const state = getState();
    const decision = state.cards.find((card) => (card.key ?? card.id) === id);
    if (!decision) return null;
    const context = { kind: CONTEXT_KIND.DECISION, id };
    return { ...decision, messages: messagesForContext(state.events, context), thread: threadSummary(state.events, context) };
  }
  return Object.freeze({ mission, hero, checkpoint, decision, resource: resolveResource });
}
