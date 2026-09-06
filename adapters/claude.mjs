// Claude adapter. Spawns the CLI in headless streaming mode and emits
// normalized Events. Steering is a user message written into the live stdin
// stream, which is Claude's equivalent of Codex's turn/steer.
//
// Checked against claude 2.1.263 on this machine:
//   - --output-format stream-json REQUIRES --verbose under --print. Without it
//     the CLI exits immediately with an error and no stream at all.
//   - --session-id takes our own uuid, so MINIMAC's session id IS Claude's.
//     That is what makes --resume possible after the process ends.
//   - a user message written to stdin mid-turn genuinely redirects the run:
//     observed a `sleep 8` chain abandoned and answered on the new instruction.
//   - the process stays alive across turns while stdin is open, but it can and
//     does exit after a turn, so steer respawns with --resume when it has.
//   - a denied tool comes back as a tool_result with is_error and an "requires
//     approval" body, and the run's result carries permission_denials[].

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  APPROVAL_KINDS,
  BLOCKED_REASONS,
  createApprovalEvent,
  createApprovalResolvedEvent,
  createBlockedEvent,
  createEvent,
  EVENT_KINDS,
} from '../core/events.mjs';

const TOOL_ACTIONS = Object.freeze({
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'run',
  BashOutput: 'run',
  Grep: 'search',
  Glob: 'search',
  WebSearch: 'search',
  WebFetch: 'read',
  Task: 'tool',
  ToolSearch: 'search',
  Skill: 'tool',
});

const PLAN_STATUS = Object.freeze({
  pending: 'pending',
  in_progress: 'wired',
  completed: 'completed',
});

// Claude states a permission problem in prose. This is the one place that
// reads it, so "blocked" means the same thing whichever tool tripped.
const NEEDS_APPROVAL = /\b(requires? (approval|permission)|permission (denied|required)|was blocked|not allowed|user (denied|rejected))\b/i;

