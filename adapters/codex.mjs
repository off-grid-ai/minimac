// Codex adapter. Speaks the app-server JSON-RPC protocol over WebSocket and
// emits normalized Events.
//
// Every method, parameter and notification below was checked against the
// schema emitted by `codex app-server generate-json-schema --experimental` and
// then against a live daemon (`codex app-server --listen ws://127.0.0.1:4573`)
// on codex-cli 0.146.1. Notes where the wire disagrees with the obvious guess:
//   - initialize takes clientInfo + capabilities. There is no protocolVersion.
//   - thread/start takes `sandbox` (the string "workspace-write"), not a
//     `sandboxPolicy` object. It answers { thread: { id } }, not { threadId }.
//   - turn/start answers { turn: { id } } immediately; the turn runs on.
//   - turn/started carries `turn`, so the id is params.turn.id.
//   - thread/status/changed carries an OBJECT: params.status.type.
//   - turn/completed carries `turn`, with items, status and durationMs.
//   - approvals arrive as server->client REQUESTS with an id. They must be
//     answered or the engine waits forever. That wait is the BLOCKED state.

import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  APPROVAL_KINDS,
  BLOCKED_REASONS,
  createApprovalEvent,
  createApprovalResolvedEvent,
  createBlockedEvent,
  createEvent,
  decisionFromText,
  EVENT_KINDS,
} from '../core/events.mjs';

const APPROVAL_METHODS = Object.freeze({
  'item/commandExecution/requestApproval': APPROVAL_KINDS.COMMAND,
  'item/fileChange/requestApproval': APPROVAL_KINDS.FILE_CHANGE,
  'item/permissions/requestApproval': APPROVAL_KINDS.PERMISSION,
  'item/tool/requestUserInput': APPROVAL_KINDS.QUESTION,
  'mcpServer/elicitation/request': APPROVAL_KINDS.TOOL,
  // Pre-v2 spellings, still emitted by older daemons.
  execCommandApproval: APPROVAL_KINDS.COMMAND,
  applyPatchApproval: APPROVAL_KINDS.FILE_CHANGE,
});

// The pre-v2 approval request answers in a different vocabulary. Same four
// decisions, translated once, here.
const REVIEW_DECISIONS = Object.freeze({
  accept: 'approved',
  acceptForSession: 'approved_for_session',
  decline: { denied: { rejection: 'declined by MINIMAC' } },
  cancel: 'abort',
});

const ELICITATION = Object.freeze({
  accept: 'accept',
  acceptForSession: 'accept',
  decline: 'decline',
  cancel: 'cancel',
});

const HISTORY_LIMIT = 16_000;

function isAccept(decision) {
  return decision === 'accept' || decision === 'acceptForSession';
}

