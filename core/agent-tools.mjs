// The fleet tools available to engine sessions. Names, descriptions, schemas,
// and role access live here once. Drivers only register this catalogue; the
// server owns every state transition behind it.

import { ROLES } from './roster.mjs';
import { GATES } from './flows.mjs';
import { buildOutputSchema } from './dispatch.mjs';

export const AGENT_TOOL = Object.freeze({
  REPORT: 'report_progress',
  ESCALATE: 'escalate_to_thor',
  ASSEMBLE: 'assemble_avengers',
  START: 'start_avenger',
  BENCH: 'bench_avenger',
  GOAL: 'set_avenger_goal',
  ASSIGN: 'assign_work',
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
    description: 'Report flows, evidence, and board gate results to MINIMAC. This replaces a minimac fenced report.',
    inputSchema: buildOutputSchema(),
  },
  [AGENT_TOOL.ESCALATE]: {
    name: AGENT_TOOL.ESCALATE,
    description: 'Ask Thor for a decision, unblock, or conflict ruling. Mac can see the same request. Do not ask Mac to relay it.',
    inputSchema: object({
      why: { type: 'string', description: 'The exact handoff or decision that Thor must make.' },
      needs: { type: 'string', enum: ['decision', 'unblock', 'conflict'] },
      agent: { type: 'string', description: 'The Avenger involved, if another Avenger is needed.' },
      receipt: { type: 'string', description: 'The command or observed result that supports the request.' },
    }, ['why', 'needs']),
  },
  [AGENT_TOOL.ASSEMBLE]: {
    name: AGENT_TOOL.ASSEMBLE,
    description: 'Apply the full Avengers roster, goals, and shared board plan. False benches an Avenger. True or 1 to 4 starts the seat.',
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
          title: { type: 'string' },
          scope: { type: 'string' },
          owner: { type: 'string' },
          needs: { type: 'array', items: { type: 'string', enum: GATES } },
          blockedBy: { type: 'array', items: { type: 'string' } },
          estimateMs: { type: 'integer', minimum: 1 },
        }, ['title', 'scope', 'owner', 'needs', 'blockedBy', 'estimateMs']),
      },
    }, ['crew', 'goals', 'items']),
  },
  [AGENT_TOOL.START]: {
    name: AGENT_TOOL.START,
    description: 'Start or resume one benched Avenger through the full MINIMAC middleware.',
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
    description: 'Create a shared board item or change the owner of an existing item.',
    inputSchema: object({
      id: { type: 'string', description: 'Existing item id to reassign. Omit to create an item.' },
      title: { type: 'string' },
      scope: { type: 'string' },
      owner: { type: 'string' },
      needs: { type: 'array', items: { type: 'string', enum: GATES } },
      blockedBy: { type: 'array', items: { type: 'string' } },
      estimateMs: { type: 'integer', minimum: 1 },
    }, ['owner']),
  },
});

const WORKER_TOOLS = Object.freeze([AGENT_TOOL.REPORT, AGENT_TOOL.ESCALATE]);
const THOR_TOOLS = Object.freeze([
  AGENT_TOOL.REPORT,
  AGENT_TOOL.ASSEMBLE,
  AGENT_TOOL.START,
  AGENT_TOOL.BENCH,
  AGENT_TOOL.GOAL,
  AGENT_TOOL.ASSIGN,
]);

export function toolsForRole(role) {
  const names = role === ROLES.ORCHESTRATOR ? THOR_TOOLS : WORKER_TOOLS;
  return names.map((name) => TOOLS[name]);
}

export function roleCanUseTool(role, name) {
  return toolsForRole(role).some((tool) => tool.name === name);
}