export function createClaudeDriver({ bin = 'claude', model = null } = {}) {
  const sessions = new Map(); // sessionId -> { child, agentId, cwd, buffer, stderr, alive }
  const handlers = new Set();
  // tool_use_id -> the call it belongs to, so a result closes the same unit of
  // work its call opened. Without that pairing nothing is ever "in flight".
  const callsById = new Map();

  function emit(event) {
    for (const handler of handlers) handler(event);
  }

  // ------------------------------------------------------------ normalizing

  function normalize(agentId, line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const at = (kind, payload) => emit(createEvent(agentId, kind, payload));

    if (message.type === 'assistant') {
      for (const block of message.message?.content ?? []) {
        if (block.type === 'text' && block.text) at(EVENT_KINDS.MESSAGE, { text: block.text });
        if (block.type === 'tool_use') normalizeToolUse(at, block);
      }
      return;
    }

    // Tool results arrive as synthetic user messages. They carry the only
    // honest answer to "did that step actually work", which is what separates
    // a loop from progress.
    if (message.type === 'user') {
      for (const block of message.message?.content ?? []) {
        if (block.type === 'tool_result') normalizeToolResult(agentId, at, block);
      }
      return;
    }

    if (message.type === 'result') {
      normalizeResult(agentId, at, message);
      return;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      at(EVENT_KINDS.STATUS, { state: 'running', model: message.model ?? null });
    }
  }

  function normalizeToolUse(at, block) {
    // Claude has no first-class plan event; its todo list is the equivalent.
    if (block.name === 'TodoWrite') {
      const steps = (block.input?.todos ?? []).map((todo) => ({
        step: todo.content,
        status: PLAN_STATUS[todo.status] ?? todo.status,
      }));
      return at(EVENT_KINDS.PLAN, { steps });
    }
    const action = TOOL_ACTIONS[block.name] ?? (block.name?.startsWith('mcp__') ? 'tool' : null);
    if (!action) return undefined;
    const target = toolTarget(block);
    if (block.id) callsById.set(block.id, { action, target, tool: block.name });
    return at(EVENT_KINDS.TOOL, {
      action,
      target,
      phase: 'started',
      toolUseId: block.id ?? null,
      tool: block.name,
    });
  }

  function normalizeToolResult(agentId, at, block) {
    const text = resultText(block);
    const call = callsById.get(block.tool_use_id) ?? { action: 'tool', target: block.tool_use_id ?? '' };
    callsById.delete(block.tool_use_id);
    at(EVENT_KINDS.TOOL, {
      action: call.action,
      target: call.target,
      phase: 'completed',
      ok: block.is_error !== true,
      toolUseId: block.tool_use_id ?? null,
      detail: text.slice(0, 400),
    });

    if (block.is_error === true && NEEDS_APPROVAL.test(text)) {
      emit(
        createApprovalEvent(agentId, {
          id: block.tool_use_id ?? null,
          approvalKind: APPROVAL_KINDS.COMMAND,
          summary: text.split('\n')[0].slice(0, 200),
          detail: text.slice(0, 800),
          decisions: ['accept', 'decline'],
          engine: 'claude',
        }),
      );
      emit(
        createBlockedEvent(agentId, {
          category: BLOCKED_REASONS.APPROVAL,
          reason: text.split('\n')[0].slice(0, 200),
          approvalId: block.tool_use_id ?? null,
        }),
      );
    }
  }

  function normalizeResult(agentId, at, message) {
    for (const denial of message.permission_denials ?? []) {
      emit(
        createApprovalEvent(agentId, {
          id: denial.tool_use_id ?? null,
          approvalKind: APPROVAL_KINDS.COMMAND,
          summary: `${denial.tool_name}: ${denial.tool_input?.command ?? denial.tool_input?.file_path ?? ''}`.slice(0, 200),
          detail: JSON.stringify(denial.tool_input ?? {}).slice(0, 800),
          decisions: ['accept', 'decline'],
          engine: 'claude',
        }),
      );
    }

    at(EVENT_KINDS.RESULT, {
      report: parseReport(message.result),
      subtype: message.subtype ?? null,
      isError: message.is_error === true,
      durationMs: message.duration_ms ?? null,
      numTurns: message.num_turns ?? null,
      costUsd: message.total_cost_usd ?? null,
      receipt: 'claude --output-format stream-json result',
    });

    if (message.is_error === true) {
      emit(
        createBlockedEvent(agentId, {
          category: BLOCKED_REASONS.ERROR,
          reason: String(message.result ?? message.subtype ?? 'run failed').slice(0, 200),
        }),
      );
      return;
    }
    if ((message.permission_denials ?? []).length > 0) {
      emit(
        createBlockedEvent(agentId, {
          category: BLOCKED_REASONS.APPROVAL,
          reason: `${message.permission_denials.length} tool call(s) denied - approve or narrow the task`,
          approvalId: message.permission_denials[0]?.tool_use_id ?? null,
        }),
      );
    }
  }

  // ----------------------------------------------------------------- process

  function consume(sessionId, chunk) {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.buffer += chunk;
    const lines = session.buffer.split('\n');
    session.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) normalize(session.agentId, line);
    }
  }

  function argsFor(agent, sessionId, resume) {
    const args = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      // Verified: --print + stream-json output is rejected outright without it.
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--dangerously-skip-permissions',
      '--name', agent.name,
    ];
    args.push(resume ? '--resume' : '--session-id', sessionId);
    if (model) args.push('--model', model);
    return args;
  }

  function launch(agent, cwd, sessionId, resume) {
    const child = spawn(bin, argsFor(agent, sessionId, resume), {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const session = { child, agentId: agent.id, cwd, agent, buffer: '', stderr: '', alive: true };
    sessions.set(sessionId, session);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => consume(sessionId, chunk));

    // stderr must be drained or a full pipe buffer stalls the child. It is
    // also the only place a startup failure ever shows up.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      session.stderr = `${session.stderr}${chunk}`.slice(-4000);
    });

    child.on('error', (error) => {
      session.alive = false;
      emit(
        createBlockedEvent(agent.id, {
          category: BLOCKED_REASONS.ERROR,
          reason: `cannot launch ${bin}: ${error.message}`,
        }),
      );
    });

    child.on('exit', (code) => {
      session.alive = false;
      if (code !== 0 && session.stderr.trim()) {
        emit(
          createBlockedEvent(agent.id, {
            category: BLOCKED_REASONS.ERROR,
            reason: session.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300),
          }),
        );
      }
      emit(createEvent(agent.id, EVENT_KINDS.STATUS, { state: 'stopped', code }));
    });

    return session;
  }

  function write(sessionId, text) {
    const session = sessions.get(sessionId);
    if (!session || !session.alive || session.child.stdin.destroyed) return false;
    session.child.stdin.write(
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      })}\n`,
    );
    return true;
  }

  // A finished process is not a finished conversation: --resume picks the same
  // session back up, so steering an agent that has already reported still
  // works and still lands in the same transcript.
  function writeOrResume(sessionId, text) {
    if (write(sessionId, text)) return;
    const previous = sessions.get(sessionId);
    if (!previous) return;
    launch(previous.agent, previous.cwd, sessionId, true);
    write(sessionId, text);
  }

  return {
    async start(agent, cwd, prompt) {
      const sessionId = randomUUID();
      launch(agent, cwd, sessionId, false);
      write(sessionId, prompt);
      return sessionId;
    },

    // --resume rejoins the same conversation, so the agent still knows what it
    // found last time rather than rediscovering it.
    async resume(agent, cwd, sessionId, prompt) {
      launch(agent, cwd, sessionId, true);
      write(sessionId, prompt);
      return sessionId;
    },

    // Claude has no native goal object, so the goal travels in the prompt and
    // the canonical copy stays in core/goals.
    async setGoal(sessionId, objective) {
      if (objective) writeOrResume(sessionId, `Your goal has changed. From now on: ${objective}`);
    },

    async steer(sessionId, text) {
      writeOrResume(sessionId, text);
    },

    // Be clear about what this is. Claude Code's headless stream has no
    // approval channel to answer - by the time MINIMAC sees a denial the tool
    // call has ALREADY failed and the turn moved on. So an approval here is
    // not a decision handed back to a waiting engine; it is an instruction to
    // retry (or not) the thing that was refused, written as a user message,
    // resuming the session first if the process has since ended.
    //
    // The consequence worth knowing: accepting does not re-run the tool, it
    // asks Claude to. Claude may decline again for its own reasons, and the
    // permission mode the session was launched with still governs what it can
    // actually do. That is the honest ceiling of this verb on this engine.
    async approve(sessionId, approvalId, decision) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`no claude session ${sessionId}`);
      writeOrResume(sessionId, instructionFor(decision));
      emit(
        createApprovalResolvedEvent(session.agentId, {
          id: approvalId ?? null,
          decision: decision?.value ?? decision,
          by: 'you',
          summary: 'relayed to the session as an instruction, not a protocol answer',
          engine: 'claude',
        }),
      );
      emit(createEvent(session.agentId, EVENT_KINDS.STATUS, { state: 'running' }));
    },

    async interrupt(sessionId) {
      const session = sessions.get(sessionId);
      if (session?.alive) session.child.kill('SIGTERM');
    },

    onEvent(handler) {
      handlers.add(handler);
    },
  };
}

// ------------------------------------------------------------------ helpers

// The four protocol decisions, said in the only language this engine has.
function instructionFor(rawDecision) {
  const decision = rawDecision?.value ?? rawDecision;
  if (decision === 'acceptForSession') {
    return 'Approved for the rest of this session. Retry the action that was refused, and do not ask again for the same kind of action.';
  }
  if (decision === 'accept') {
    return 'Approved. Retry exactly the action that was refused, then carry on.';
  }
  if (decision === 'cancel') {
    return 'Denied. Stop this line of work entirely and wait for my next instruction.';
  }
  return 'Denied. Do not retry that action - find another way to reach the same user-visible result, or report that you cannot.';
}

function toolTarget(block) {
  const input = block.input ?? {};
  return (
    input.file_path ??
    input.notebook_path ??
    input.command ??
    input.pattern ??
    input.query ??
    input.url ??
    input.path ??
    block.name ??
    ''
  );
}

function resultText(block) {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('\n');
  }
  return content == null ? '' : String(content);
}

function parseReport(result) {
  if (typeof result !== 'string') return result ?? null;
  try {
    return JSON.parse(result);
  } catch {
    return { text: result };
  }
}