export function createCodexDriver({
  url = 'ws://127.0.0.1:4573',
  clientName = 'minimac',
  mcpServer = null,
} = {}) {
  let socket = null;
  let connecting = null;
  let nextId = 1;
  const pending = new Map();
  const handlers = new Set();
  const turnByThread = new Map();
  const agentByThread = new Map();
  const workerByThread = new Map();
  const runtimeByThread = new Map();
  const approvalsByThread = new Map(); // threadId -> [{ id, method, event }]

  function emit(event) {
    for (const handler of handlers) handler(event);
  }

  // ------------------------------------------------------- message batching

  const buffers = new Map(); // threadId -> { agentId, text, timer }
  const FLUSH_MS = 500;

  function bufferDelta(agentId, threadId, delta) {
    const entry = buffers.get(threadId) ?? { agentId, text: '', timer: null };
    entry.text += delta;
    if (!entry.timer) entry.timer = setTimeout(() => flushDelta(threadId), FLUSH_MS);
    buffers.set(threadId, entry);
  }

  function flushDelta(threadId, final = false) {
    const entry = buffers.get(threadId);
    if (!entry) return;
    clearTimeout(entry.timer);
    buffers.delete(threadId);
    if (entry.text.trim()) {
      emit(createEvent(entry.agentId, EVENT_KINDS.MESSAGE, {
        text: entry.text,
        partial: !final,
        sessionId: threadId,
        workerId: workerByThread.get(threadId) ?? null,
      }));
    }
  }

  // ------------------------------------------------------------- transport

  function connect() {
    if (socket && socket.readyState === 1) return Promise.resolve();
    if (connecting) return connecting;

    connecting = new Promise((resolve, reject) => {
      const next = new WebSocket(url);
      next.addEventListener('open', () => {
        socket = next;
        resolve();
      }, { once: true });
      next.addEventListener('error', () => reject(new Error(`codex app-server unreachable at ${url}`)), { once: true });
      next.addEventListener('message', (message) => onMessage(message.data));
      next.addEventListener('close', () => {
        socket = null;
        failAllPending(new Error('codex app-server connection closed'));
      }, { once: true });
    })
      .then(() =>
        request('initialize', {
          clientInfo: { name: clientName, version: '0.1.0' },
          capabilities: { experimentalApi: true },
        }),
      )
      .finally(() => {
        connecting = null;
      });

    return connecting;
  }

  function failAllPending(error) {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }

  function request(method, params) {
    if (!socket || socket.readyState !== 1) {
      return Promise.reject(new Error(`codex app-server not connected (${method})`));
    }
    const id = nextId++;
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30_000);
    });
  }

  function respond(id, result) {
    if (socket && socket.readyState === 1) {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
    }
  }

  function onMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    // A response: an id we sent, and no method.
    if (message.id !== undefined && message.method === undefined) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      return message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
    }
    // A server request: an id AND a method. It is owed an answer.
    if (message.id !== undefined && message.method) {
      return onServerRequest(message.id, message.method, message.params ?? {});
    }
    if (message.method) normalize(message.method, message.params ?? {});
  }

  // ------------------------------------------------------------- approvals

  // Codex stops dead until this request is answered. That is exactly what
  // BLOCKED means, so the pair is emitted together and the answer is whatever
  // the human types into the steer box.
  function onServerRequest(id, method, params) {
    const approvalKind = APPROVAL_METHODS[method];
    if (!approvalKind) return respond(id, {}); // housekeeping requests, answered empty

    const threadId = params.threadId ?? params.conversationId;
    const agentId = agentByThread.get(threadId);
    if (!agentId) return respond(id, { decision: 'decline' });

    const approval = describeApproval(approvalKind, params);
    const event = createApprovalEvent(agentId, { ...approval, id: String(id), engine: 'codex' });
    const queue = approvalsByThread.get(threadId) ?? [];
    queue.push({ id, method, threadId, agentId, event });
    approvalsByThread.set(threadId, queue);

    emit(event);
    emit(
      createBlockedEvent(agentId, {
        category: BLOCKED_REASONS.APPROVAL,
        reason: approval.summary,
        approvalId: String(id),
        sessionId: threadId,
        workerId: workerByThread.get(threadId) ?? null,
      }),
    );
  }

  function describeApproval(approvalKind, params) {
    if (approvalKind === APPROVAL_KINDS.COMMAND) {
      const command = params.command ?? '';
      return {
        approvalKind,
        summary: `run: ${Array.isArray(command) ? command.join(' ') : command}`,
        detail: params.reason ?? '',
        cwd: params.cwd ?? null,
        decisions: params.availableDecisions ?? ['accept', 'acceptForSession', 'decline', 'cancel'],
      };
    }
    if (approvalKind === APPROVAL_KINDS.FILE_CHANGE) {
      const paths = Object.keys(params.fileChanges ?? {});
      return {
        approvalKind,
        summary: paths.length ? `write: ${paths.join(', ')}` : 'write files outside the sandbox',
        detail: params.reason ?? params.grantRoot ?? '',
        paths,
        decisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
      };
    }
    if (approvalKind === APPROVAL_KINDS.PERMISSION) {
      return {
        approvalKind,
        summary: 'widen sandbox permissions',
        detail: params.reason ?? JSON.stringify(params.permissions ?? {}),
        cwd: params.cwd ?? null,
        decisions: ['accept', 'decline'],
      };
    }
    const questions = params.questions ?? [];
    return {
      approvalKind,
      summary: questions[0]?.question ?? 'the agent is waiting on an answer',
      detail: questions.map((question) => question.header).filter(Boolean).join(' / '),
      decisions: ['accept', 'decline'],
    };
  }

  // One place resolves an approval, whichever way the decision arrived: the
  // button (approve) or the prose (steer). Both owe the daemon an answer, and
  // both owe the floor an event that clears the card.
  function resolveApproval(entry, decision, text, by) {
    respond(entry.id, approvalResult(entry.method, decision, text));
    emit(
      createApprovalResolvedEvent(entry.agentId, {
        id: String(entry.id),
        decision,
        by,
        summary: entry.event.payload.summary,
        engine: 'codex',
      }),
    );
    if (decision === 'cancel' || decision === 'abort') return;
    emit(createEvent(entry.agentId, EVENT_KINDS.STATUS, {
      state: 'running', sessionId: entry.threadId, workerId: workerByThread.get(entry.threadId) ?? null,
    }));
  }

  function takeApproval(threadId, approvalId) {
    const queue = approvalsByThread.get(threadId);
    if (!queue || queue.length === 0) return null;
    const index =
      approvalId == null ? 0 : queue.findIndex((entry) => String(entry.id) === String(approvalId));
    if (index === -1) return null;
    const [entry] = queue.splice(index, 1);
    if (queue.length === 0) approvalsByThread.delete(threadId);
    return entry;
  }

  // Returns true when the text was consumed as an answer to a live approval.
  // This is the fallback for a human who types rather than presses: the
  // decision is read out of the prose instead of chosen from the list.
  function answerApproval(threadId, text) {
    const entry = takeApproval(threadId, null);
    if (!entry) return false;
    resolveApproval(entry, decisionFromText(text), text, 'steer');
    return true;
  }

  // The protocol decisions, spelled the way each request type spells them.
  // `decision` arrives verbatim from the APPROVAL event's decisions[], so the
  // button the human pressed is the value the daemon receives.
  function approvalResult(method, rawDecision, text) {
    const decision = rawDecision?.value ?? rawDecision;
    if (method === 'item/tool/requestUserInput') {
      return { answers: { default: { type: 'text', value: text ?? decision } } };
    }
    if (method === 'mcpServer/elicitation/request') {
      return { action: ELICITATION[decision] ?? 'decline' };
    }
    if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
      return { decision: REVIEW_DECISIONS[decision] ?? { denied: { rejection: 'declined by MINIMAC' } } };
    }
    if (method === 'item/permissions/requestApproval') {
      return isAccept(decision)
        ? { permissions: {}, scope: decision === 'acceptForSession' ? 'thread' : 'turn' }
        : { permissions: null };
    }
    return { decision };
  }

  // ------------------------------------------------------------ normalizing

  // The only engine-aware translation in the system.
  function normalize(method, params) {
    const threadId = params.threadId ?? params.conversationId;
    const agentId = agentByThread.get(threadId);
    if (!agentId) return undefined;
    const workerId = workerByThread.get(threadId) ?? null;
    const at = (kind, payload) => emit(createEvent(agentId, kind, {
      ...payload,
      sessionId: threadId,
      workerId,
      engine: 'codex',
    }));

    switch (method) {
      case 'turn/started':
        turnByThread.set(threadId, params.turn?.id);
        return at(EVENT_KINDS.STATUS, { state: 'running', turnId: params.turn?.id });

      case 'turn/completed':
        flushDelta(params.threadId, true); {
        turnByThread.delete(threadId);
        const turn = params.turn ?? {};
        at(EVENT_KINDS.RESULT, {
          report: finalText(turn.items),
          status: turn.status ?? null,
          durationMs: turn.durationMs ?? null,
          error: turn.error ?? null,
        });
        return at(EVENT_KINDS.STATUS, { state: turn.status === 'failed' ? 'blocked' : 'idle' });
      }

      case 'turn/plan/updated':
        return at(EVENT_KINDS.PLAN, {
          steps: (params.plan ?? []).map((entry, index) => ({
            id: String(entry.id ?? `f${index + 1}`),
            step: entry.step,
            status: planStatus(entry.status),
          })),
          explanation: params.explanation ?? null,
        });

      case 'turn/diff/updated':
        return at(EVENT_KINDS.DIFF, {
          lines: countDiffLines(params.diff),
          receipt: 'codex turn/diff/updated',
        });

      case 'item/started':
        return normalizeItem(at, params.item ?? {}, 'started');

      case 'item/completed':
        return normalizeItem(at, params.item ?? {}, 'completed');

      case 'item/agentMessage/delta':
        // Codex streams a token at a time. One event per fragment floods the
        // floor and the database with words, so deltas are accumulated and
        // released as readable sentences.
        return bufferDelta(agentId, params.threadId, params.delta ?? '');

      case 'thread/status/changed':
        return at(EVENT_KINDS.STATUS, { state: threadState(params.status) });

      case 'thread/goal/updated':
        return at(EVENT_KINDS.STATUS, {
          goal: params.goal?.objective ?? null,
          tokensUsed: params.goal?.tokensUsed ?? null,
          tokenBudget: params.goal?.tokenBudget ?? null,
        });

      case 'error':
        emit(
          createBlockedEvent(agentId, {
            category: BLOCKED_REASONS.ERROR,
            reason: params.message ?? 'codex reported an error',
            sessionId: threadId,
            workerId,
          }),
        );
        return undefined;

      default:
        return undefined;
    }
  }

  function normalizeItem(at, item, phase) {
    if (item.type === 'commandExecution') {
      // commandActions is the daemon's own parse of the shell line, so a read
      // dressed up as `cat` is recorded as a read of that path. Loop detection
      // needs the target, not the shell noise around it.
      const action = commandAction(item.commandActions);
      return at(EVENT_KINDS.TOOL, {
        toolUseId: item.id ?? null,
        action: action.action,
        target: action.target || item.command || '',
        phase,
        ok: phase === 'completed' ? item.exitCode === 0 : null,
        exitCode: item.exitCode ?? null,
        durationMs: item.durationMs ?? null,
        receipt: item.command ?? null,
      });
    }
    if (item.type === 'fileChange') {
      const paths = (item.changes ?? []).map((change) => change.path).filter(Boolean);
      return at(EVENT_KINDS.TOOL, {
        toolUseId: item.id ?? null,
        action: 'edit',
        target: paths[0] ?? '',
        paths,
        phase,
        ok: phase === 'completed' ? item.status === 'completed' : null,
      });
    }
    if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
      return at(EVENT_KINDS.TOOL, {
        toolUseId: item.id ?? null,
        action: 'tool',
        target: item.server ? `${item.server}.${item.tool}` : item.tool ?? '',
        phase,
        ok: phase === 'completed' ? item.status !== 'failed' : null,
      });
    }
    if (item.type === 'webSearch') {
      return at(EVENT_KINDS.TOOL, {
        toolUseId: item.id ?? null, action: 'search', target: item.query ?? '', phase,
      });
    }
    if (item.type === 'imageView') {
      return at(EVENT_KINDS.TOOL, {
        toolUseId: item.id ?? null, action: 'read', target: item.path ?? '', phase,
      });
    }
    if (item.type === 'agentMessage' && phase === 'completed' && item.text) {
      return at(EVENT_KINDS.MESSAGE, { text: item.text, final: item.phase === 'final_answer' });
    }
    return undefined;
  }

  // ------------------------------------------------------------------ port

  return {
    async configureRuntime(sessionId, agent) {
      runtimeByThread.set(sessionId, {
        model: agent.model || null,
        effort: agent.effort || null,
      });
    },

    async history(sessionId) {
      try {
        await connect();
        const result = await request('thread/read', { threadId: sessionId, includeTurns: true });
        const transcript = transcriptOf(result?.thread?.turns ?? []);
        if (transcript) return transcript;
      } catch {
        // Old threads can outlive the app-server index. Their rollout JSONL is
        // still the durable record, so an engine change must not lose it.
      }
      return localTranscript(sessionId);
    },

    async reconcile(agent, cwd, sessionId) {
      await connect();
      // Register first so any status notification emitted during resume has a
      // destination. This does not start a turn.
      agentByThread.set(sessionId, agent.id);
      workerByThread.set(sessionId, agent.workerId ?? null);
      runtimeByThread.set(sessionId, { model: agent.model || null, effort: agent.effort || null });
      const result = await request('thread/resume', {
        threadId: sessionId,
        cwd,
        config: mcpConfig(agent),
      });
      const thread = result?.thread ?? {};
      const threadId = thread.id ?? sessionId;
      agentByThread.set(threadId, agent.id);
      workerByThread.set(threadId, agent.workerId ?? null);
      runtimeByThread.set(threadId, { model: agent.model || null, effort: agent.effort || null });
      const state = threadState(thread.status);
      const activeTurn = [...(thread.turns ?? [])].reverse().find((turn) => {
        const type = typeof turn.status === 'string' ? turn.status : turn.status?.type;
        return ['active', 'running', 'inProgress'].includes(type);
      });
      if (activeTurn?.id) turnByThread.set(threadId, activeTurn.id);
      return { sessionId: threadId, live: state === 'running', state, resumable: true };
    },

    async start(agent, cwd, prompt) {
      await connect();
      const thread = await request('thread/start', {
        cwd,
        model: agent.model || null,
        // No prompts: the operator asked for full autonomy, so the engine acts
        // instead of parking on an approval it will wait forever for.
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        config: mcpConfig(agent),
      });
      const threadId = thread?.thread?.id;
      if (!threadId) throw new Error('thread/start returned no thread id');
      agentByThread.set(threadId, agent.id);
      workerByThread.set(threadId, agent.workerId ?? null);
      runtimeByThread.set(threadId, { model: agent.model || null, effort: agent.effort || null });

      const turn = await request('turn/start', {
        threadId,
        model: agent.model || null,
        effort: agent.effort || null,
        input: [{ type: 'text', text: prompt }],
      });
      if (turn?.turn?.id) turnByThread.set(threadId, turn.turn.id);
      return threadId;
    },

    // Continue an existing thread instead of opening a new one. The model
    // keeps everything it already worked out; only the new instruction is added.
    async resume(agent, cwd, sessionId, prompt) {
      await connect();
      const thread = await request('thread/resume', {
        threadId: sessionId,
        cwd,
        config: mcpConfig(agent),
      });
      const threadId = thread?.thread?.id ?? sessionId;
      agentByThread.set(threadId, agent.id);
      workerByThread.set(threadId, agent.workerId ?? null);
      runtimeByThread.set(threadId, { model: agent.model || null, effort: agent.effort || null });

      const turn = await request('turn/start', {
        threadId,
        model: agent.model || null,
        effort: agent.effort || null,
        input: [{ type: 'text', text: prompt }],
      });
      if (turn?.turn?.id) turnByThread.set(threadId, turn.turn.id);
      return threadId;
    },

    async setGoal(sessionId, objective, tokenBudget, status) {
      await connect();
      await request('thread/goal/set', {
        threadId: sessionId,
        objective: objective ?? null,
        tokenBudget: tokenBudget ?? null,
        status: status ?? null,
      });
    },

    // Steering means one of two things, and the engine's state decides which:
    // answer the approval it is stuck on, or redirect the turn it is running.
    async steer(sessionId, text) {
      if (answerApproval(sessionId, text)) return;

      const turnId = turnByThread.get(sessionId);
      if (!turnId) {
        // No live turn to steer, so the correction becomes the next turn.
        const runtime = runtimeByThread.get(sessionId) ?? {};
        const turn = await request('turn/start', {
          threadId: sessionId,
          model: runtime.model ?? null,
          effort: runtime.effort ?? null,
          input: [{ type: 'text', text }],
        });
        if (turn?.turn?.id) turnByThread.set(sessionId, turn.turn.id);
        return;
      }
      await request('turn/steer', {
        threadId: sessionId,
        expectedTurnId: turnId,
        input: [{ type: 'text', text }],
      });
    },

    // The decision as a decision: no prose, no inference, and the exact string
    // the APPROVAL event advertised goes back on the wire.
    async approve(sessionId, approvalId, decision) {
      const entry = takeApproval(sessionId, approvalId);
      if (!entry) throw new Error(`no approval ${approvalId ?? ''} waiting on ${sessionId}`);
      // Either half of the pair the APPROVAL event advertised is accepted, so
      // a button can send the whole decision and a script can send the value.
      resolveApproval(entry, decision?.value ?? decision, null, 'you');
    },

    async interrupt(sessionId) {
      // An unanswered approval outlives the turn, so clear it first or the
      // daemon keeps a thread parked on a question nobody will answer.
      while (answerApproval(sessionId, 'cancel'));
      const turnId = turnByThread.get(sessionId);
      if (turnId) await request('turn/interrupt', { threadId: sessionId, turnId });
      turnByThread.delete(sessionId);
    },

    onEvent(handler) {
      handlers.add(handler);
    },
  };

  function mcpConfig(agent) {
    const server = mcpServer?.(agent);
    return server ? { mcp_servers: { minimac: server } } : null;
  }
}

