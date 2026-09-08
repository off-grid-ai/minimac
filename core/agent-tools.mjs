// The fleet tools available to engine sessions. Names, descriptions, schemas,
// and role access live here once. Drivers only register this catalogue; the
// server owns every state transition behind it.

import { ROLES } from './roster.mjs';
import { GATES } from './flows.mjs';
import { STAGE_ORDER } from './work-units.mjs';
import {
  buildCheckpointUpdateSchema,
  buildOutputSchema,
} from './dispatch.mjs';

export const AGENT_TOOL = Object.freeze({
  REPORT: 'report_progress',
  CHECKPOINT: 'update_checkpoint',
  INSPECT: 'inspect_avengers',
  ESCALATE: 'escalate_to_thor',
  MESSAGE: 'message_avenger',
  COMMENT: 'comment_checkpoint',
  REACT: 'react_to_checkpoint_message',
  ASSEMBLE: 'publish_work_plan',
  START: 'start_avenger',
  BENCH: 'bench_avenger',
  GOAL: 'set_avenger_goal',
  ASSIGN: 'create_checkpoint',
  CLOSE: 'close_checkpoint',
  PAUSE: 'pause_checkpoint',
  RESUME: 'resume_checkpoint',
  EXTEND: 'extend_checkpoint_lease',
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
    description: 'Report evidence and checkpoint gate results to MINIMAC. Checkpoints are the only mission progress record.',
    inputSchema: buildOutputSchema(),
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
      checkpointId: { type: 'string', description: 'The checkpoint that needs the decision. The current worker checkpoint is used when omitted.' },
    }, ['why', 'needs']),
  },
  [AGENT_TOOL.MESSAGE]: {
    name: AGENT_TOOL.MESSAGE,
    description: 'Send a short work message to another live Avenger. The directed message appears as Crosstalk and the sender walks to the recipient.',
    inputSchema: object({
      agentId: { type: 'string', description: 'The Avenger who must receive the message.' },
      text: { type: 'string', description: 'The work message. Use plain language and no more than four short lines.' },
      checkpointId: { type: 'string', description: 'The related checkpoint. The current worker checkpoint is used when omitted.' },
    }, ['agentId', 'text']),
  },
  [AGENT_TOOL.COMMENT]: {
    name: AGENT_TOOL.COMMENT,
    description: 'Add a reply to a checkpoint conversation. Use replyToId to keep a focused thread. This records discussion beside the work; use message_avenger only when another Avenger must act now.',
    inputSchema: object({
      id: { type: 'string', description: 'The related checkpoint id.' },
      text: { type: 'string', description: 'A short, useful message for the checkpoint conversation.' },
      replyToId: { type: 'string', description: 'The message id being answered, when applicable.' },
    }, ['id', 'text']),
  },
  [AGENT_TOOL.REACT]: {
    name: AGENT_TOOL.REACT,
    description: 'React to a checkpoint message when acknowledgement is enough. A reaction does not wake an Avenger or change checkpoint state.',
    inputSchema: object({
      id: { type: 'string', description: 'The related checkpoint id.' },
      messageId: { type: 'string', description: 'The message receiving the reaction.' },
      reaction: { type: 'string', enum: ['acknowledge', 'watching', 'question', 'blocked'] },
    }, ['id', 'messageId', 'reaction']),
  },
  [AGENT_TOOL.ASSEMBLE]: {
    name: AGENT_TOOL.ASSEMBLE,
    description: 'Publish parallel work units and their sequential role stages. The application validates role ownership, dependencies, and stage size before work starts.',
    inputSchema: object({
      crew: {
        type: 'object',
        description: 'Every non-Thor Avenger id mapped to false, true, or a worker count from 1 to 4.',
        additionalProperties: { oneOf: [{ type: 'boolean' }, { type: 'integer', minimum: 1, maximum: 4 }] },
      },
      workUnits: {
        type: 'array',
        items: object({
          id: { type: 'string', description: 'A unique work-unit id such as w1.' },
          title: { type: 'string' },
          outcome: { type: 'string', description: 'The result a person or reviewer can verify.' },
          scope: { type: 'string' },
          blockedBy: { type: 'array', items: { type: 'string' } },
          stages: {
            type: 'array',
            items: object({
              stage: { type: 'string', enum: STAGE_ORDER },
              required: { type: 'boolean' },
              owner: { type: 'string' },
              plan: { type: 'string' },
              verify: { type: 'string' },
              files: { type: 'array', items: { type: 'string' } },
              estimateMs: { type: 'integer', minimum: 1, maximum: 480000 },
            }, ['stage', 'required', 'owner', 'plan', 'verify', 'files', 'estimateMs']),
          },
        }, ['id', 'title', 'outcome', 'scope', 'blockedBy', 'stages']),
      },
    }, ['crew', 'workUnits']),
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
  [AGENT_TOOL.EXTEND]: {
    name: AGENT_TOOL.EXTEND,
    description: 'Extend one running checkpoint lease once. Use this only when the same bounded task is still valid.',
    inputSchema: object({ id: { type: 'string' } }, ['id']),
  },
});

const WORKER_TOOLS = Object.freeze([
  AGENT_TOOL.REPORT,
  AGENT_TOOL.CHECKPOINT,
  AGENT_TOOL.ESCALATE,
  AGENT_TOOL.MESSAGE,
  AGENT_TOOL.COMMENT,
  AGENT_TOOL.REACT,
]);
const THOR_TOOLS = Object.freeze([
  AGENT_TOOL.REPORT,
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
  AGENT_TOOL.EXTEND,
  AGENT_TOOL.MESSAGE,
  AGENT_TOOL.COMMENT,
  AGENT_TOOL.REACT,
]);

export function toolsForRole(role) {
  const names = role === ROLES.ORCHESTRATOR ? THOR_TOOLS : WORKER_TOOLS;
  return names.map((name) => TOOLS[name]);
}

export function roleCanUseTool(role, name) {
  return toolsForRole(role).some((tool) => tool.name === name);
}
