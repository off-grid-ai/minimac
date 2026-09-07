// The fleet tools available to engine sessions. Names, descriptions, schemas,
// and role access live here once. Drivers only register this catalogue; the
// server owns every state transition behind it.

import { ROLES } from './roster.mjs';
import { GATES } from './flows.mjs';
import {
  buildCheckpointUpdateSchema,
  buildFlowStepSchema,
  buildOutputSchema,
} from './dispatch.mjs';

export const AGENT_TOOL = Object.freeze({
  REPORT: 'report_progress',
  FLOW: 'update_flow',
  CHECKPOINT: 'update_checkpoint',
  INSPECT: 'inspect_avengers',
  ESCALATE: 'escalate_to_thor',
  ASSEMBLE: 'assemble_avengers',
  START: 'start_avenger',
  BENCH: 'bench_avenger',
  GOAL: 'set_avenger_goal',
  ASSIGN: 'create_checkpoint',
  CLOSE: 'close_checkpoint',
  PAUSE: 'pause_checkpoint',
  RESUME: 'resume_checkpoint',
});

const object = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const TOOLS = Object.freeze({
  [AGENT_TOOL.REPORT]: {
    name: AGENT_TOOL.REPORT,
    description: 'Report flows, evidence, and checkpoint gate results to MINIMAC. This replaces a minimac fenced report.',
    inputSchema: buildOutputSchema(),
  },
  [AGENT_TOOL.FLOW]: {
    name: AGENT_TOOL.FLOW,
    description: 'Update one Flow step now. The Feed and Flows panel update from this call.',
    inputSchema: buildFlowStepSchema(),
  },
  [AGENT_TOOL.CHECKPOINT]: {
    name: AGENT_TOOL.CHECKPOINT,
    description: 'Update one gate on an owned checkpoint now. The Feed and Checkpoints panel update from this call.',
    inputSchema: buildCheckpointUpdateSchema(),
  },
  [AGENT_TOOL.INSPECT]: {
    name: AGENT_TOOL.INSPECT,
    description: 'Read the live Avengers, their worker capacity, and every ready or blocked checkpoint before assigning work.',
    inputSchema: object({}),
  },
  [AGENT_TOOL.ESCALATE]: {
    name: AGENT_TOOL.ESCALATE,
    description: 'Ask Thor for a decision, unblock, or conflict ruling. Mac can see it. Lead with the exact ask, then say why. Use plain language and no more than four short lines. Put command output in receipt, not in the ask.',
    inputSchema: object({
      why: { type: 'string', description: 'The exact ask first, then why it is needed. Plain language, 3 to 4 short lines maximum.' },
      needs: { type: 'string', enum: ['decision', 'unblock', 'conflict'] },
      agent: { type: 'string', description: 'The Avenger involved, if another Avenger is needed.' },
      receipt: { type: 'string', description: 'The command or observed result that supports the request.' },
    }, ['why', 'needs']),
  },
  [AGENT_TOOL.ASSEMBLE]: {
    name: AGENT_TOOL.ASSEMBLE,
    description: 'Apply the roster, goals, and shortest checkpoint path to the mission. A checkpoint is a necessary result, not a role activity. False benches an Avenger. True or 1 to 4 starts the seat.',
    inputSchema: object({
      crew: {
        type: 'object',
        description: 'Every non-Thor Avenger id mapped to false, true, or a worker count from 1 to 4.',
        additionalProperties: { oneOf: [{ type: 'boolean' }, { type: 'integer', minimum: 1, maximum: 4 }] },
      },
      goals: { type: 'object', additionalProperties: { type: 'string' } },
      items: {
        type: 'array',
        items: object({
          id: { type: 'string', description: 'A unique short id such as w1. Use it in blockedBy.' },
          title: { type: 'string' },
          plan: { type: 'string', description: 'A short ordered execution plan for this one task.' },
          outcome: { type: 'string', description: 'The result a person or reviewer can verify.' },
          verify: { type: 'string', description: 'The command or real-surface check that proves the outcome.' },
          scope: { type: 'string' },
          owner: { type: 'string' },
          needs: { type: 'array', items: { type: 'string', enum: GATES } },
          blockedBy: { type: 'array', items: { type: 'string' } },
          estimateMs: { type: 'integer', minimum: 1, maximum: 480000 },
        }, ['id', 'title', 'plan', 'outcome', 'verify', 'scope', 'owner', 'needs', 'blockedBy', 'estimateMs']),
      },
    }, ['crew', 'goals', 'items']),
  },
  [AGENT_TOOL.START]: {
    name: AGENT_TOOL.START,
    description: 'Start one benched Avenger on its next ready checkpoint through the full MINIMAC middleware. Each checkpoint must be an eight-minute work unit.',
    inputSchema: object({ agentId: { type: 'string' } }, ['agentId']),
  },
  [AGENT_TOOL.BENCH]: {
    name: AGENT_TOOL.BENCH,
    description: 'Stop and bench one Avenger. Stop and bench are the same fleet action.',
    inputSchema: object({ agentId: { type: 'string' } }, ['agentId']),
  },
  [AGENT_TOOL.GOAL]: {
    name: AGENT_TOOL.GOAL,
    description: 'Set one Avenger goal. A running session receives the full updated middleware.',
    inputSchema: object({
      agentId: { type: 'string' },
      objective: { type: 'string' },
    }, ['agentId', 'objective']),
  },
  [AGENT_TOOL.ASSIGN]: {
    name: AGENT_TOOL.ASSIGN,
    description: 'Create one necessary checkpoint when new work appears after assembly. Inspect capacity, create the checkpoint, then start its owner.',
    inputSchema: object({
      id: { type: 'string', description: 'A unique short id such as w9.' },
      title: { type: 'string' },
      plan: { type: 'string' },
      outcome: { type: 'string' },
      verify: { type: 'string' },
      scope: { type: 'string' },
      owner: { type: 'string' },
      needs: { type: 'array', items: { type: 'string', enum: GATES } },
      blockedBy: { type: 'array', items: { type: 'string' } },
      estimateMs: { type: 'integer', minimum: 1, maximum: 480000 },
      replaces: { type: 'string', description: 'Old checkpoint id this checkpoint supersedes.' },
    }, ['id', 'title', 'plan', 'outcome', 'verify', 'owner', 'needs', 'blockedBy', 'estimateMs']),
  },
  [AGENT_TOOL.CLOSE]: {
    name: AGENT_TOOL.CLOSE,
    description: 'Remove obsolete work from the active queue without deleting its history.',
    inputSchema: object({
      id: { type: 'string' },
      disposition: { type: 'string', enum: ['cancelled'] },
    }, ['id', 'disposition']),
  },
  [AGENT_TOOL.PAUSE]: {
    name: AGENT_TOOL.PAUSE,
    description: 'Pause one checkpoint. Its active worker stops, but its engine session remains available to resume.',
    inputSchema: object({ id: { type: 'string' } }, ['id']),
  },
  [AGENT_TOOL.RESUME]: {
    name: AGENT_TOOL.RESUME,
    description: 'Resume one paused checkpoint on its owner and continue its saved engine session.',
    inputSchema: object({ id: { type: 'string' } }, ['id']),
  },
});

const WORKER_TOOLS = Object.freeze([
  AGENT_TOOL.REPORT,
  AGENT_TOOL.FLOW,
  AGENT_TOOL.CHECKPOINT,
  AGENT_TOOL.ESCALATE,
]);
const THOR_TOOLS = Object.freeze([
  AGENT_TOOL.REPORT,
  AGENT_TOOL.FLOW,
  AGENT_TOOL.CHECKPOINT,
  AGENT_TOOL.INSPECT,
  AGENT_TOOL.ASSEMBLE,
  AGENT_TOOL.START,
  AGENT_TOOL.BENCH,
  AGENT_TOOL.GOAL,
  AGENT_TOOL.ASSIGN,
  AGENT_TOOL.CLOSE,
  AGENT_TOOL.PAUSE,
  AGENT_TOOL.RESUME,
]);

export function toolsForRole(role) {
  const names = role === ROLES.ORCHESTRATOR ? THOR_TOOLS : WORKER_TOOLS;
  return names.map((name) => TOOLS[name]);
}

export function roleCanUseTool(role, name) {
  return toolsForRole(role).some((tool) => tool.name === name);
}