function transcriptOf(turns) {
  const lines = [];
  for (const turn of turns) {
    for (const item of turn.items ?? []) {
      if (item.type === 'userMessage') {
        const text = (item.content ?? []).map(userInputText).filter(Boolean).join('\n');
        if (text) lines.push(`USER\n${text}`);
      } else if (item.type === 'agentMessage' && item.text) {
        lines.push(`ASSISTANT\n${item.text}`);
      } else if (item.type === 'commandExecution') {
        const result = [
          `status=${item.status}`,
          item.exitCode === null || item.exitCode === undefined ? null : `exit=${item.exitCode}`,
          item.aggregatedOutput?.slice(-1200),
        ].filter(Boolean).join('\n');
        lines.push(`COMMAND\n${item.command}${result ? `\n${result}` : ''}`);
      } else if (item.type === 'mcpToolCall') {
        lines.push(`TOOL\n${item.server}.${item.tool} status=${item.status}`);
      } else if (item.type === 'fileChange') {
        lines.push(`FILES\n${(item.changes ?? []).map((change) => change.path).filter(Boolean).join('\n')}`);
      }
    }
  }
  return boundedHistory(lines.join('\n\n'));
}

function userInputText(input) {
  if (input?.type === 'text') return input.text ?? '';
  if (input?.type === 'localImage') return `[image: ${input.path ?? 'local image'}]`;
  if (input?.type === 'image') return '[image]';
  return '';
}

async function localTranscript(sessionId) {
  const root = join(homedir(), '.codex', 'sessions');
  const entries = await readdir(root, { recursive: true });
  const relative = entries.find((entry) => entry.endsWith(`${sessionId}.jsonl`));
  if (!relative) return '';
  const raw = await readFile(join(root, relative), 'utf8');
  const lines = [];
  for (const row of raw.split('\n')) {
    if (!row.trim()) continue;
    let record;
    try { record = JSON.parse(row); } catch { continue; }
    const item = record.type === 'response_item' ? record.payload : null;
    if (item?.type !== 'message' || !['user', 'assistant'].includes(item.role)) continue;
    const message = (item.content ?? [])
      .map((part) => part?.text ?? '')
      .filter(Boolean)
      .join('\n');
    if (message) lines.push(`${item.role === 'user' ? 'USER' : 'ASSISTANT'}\n${message}`);
  }
  return boundedHistory(lines.join('\n\n'));
}

function boundedHistory(transcript) {
  return transcript.length > HISTORY_LIMIT
    ? `[earlier history omitted]\n${transcript.slice(-HISTORY_LIMIT)}`
    : transcript;
}

// ------------------------------------------------------------------ helpers

function commandAction(commandActions) {
  for (const action of commandActions ?? []) {
    if (action.type === 'read') return { action: 'read', target: action.path ?? action.name ?? '' };
    if (action.type === 'listFiles') return { action: 'read', target: action.path ?? '' };
    if (action.type === 'search') return { action: 'search', target: action.query ?? action.path ?? '' };
  }
  return { action: 'run', target: '' };
}

function planStatus(status) {
  if (status === 'inProgress') return 'running';
  if (status === 'completed') return 'coded';
  return 'pending';
}

function threadState(status) {
  const type = typeof status === 'string' ? status : status?.type;
  if (type === 'active') return 'running';
  if (type === 'idle') return 'idle';
  if (type === 'systemError') return 'blocked';
  return type ?? 'idle';
}

function finalText(items) {
  const message = (items ?? [])
    .filter((item) => item.type === 'agentMessage' && item.text)
    .pop();
  return message ? { text: message.text } : null;
}

// The diff is the whole turn's unified diff, re-sent as it grows.
export function countDiffLines(diff) {
  if (!diff || typeof diff !== 'string') return 0;
  let count = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+') || line.startsWith('-')) count += 1;
  }
  return count;
}
