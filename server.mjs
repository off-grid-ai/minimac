// Transport and wiring only. Every rule lives in core/; every I/O detail lives
// in adapters/. This file moves messages between them.

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appendEvent,
  BLOCKED_REASONS,
  createBlockedEvent,
  createEvent,
  EVENT_KINDS,
  eventsFor,
} from './core/events.mjs';
import {
  createRoster,
  assignEngine,
  configureRuntime as configureAgentRuntime,
  defaultRuntime,
  DEFAULT_ROSTER,
  ENGINES,
  ROLES,
  isActive,
} from './core/roster.mjs';
import {
  WORKER_STATE,
  ensureWorkers,
  freeWorkers,
  hasLiveWorker,
  hydrateWorker,
  liveWorkers,
  patchWorker,
  primarySessionId,
  projectWorkers,
  workerForCheckpoint,
  workerForSession,
} from './core/workers.mjs';
import { canResumeSession, isCurrentSessionEvent } from './core/session-lifecycle.mjs';
import { setGoal, getGoal, clearGoal, deriveGoals } from './core/goals.mjs';
import { claimFiles, releaseClaim } from './core/claims.mjs';
import {
  composeDispatch,
  buildOutputSchema,
  workerDispatches,
  REPORT_FENCE,
  WORK_PLAN_FENCE,
  planningTask,
  EDITABLE_STEPS,
  defaultStepText,
  dispatchPipeline,
} from './core/dispatch.mjs';
import { createDriverRegistry } from './ports/driver.mjs';
import { createCodexDriver } from './adapters/codex.mjs';
import { createClaudeDriver } from './adapters/claude.mjs';
import { createSimDriver } from './adapters/sim.mjs';
import { ensureCodexServer } from './adapters/codexd.mjs';
import { REMOTE, remoteMode, remoteName, wantsRemote } from './core/remote.mjs';
import { createStore } from './adapters/store.mjs';
import { createWorktrees } from './adapters/git.mjs';
import { createRepoIndex } from './adapters/fs.mjs';
import { createUploads } from './adapters/uploads.mjs';
import { createGithubChecksPort } from './adapters/github-checks.mjs';
import { createCiMonitor } from './application/ci-monitor.mjs';
import { createWorkBoard } from './application/work-board.mjs';
import { createWorkPlanningService } from './application/work-planning.mjs';
import { createScheduler } from './application/scheduler.mjs';
import { createFleetCoordination } from './application/fleet-coordination.mjs';
import { createConversationService } from './application/conversations.mjs';
import { createWorkspaceQuery } from './application/workspace-query.mjs';
import { createWorkerLeaseService } from './application/worker-leases.mjs';
import { createRuntimeSupervisor } from './application/runtime-supervisor.mjs';
import { ORDER_ACTION } from './core/coordination.mjs';
import { LEASE_LIMIT_MS, finishLease } from './core/leases.mjs';
import { readyCheckpoints } from './core/scheduler.mjs';
import {
  CONTEXT_KIND,
  messagesForContext,
} from './core/conversation.mjs';
import { projectMissionFlows } from './core/mission-flows.mjs';
import {
  createAcceptancePolicy,
  missionIsComplete,
  validateAcceptancePolicy,
  reconcileAcceptanceChange,
} from './core/acceptance.mjs';
import {
  projectMissionProgress,
  repositoryQualitySummary,
  missionContradictions,
} from './core/mission-quality.mjs';
import { parseMentions, routeOf } from './core/mentions.mjs';
import {
  deriveCards,
  diffCards,
  indexByAgent,
  cardKey,
  prayerOf,
  stampCards,
} from './core/monitor.mjs';
import {
  createBoard,
  closeItem,
  revise as reviseItem,
  setPaused as setCheckpointPaused,
  moveItem as moveCheckpointItem,
  itemsOf,
  itemsFor,
  canWork,
  isClosed,
  isDone,
  unmetDeps,
  stateOf as checkpointState,
  findItem,
  beginCheckpoint,
  failCheckpointStart,
} from './core/board.mjs';
import {
  routeCard,
  guardVerdict,
  governanceTask,
  parseVerdicts,
  VERDICT,
  VERDICT_FENCE,
} from './core/governance.mjs';
import { splitFenced, isMachineNoise } from './core/readable.mjs';
import { AGENT_TOOL, roleCanUseTool } from './core/agent-tools.mjs';
import { applyFleetEvent } from './core/fleet-reducer.mjs';
import { activationPlan } from './core/crew.mjs';
import { estimateDispatchTokens } from './core/token-estimate.mjs';
import {
  isVerificationCheckpoint,
  reconcileReleaseCheckpoints,
  STAGE_GATES,
} from './core/work-units.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.json': 'application/json; charset=utf-8',
};

const options = parseArgs(process.argv.slice(2));

// A personal roster is a local file, never a repo default: names and meshes
// are taste, and one machine's taste should not ship with the tool.
if (options.rosterPath) {
  const file = JSON.parse(await readFile(options.rosterPath, 'utf8').catch(() => '{}'));
  // "$team" names the crew; every other key is an agent override.
  const { $team, ...agents } = file;
  options.team = $team ?? options.team;
  options.rosterOverrides = agents;
}

const state = {
  agents: forceEngine(createRoster(DEFAULT_ROSTER, options.rosterOverrides), options.engine),
  goals: {},
  claims: {},
  events: [],
  assembly: null,
  mission: options.mission,
  // What the room has noticed and nobody has reported. Derived here rather
  // than in the browser, so the same answer reaches the screen AND anything
  // that can act on it.
  cards: [],
  // Suppressed only while the same condition remains true. When it clears,
  // the key is released and a later recurrence becomes a new decision.
  dismissedCards: new Set(),
  // What Thor has said about each card, keyed by cardKey so it dies with it.
  verdicts: {},
  governing: false,
  // The shared board. One list of work every agent reads and writes, so
  // coordination stops being prose.
  board: createBoard(),
  acceptance: createAcceptancePolicy(),
  completedAt: null,
};

const MAX_REFERENCE_BYTES = 2 * 1024 * 1024;

state.goals = deriveGoals(state.goals, state.agents, state.mission);

const store = createStore({ file: join(ROOT, 'data', 'minimac.db') });

function runtimeKey(agentId, engine) {
  return `agent-runtime:${agentId}:${engine}`;
}

function applySavedRuntime(agentId) {
  const agent = state.agents[agentId];
  if (!agent) return;
  const runtime = store.setting(runtimeKey(agent.id, agent.engine), defaultRuntime(agent.engine));
  try {
    state.agents = configureAgentRuntime(state.agents, agent.id, runtime);
  } catch {
    state.agents = configureAgentRuntime(state.agents, agent.id, defaultRuntime(agent.engine));
  }
}

for (const agent of Object.values(state.agents)) applySavedRuntime(agent.id);

// A restart is not new work. If this repo left a run open, rejoin it and take
// back its mission and its goals - otherwise every restart puts the whole
// fleet back to "no goal - this agent would start blind" while the run it
// belongs to is still sitting in the list marked running.
const adopted = store.adoptRun(options.repo);
let adoptedSessions = [];
if (adopted) {
  // Engine selection is run state. Restore it before session reconciliation,
  // because a handle can only be opened by the engine that created it.
  for (const row of store.enginesFor(adopted.id)) {
    state.agents = assignEngine(state.agents, row.agent_id, row.engine);
  }
  for (const agent of Object.values(state.agents)) applySavedRuntime(agent.id);
  adoptedSessions = store.workerSessionsFor(adopted.id);
  if (!state.mission && adopted.mission) state.mission = adopted.mission;
  // The mission only arrives here, so the derive at boot ran against an empty
  // one and gave every worker nothing. Derive again now that we know what the
  // run is for - a worker with no goal is the drift this tool exists to stop.
  state.goals = deriveGoals(state.goals, state.agents, state.mission);
  // Saved goals are the truth and outrank anything derived, so they land last.
  for (const row of store.goalsFor(adopted.id)) {
    if (!row.objective) continue;
    state.goals = setGoal(
      state.goals,
      row.agent_id,
      row.objective,
      row.token_budget,
      row.status ?? 'active',
      row.source ?? 'manual',
    );
  }
  // Whatever the run was missing is now written down, so this cannot silently
  // come back as blank goals on the next restart.
  for (const [agentId, goal] of Object.entries(state.goals)) store.saveGoal(agentId, goal);

  // And the run's HISTORY, not just its goals. Without this the monitor was
  // blind to everything before the restart while the browser replayed the lot
  // from the database - so the room could show a loop the server could not
  // see, and no card was ever raised for it.
  state.events = store.replayRun(adopted.id);
  for (const event of state.events) state.agents = applyFleetEvent(state.agents, event);
  // Start from a safe projection, then reconcile saved handles with each
  // engine after its transport is ready. Idle conversations remain resumable.
  for (const agent of Object.values(state.agents)) {
    const saved = adoptedSessions
      .filter((row) => row.agent_id === agent.id)
      .map(hydrateWorker);
    const restored = projectWorkers({ ...agent, workers: saved, blockedReason: null });
    state.agents = patchAgent(state.agents, agent.id, projectWorkers(restored, ensureWorkers(restored)));
  }
  // The checkpoints belong to the run, so rejoining a run rejoins its work.
  const adoptedItems = store.itemsFor(adopted.id);
  state.board = { workUnits: store.workUnitsFor(adopted.id), items: adoptedItems };
  state.acceptance = store.acceptanceFor(adopted.id) ?? createAcceptancePolicy();
  const savedMissionState = store.missionStateFor(adopted.id);
  state.completedAt = savedMissionState?.completedAt
    ?? (missionIsComplete(state.acceptance, state.board) ? Date.now() : null);
  const adoptedAt = Date.now();
  state.cards = stampCards(
    state.cards,
    deriveCards(Object.values(state.agents), indexByAgent(state.events), state.board, adoptedAt),
    adoptedAt,
  );
}
const worktrees = createWorktrees({ repo: options.repo, root: join(ROOT, 'worktrees') });
const repoIndex = createRepoIndex();
const uploads = createUploads({ dir: join(ROOT, 'data', 'attachments') });
const agentTokens = new Map();
const agentsByToken = new Map();

function mcpServerFor(agent) {
  const principalId = agent.workerId ?? agent.id;
  let token = agentTokens.get(principalId);
  // One worker is one local tool principal for this server process. Engine
  // turns and resumable sessions can keep the MCP child that received this
  // environment, so activity changes must never rotate its identity.
  if (!token || !agentsByToken.has(token)) {
    token = randomUUID();
    agentTokens.set(principalId, token);
    agentsByToken.set(token, { agentId: agent.id, workerId: agent.workerId ?? null });
  }
  return {
    command: process.execPath,
    args: [join(ROOT, 'adapters', 'fleet-mcp.mjs')],
    env: {
      MINIMAC_SERVER_URL: `http://127.0.0.1:${options.port}`,
      MINIMAC_AGENT_TOKEN: token,
      MINIMAC_AGENT_ROLE: agent.role,
    },
  };
}
// How this fleet is told to work. Survives runs and restarts.
const middleware = store.middleware();
// Who is reachable from your phone. core/remote decides; the drivers carry it
// to the two CLIs, which differ in what they can honour - see core/remote.
function remoteFor(agent) {
  return wantsRemote(agent, options.remote)
    ? remoteName(agent, { team: options.team })
    : null;
}

const getDriver = createDriverRegistry({
  [ENGINES.CODEX]: createCodexDriver({ url: options.codexUrl, mcpServer: mcpServerFor }),
  [ENGINES.CLAUDE]: createClaudeDriver({ remoteName: remoteFor, mcpServer: mcpServerFor }),
  [ENGINES.SIM]: createSimDriver(),
});

for (const engine of Object.values(ENGINES)) {
  getDriver(engine).onEvent(ingest);
}

const subscribers = new Set();
const HANDOFF_LIMIT = 16_000;
let workerLeases = null;

function boundedHandoff(text) {
  const transcript = String(text ?? '').trim();
  return transcript.length > HANDOFF_LIMIT
    ? `[earlier history omitted]\n${transcript.slice(-HANDOFF_LIMIT)}`
    : transcript;
}

function eventTranscript(agentId) {
  const lines = [];
  for (const event of eventsFor(state.events, agentId)) {
    const payload = event.payload ?? {};
    if (event.kind === EVENT_KINDS.CONVERSATION_MESSAGE && payload.message?.body) {
      lines.push(`${payload.message.from === 'you' ? 'USER' : 'ASSISTANT'}\n${payload.message.body}`);
    } else if (event.kind === EVENT_KINDS.TOOL) {
      lines.push(`TOOL\n${payload.action ?? 'tool'} ${payload.target ?? ''} ${payload.phase ?? ''}`.trim());
    } else if (event.kind === EVENT_KINDS.CLAIM && payload.text) {
      lines.push(`CLAIM\n${payload.text}${payload.receipt ? `\nreceipt: ${payload.receipt}` : ''}`);
    } else if (event.kind === EVENT_KINDS.RESULT && payload.report) {
      lines.push(`RESULT\n${JSON.stringify(payload.report)}`);
    } else if (event.kind === EVENT_KINDS.BLOCKED && payload.reason) {
      lines.push(`BLOCKED\n${payload.reason}`);
    } else if (event.kind === EVENT_KINDS.STATUS && payload.text) {
      lines.push(`STATUS\n${payload.text}`);
    }
  }
  return boundedHandoff(lines.join('\n\n'));
}

async function captureEngineHandoff(agentId, fromEngine, toEngine, sessionId) {
  if (fromEngine === toEngine) return null;
  const sessionIds = (Array.isArray(sessionId) ? sessionId : [sessionId]).filter(Boolean);
  const transcripts = [];
  const driver = getDriver(fromEngine);
  if (typeof driver.history === 'function') {
    for (const id of sessionIds) {
      try {
        const history = await driver.history(id, options.repo);
        if (history) transcripts.push(`SESSION ${id}\n${history}`);
      } catch {
        // The durable MINIMAC event transcript remains the fallback.
      }
    }
  }
  const transcript = boundedHandoff(transcripts.join('\n\n') || eventTranscript(agentId));
  if (!transcript) return null;
  const handoff = {
    fromEngine,
    toEngine,
    sourceSessionId: sessionIds.join(','),
    transcript,
  };
  store.saveHandoff(agentId, handoff);
  return handoff;
}

// A restart does not guess. Ask each engine about the saved handle without
// starting work. A live thread stays on; a resumable idle thread stays off
// until the user or Thor starts it.
async function reconcileAdoptedSessions() {
  for (const row of adoptedSessions) {
    const agent = state.agents[row.agent_id];
    if (!agent) continue;
    const workerId = row.worker_id ?? `${agent.id}:1`;
    if (row.engine !== agent.engine) {
      await captureEngineHandoff(agent.id, row.engine, agent.engine, row.session_id);
      state.agents = patchAgent(state.agents, agent.id, patchWorker(agent, workerId, {
        sessionId: null,
        resumeSessionId: null,
        state: WORKER_STATE.IDLE,
      }));
      continue;
    }
    const driver = getDriver(agent.engine);
    if (typeof driver.reconcile !== 'function') continue;
    try {
      const result = await driver.reconcile({ ...agent, workerId }, options.repo, row.session_id);
      const live = result?.live === true;
      const next = patchWorker(state.agents[agent.id], workerId, {
        sessionId: live ? result.sessionId ?? row.session_id : null,
        resumeSessionId: result?.resumable === false ? null : row.session_id,
        state: live ? WORKER_STATE.RUNNING : (result?.state ?? WORKER_STATE.IDLE),
      });
      state.agents = patchAgent(state.agents, agent.id, {
        ...next,
        enabled: live ? true : agent.enabled,
      });
      store.saveWorkerSession(workerForSession(state.agents[agent.id], row.session_id));
      if (live && row.checkpoint_id) {
        const item = findItem(state.board, row.checkpoint_id);
        if (item?.lease?.workerId === workerId && item.lease.state === 'running') {
          workerLeases.restore(item.lease);
        }
      } else if (row.checkpoint_id) {
        const item = findItem(state.board, row.checkpoint_id);
        if (item?.lease?.workerId === workerId && item.lease.state === 'running') {
          const failedGate = Object.entries(item.gates ?? {})
            .find(([, gateState]) => gateState === 'fail')?.[0] ?? null;
          const evidence = [...(item.evidence ?? [])].reverse()
            .find((entry) => entry.state === 'fail');
          const settled = failedGate && !isVerificationCheckpoint(item)
            ? reviseItem(state.board, item.id, {
              lease: finishLease(item.lease, 'failed'),
              paused: true,
              pauseReason: evidence?.receipt || `${failedGate} failed before restart`,
            })
            : failCheckpointStart(
              state.board,
              item.id,
              'worker session ended before the checkpoint reported completion',
              Date.now() + 15_000,
            );
          if (!settled.error) {
            state.board = settled.board;
            store.saveItem(settled.item);
          }
        }
      }
    } catch {
      state.agents = patchAgent(state.agents, agent.id, patchWorker(agent, workerId, {
        sessionId: null,
        state: WORKER_STATE.IDLE,
      }));
    }
  }
}

// ---------------------------------------------------------------- ingestion

// An agent's report arrives inside its prose. Pulling it out here means both
// engines produce the same flows and claims without either CLI having to
// support a schema flag.
const REPORT_BLOCK = new RegExp('```' + REPORT_FENCE + '\\s*([\\s\\S]*?)```');
const WORK_PLAN_BLOCK = new RegExp('```' + WORK_PLAN_FENCE + '\\s*([\\s\\S]*?)```');

// The orchestrator's answer to "what should each of them be doing".
async function harvestWorkPlan(event) {
  if (state.completedAt) return { applied: false, error: 'mission is complete' };
  const assemblyId = state.assembly?.id ?? null;
  const match = WORK_PLAN_BLOCK.exec(String(event.payload?.text ?? ''));
  if (!match) {
    if (assemblyId) failAssembly(assemblyId, 'Thor finished without a valid work plan');
    return { applied: false, error: 'no assemble payload' };
  }
  if (!assemblyId) return { applied: false, error: 'no active assemble attempt' };

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    if (assemblyId) failAssembly(assemblyId, 'Thor returned a work plan that is not valid JSON');
    return { applied: false, error: 'assemble payload is not valid JSON' };
  }

  if (!['local', 'publish'].includes(parsed.delivery)) {
    if (assemblyId) failAssembly(assemblyId, 'Thor returned a work plan without a valid delivery mode');
    return { applied: false, error: 'assemble needs delivery: local or publish' };
  }

  // Who the mission needs. An agent taken off sits it out entirely: startCrew
  // skips anything disabled, so this is the orchestrator sizing its own crew.
  // No crew call is a failed assemble, not a partial one. Silently leaving
  // everyone on is how a two-hero mission ends up with seven idle seats.
  const crewSpec = parsed.crew ?? null;
  const named = Object.keys(crewSpec ?? {}).length;
  const expected = Object.values(state.agents)
    .filter((agent) => agent.role !== ROLES.ORCHESTRATOR)
    .map((agent) => agent.id);
  const missing = crewSpec
    ? expected.filter((agentId) => !Object.hasOwn(crewSpec, agentId))
    : expected;
  const unknown = crewSpec
    ? Object.keys(crewSpec).filter((agentId) => !expected.includes(agentId))
    : [];
  if ((assemblyId || crewSpec) && (missing.length > 0 || unknown.length > 0)) {
    const problem = [
      missing.length > 0 && `missing ${missing.join(', ')}`,
      unknown.length > 0 && `unknown ${unknown.join(', ')}`,
    ].filter(Boolean).join('; ');
    ingest(createEvent(event.agentId, EVENT_KINDS.STATUS, {
      text: `assemble incomplete: ${problem}; the roster was not changed`,
      from: 'you',
    }));
    if (assemblyId) settleAssembly(assemblyId);
    return { applied: false, error: problem };
  }

  const crew = [];
  for (const [agentId, wanted] of Object.entries(crewSpec ?? {})) {
    const agent = state.agents[agentId];
    if (!agent || agent.role === ROLES.ORCHESTRATOR) continue;
    // A number is how many of that hero the work needs; a boolean is one or none.
    const copies = typeof wanted === 'number'
      ? Math.min(4, Math.max(0, Math.round(wanted)))
      : (wanted === true ? 1 : wanted === false ? 0 : null);
    if (copies === null) continue;

    const enabled = copies > 0;
    const instances = Math.max(1, copies);
    const changed = agent.enabled !== enabled || agent.instances !== instances;
    if (changed) state.agents = patchAgent(state.agents, agentId, { enabled, instances });
    if (changed) {
      crew.push(enabled
        ? `+${agent.label ?? agentId}${instances > 1 ? ` x${instances}` : ''}`
        : `-${agent.label ?? agentId}`);
    }
  }
  if (crew.length) {
    ingest(createEvent(event.agentId, EVENT_KINDS.STATUS, {
      text: `crew for this mission: ${crew.join(' ')}`,
      from: 'you',
    }));
  }

  const activeBeforeRegroup = itemsOf(state.board)
    .filter((item) => item.lease?.state === 'running')
    .map((item) => ({ id: item.id, agentId: item.lease.agentId, workerId: item.lease.workerId }));
  const required = [...new Set((parsed.workUnits ?? []).flatMap((unit) =>
    (unit.stages ?? [])
      .filter((stage) => stage.required !== false)
      .flatMap((stage) => STAGE_GATES[stage.stage] ?? [])))];
  if (parsed.delivery === 'publish') required.push('prepush', 'push');
  const nextAcceptance = createAcceptancePolicy({ required });
  const planned = workPlanning.publishWorkPlan(parsed.workUnits, nextAcceptance);
  if (planned.error) {
    ingest(createEvent(event.agentId, EVENT_KINDS.STATUS, {
      text: `assemble refused: ${planned.error}; nobody was started`,
      from: 'you',
    }));
    if (assemblyId) settleAssembly(assemblyId);
    return { applied: false, error: planned.error };
  }
  state.acceptance = nextAcceptance;
  store.saveMissionState({ acceptance: state.acceptance, completedAt: null });
  for (const previous of activeBeforeRegroup) {
    const current = findItem(state.board, previous.id);
    if (current?.lease?.workerId === previous.workerId && current.lease.state === 'running') continue;
    await interruptWorker(previous.agentId, previous.workerId, { clearCheckpoint: true }).catch(() => {});
  }

  let applied = 0;
  for (const agentId of expected) {
    const outcomes = parsed.workUnits
      .filter((unit) => unit.stages.some((stage) => stage.required !== false && stage.owner === agentId))
      .map((unit) => unit.outcome);
    if (outcomes.length === 0) continue;
    const objective = `Done when your required stages pass for: ${outcomes.join('; ')}`;
    state.goals = setGoal(state.goals, agentId, objective, null, 'active', 'derived');
    store.saveGoal(agentId, getGoal(state.goals, agentId));
    orders(agentId, objective, ORDER_ACTION.GOAL);
    applied += 1;
  }
  if (named > 0) {
    await startCrew(`${event.agentId} assembled ${named} Avengers`, true, crewSpec);
  } else if (applied > 0) {
    await startCrew(`${event.agentId} set goals for ${applied} agents`);
  } else if (assemblyId) {
    failAssembly(assemblyId, 'Thor returned a plan with no runnable crew or goals');
    return { applied: false, error: 'assemble plan has no runnable crew or goals' };
  }
  return { applied: true, avengers: named, goals: applied };
}

function harvestReport(event) {
  const match = REPORT_BLOCK.exec(String(event.payload?.text ?? ''));
  if (!match) return;

  let report;
  try {
    report = JSON.parse(match[1]);
  } catch {
    return; // a malformed block is not a report; the prose still stands
  }

  // The fallback has the same destination as the MCP tool: Thor. It is not a
  // human decision and must not enter Mac's queue.
  const plea = typeof report.escalate === 'string'
    ? { why: report.escalate, needs: 'unblock' }
    : report.escalate;
  if (plea?.why && String(plea.why).trim()) {
    const need = ['decision', 'unblock', 'conflict'].includes(plea.needs)
      ? plea.needs
      : 'decision';
    const worker = event.payload?.workerId
      ? ensureWorkers(state.agents[event.agentId]).find(
        (candidate) => candidate.id === event.payload.workerId,
      )
      : null;
    void coordination.escalate({
      fromAgentId: event.agentId,
      fromWorkerId: event.payload?.workerId ?? null,
      checkpointId: plea.checkpointId ?? worker?.checkpointId ?? null,
      needs: need,
      why: String(plea.why).trim(),
      involvedAgentId: plea.agent ?? null,
      receipt: plea.receipt ?? '',
    }).catch(() => {});
  }

  // A worker can ask to stand down, but one worker must not stop every session
  // behind a shared seat. Apply that request after checkpoint moves, when the
  // server can see whether the whole assigned batch is complete.
  const done = report.standDown;

  const completedWork = [];
  const failedWork = [];
  // Gate moves. This is the only way the board changes from a worker, and
  // board.mjs refuses anything out of order or without a receipt - so an agent
  // cannot report a push over untested code however confidently it tries.
  for (const move of report.gates ?? []) {
    const reportingWorker = event.payload?.workerId
      ? ensureWorkers(state.agents[event.agentId])
        .find((candidate) => candidate.id === event.payload.workerId)
      : null;
    const ownedMove = reportingWorker?.checkpointId
      ? { ...move, item: reportingWorker.checkpointId }
      : move;
    const result = workBoard.updateCheckpoint(
      event.agentId,
      ownedMove,
      event.payload?.workerId ?? null,
    );
    if (result.error) continue;
    if (result.item.closedAt) completedWork.push(result.item);
    if (ownedMove.state === 'fail') failedWork.push({ item: result.item, move: ownedMove });
  }

  for (const failure of failedWork) {
    // Verification can discover new correction work. An implementation
    // checkpoint is already that correction work, so a failure stays on it
    // and waits for an explicit retry instead of creating repairs forever.
    if (!isVerificationCheckpoint(failure.item)) {
      const paused = reviseItem(state.board, failure.item.id, {
        paused: true,
        pauseReason: failure.move.receipt || `${failure.move.gate} failed`,
      });
      if (!paused.error) {
        state.board = paused.board;
        store.saveItem(paused.item);
      }
      if (event.payload?.workerId) workerLeases?.clear(event.payload.workerId);
      continue;
    }
    const discoveries = (report.discoveries ?? [])
      .filter((finding) => !finding.checkpointId || finding.checkpointId === failure.item.id);
    const findings = discoveries.length ? discoveries : [{
      id: `${failure.move.gate}-failure`,
      checkpointId: failure.item.id,
      title: `Fix ${failure.item.title}`,
      outcome: `${failure.item.outcome} passes ${failure.move.gate} verification.`,
      scope: failure.item.scope,
      files: failure.item.files ?? [],
      receipt: failure.move.receipt,
    }];
    const remediation = workBoard.addRemediation(failure.item.id, findings);
    if (remediation.error) {
      ingest(createBlockedEvent('minimac', {
        category: BLOCKED_REASONS.ERROR,
        reason: `could not own failure from ${failure.item.id}: ${remediation.error}`,
      }));
    }
    if (event.payload?.workerId) workerLeases?.clear(event.payload.workerId);
  }

  for (const claim of report.claims ?? []) {
    const text = String(claim?.text ?? claim?.claim ?? '').trim();
    if (!text) continue;
    ingest(createEvent(event.agentId, EVENT_KINDS.CLAIM, {
      ...claim, text, workerId: event.payload?.workerId ?? null,
    }));
  }
  const reportingWorker = event.payload?.workerId
    ? ensureWorkers(state.agents[event.agentId]).find((worker) => worker.id === event.payload.workerId)
    : null;
  const assignedIds = reportingWorker?.checkpointId
    ? [reportingWorker.checkpointId]
    : activeCheckpointIds(event.agentId);
  const assignedDone = assignedIds.length === 0 || assignedIds.every((id) => {
    const item = findItem(state.board, id);
    return item && isDone(item);
  });
  const isWorker = state.agents[event.agentId]?.role !== ROLES.ORCHESTRATOR;
  const askedToStop = Boolean(done?.why && String(done.why).trim());
  const shouldStop = isWorker && (
    failedWork.length > 0
    || (assignedDone && (completedWork.length > 0 || askedToStop))
  );
  if (askedToStop && !assignedDone) {
    ingest(createEvent(event.agentId, EVENT_KINDS.STATUS, {
      text: `one worker finished its slice: ${String(done.why).trim()}`,
      from: 'you',
    }));
  }
  if (shouldStop) {
    const why = askedToStop
      ? String(done.why).trim()
      : failedWork.length
        ? `verification failed on ${failedWork.map(({ item }) => item.id).join(', ')}; correction work is assigned`
        : `completed ${completedWork.map((item) => item.id).join(', ')}`;
    ingest(createEvent(event.agentId, EVENT_KINDS.STATUS, {
      text: `stood down: ${why}`,
      from: 'you',
    }));
    const stop = reportingWorker
      ? interruptWorker(event.agentId, reportingWorker.id)
      : COMMANDS.setActive({ agentId: event.agentId, active: false });
    stop
      .then(() => {
        publish({ type: 'state', state: snapshot() });
        scheduleReadyWork();
      })
      .catch(() => {});
  }
}

// Every fenced block an agent may emit. These are payload for the tool, never
// speech: they are parsed here and stripped before anything is shown.
const FENCES = [REPORT_FENCE, WORK_PLAN_FENCE, VERDICT_FENCE];

function partitionAgentOutput(event) {
  if (event.kind !== EVENT_KINDS.ENGINE_OUTPUT) return { event, raw: null };
  // Draft output is temporary adapter state. Only the complete answer becomes
  // a message or is inspected for machine report blocks.
  if (event.payload?.final !== true) return { event, raw: null };
  const buffer = String(event.payload?.text ?? '');
  const { prose, open } = splitFenced(buffer, FENCES, false, true);

  // A block that has closed is complete and can be parsed. Nothing is parsed
  // while one is still open, which is why a split report used to be dropped.
  const raw = open ? null : buffer;
  if (!prose || isMachineNoise(prose)) return { event: null, raw };
  return { event: { ...event, payload: { ...event.payload, text: prose } }, raw };
}

function identifyWorker(event) {
  if (!event?.agentId) return event;
  const sessionId = event.payload?.sessionId;
  const worker = event.payload?.workerId
    ? ensureWorkers(state.agents[event.agentId])
      .find((candidate) => candidate.id === event.payload.workerId)
    : sessionId && workerForSession(state.agents[event.agentId], sessionId);
  return worker
    ? { ...event, payload: { ...event.payload, workerId: worker.id, checkpointId: worker.checkpointId } }
    : event;
}

function conversationContextForAgentOutput(event) {
  const repliedTo = new Set(state.events
    .filter((candidate) => candidate.payload?.message?.authorId === event.agentId)
    .map((candidate) => candidate.payload?.message?.replyToMessageId)
    .filter(Boolean));
  const question = [...state.events].reverse().find((candidate) => {
    const message = candidate.payload?.message;
    return message
      && message.authorId !== event.agentId
      && message.recipients?.includes(event.agentId)
      && !repliedTo.has(message.id);
  })?.payload?.message;
  if (question?.context) return question.context;
  return event.payload?.checkpointId
    ? { kind: CONTEXT_KIND.CHECKPOINT, id: event.payload.checkpointId }
    : { kind: CONTEXT_KIND.MISSION, id: String(store.runId) };
}

function persistEventWorker(event) {
  const workerId = event.payload?.workerId;
  if (!workerId) return;
  const worker = ensureWorkers(state.agents[event.agentId]).find((candidate) => candidate.id === workerId);
  if (worker) store.saveWorkerSession(worker);
}

function acceptsWorkerEvent(event) {
  const workerId = event.payload?.workerId;
  const sessionId = event.payload?.sessionId;
  if (!workerId && !sessionId) return true;
  const agent = state.agents[event.agentId];
  const worker = workerId
    ? ensureWorkers(agent).find((candidate) => candidate.id === workerId)
    : workerForSession(agent, sessionId);
  if (!worker || !isCurrentSessionEvent(worker, event.payload)) return false;
  const checkpointId = event.payload?.checkpointId ?? worker.checkpointId;
  if (!checkpointId) return true;
  if (worker.checkpointId && worker.checkpointId !== checkpointId) return false;
  const item = findItem(state.board, checkpointId);
  if (!item) return false;
  if (item.lease?.workerId && item.lease.workerId !== worker.id) return false;
  const terminalWorkerStatus = event.kind === EVENT_KINDS.STATUS
    && [WORKER_STATE.IDLE, WORKER_STATE.STOPPED, WORKER_STATE.FAILED]
      .includes(event.payload?.state);
  return !isClosed(item) || terminalWorkerStatus;
}

function settleEventLease(event) {
  const workerId = event.payload?.workerId;
  if (!workerId) return;
  const worker = ensureWorkers(state.agents[event.agentId])
    .find((candidate) => candidate.id === workerId);
  if (!isCurrentSessionEvent(worker, event.payload)) return;
  const checkpointId = event.payload?.checkpointId ?? worker.checkpointId;
  const item = checkpointId && findItem(state.board, checkpointId);
  if (!item?.lease || item.lease.state !== 'running' || item.lease.workerId !== workerId) return;
  if (item.lease.sessionId && event.payload?.sessionId
    && item.lease.sessionId !== event.payload.sessionId) return;
  const retryAt = event.ts + 15_000;
  const settled = isClosed(item)
    ? reviseItem(state.board, checkpointId, {
      lease: finishLease(item.lease, event.payload.state, event.ts),
    })
    : failCheckpointStart(
      state.board,
      checkpointId,
      `worker ${event.payload.state}; MINIMAC will retry`,
      retryAt,
    );
  if (settled.error) return;
  state.board = settled.board;
  store.saveItem(settled.item);
  if (!isClosed(item)) {
    const timer = setTimeout(scheduleReadyWork, Math.max(0, retryAt - Date.now()));
    timer.unref?.();
  }
}

function hasValidCheckpointReport(event) {
  const match = REPORT_BLOCK.exec(blockText(event));
  if (!match) return false;
  try {
    JSON.parse(match[1]);
    return true;
  } catch {
    return false;
  }
}

function settleUnreportedResult(event) {
  if (hasValidCheckpointReport(event)) return false;
  const workerId = event.payload?.workerId;
  if (!workerId) return false;
  const worker = ensureWorkers(state.agents[event.agentId])
    .find((candidate) => candidate.id === workerId);
  if (!worker || !isCurrentSessionEvent(worker, event.payload)) return false;
  const checkpointId = event.payload?.checkpointId ?? worker.checkpointId;
  const item = checkpointId && findItem(state.board, checkpointId);
  if (!item?.lease || item.lease.state !== 'running' || item.lease.workerId !== workerId) return false;
  const text = blockText(event).trim().replace(/\s+/g, ' ').slice(0, 300);
  const settled = reviseItem(state.board, checkpointId, {
    lease: finishLease(item.lease, 'unreported', event.ts),
    paused: true,
    pauseReason: text
      ? `worker ended without a checkpoint report: ${text}`
      : 'worker ended without a checkpoint report',
  });
  if (settled.error) return false;
  workerLeases?.clear(workerId);
  state.board = settled.board;
  store.saveItem(settled.item);
  ingest(createEvent(event.agentId, EVENT_KINDS.STATUS, {
    text: `${checkpointId} paused: worker ended without a checkpoint report`,
    checkpointId,
    workerId,
    sessionId: event.payload?.sessionId ?? null,
    launchId: event.payload?.launchId ?? null,
    from: 'you',
  }));
  return true;
}

function repeatsUnchangedFact(event, withinMs = 300_000) {
  if (![EVENT_KINDS.STATUS, EVENT_KINDS.BLOCKED].includes(event.kind)) return false;
  const facts = event.payload ?? {};
  const signature = JSON.stringify([
    event.agentId, event.kind, facts.state ?? null, facts.text ?? null,
    facts.reason ?? null, facts.checkpointId ?? null,
  ]);
  const previous = [...state.events].reverse().find((candidate) =>
    candidate.agentId === event.agentId && candidate.kind === event.kind);
  if (!previous || event.ts - previous.ts > withinMs) return false;
  const prior = previous.payload ?? {};
  return signature === JSON.stringify([
    previous.agentId, previous.kind, prior.state ?? null, prior.text ?? null,
    prior.reason ?? null, prior.checkpointId ?? null,
  ]);
}

function ingest(rawIncoming) {
  const incoming = identifyWorker(rawIncoming);
  if (!acceptsWorkerEvent(incoming)) return;
  // Engine adapters can announce IDLE before they deliver the turn result.
  // IDLE means the session can accept another turn; it does not mean the
  // checkpoint lease is over. Closing the lease here made the final report
  // arrive one event too late and fail its stable worker-identity check.
  if (incoming.kind === EVENT_KINDS.STATUS
    && [WORKER_STATE.STOPPED, WORKER_STATE.FAILED, WORKER_STATE.STALE]
      .includes(incoming.payload?.state)) {
    const worker = incoming.payload?.workerId
      ? ensureWorkers(state.agents[incoming.agentId])
        .find((candidate) => candidate.id === incoming.payload.workerId)
      : workerForSession(state.agents[incoming.agentId], incoming.payload?.sessionId);
    if (isCurrentSessionEvent(worker, incoming.payload)) {
      workerLeases?.clear(worker.id);
      settleEventLease(incoming);
    }
  }
  // A result carries its text in its own envelope and is never split, so it
  // goes straight to the parsers.
  if (incoming.kind === EVENT_KINDS.RESULT) {
    state.events = appendEvent(state.events, incoming);
    state.agents = applyFleetEvent(state.agents, incoming);
    persistEventWorker(incoming);
    store.record(incoming);
    publish({
      type: 'event',
      runId: store.runId,
      event: incoming,
      agent: publicAgent(state.agents[incoming.agentId]),
    });
    harvestBlocks(incoming);
    settleUnreportedResult(incoming);
    scheduleCards();
    return;
  }

  const { event, raw } = partitionAgentOutput(incoming);
  // Payload with no prose still has to be parsed - it just is not said aloud.
  if (!event) {
    if (raw) harvestBlocks({ ...incoming, payload: { ...incoming.payload, text: raw } });
    return;
  }
  if (event.kind === EVENT_KINDS.ENGINE_OUTPUT) {
    if (raw) harvestBlocks({ ...event, payload: { ...event.payload, text: raw } });
    conversations?.acceptAgentOutput(event, conversationContextForAgentOutput(event));
    return;
  }
  if (raw !== null) event.payload = { ...event.payload, raw };
  if (repeatsUnchangedFact(event)) {
    state.agents = applyFleetEvent(state.agents, event);
    persistEventWorker(event);
    return;
  }
  state.events = appendEvent(state.events, event);
  state.agents = applyFleetEvent(state.agents, event);
  persistEventWorker(event);
  store.record(event);
  publish({
    type: 'event',
    runId: store.runId,
    event,
    agent: publicAgent(state.agents[event.agentId]),
  });
  if (raw !== null) harvestBlocks({ ...event, payload: { ...event.payload, text: raw } });
  scheduleCards();
}

// Thor telling a hero something is an event in the ROOM, not just a row in a
// table: the floor walks him over and has him say it. Every outbound act of
// his goes through here, so a goal, an assignment and a ruling all look the
// same on the floor.
let coordination = null;
let conversations = null;
let workspaceQuery = null;
let scheduler = null;
let runtimeSupervisor = null;
let schedulerQueued = false;

function scheduleReadyWork() {
  if (!scheduler || schedulerQueued || state.completedAt) return;
  schedulerQueued = true;
  queueMicrotask(() => {
    schedulerQueued = false;
    void scheduler.reconcile()
      .then((started) => {
        if (started.length > 0) publish({ type: 'state', state: snapshot() });
      })
      .catch((error) => ingest(createBlockedEvent('minimac', {
        category: BLOCKED_REASONS.ERROR,
        reason: `ready work could not start: ${error.message}`,
      })));
  });
}

function orders(toAgentId, text, action = ORDER_ACTION.STEER, checkpointId = null) {
  const boss = Object.values(state.agents).find((a) => a.role === ROLES.ORCHESTRATOR);
  if (!boss || !state.agents[toAgentId] || toAgentId === boss.id) return;
  if (!String(text ?? '').trim()) return;
  coordination?.order({
    fromAgentId: boss.id,
    toAgentId,
    action,
    checkpointId,
    text: String(text).trim(),
    revision: checkpointId ?? String(text).trim(),
  });
}

const workBoard = createWorkBoard({
  getBoard: () => state.board,
  setBoard: (board) => { state.board = board; },
  getAgents: () => state.agents,
  saveItem: (item) => store.saveItem(item),
  saveBoard: (board) => store.saveWorkPlan(board),
  activateOwner: (agentId) => {
    state.agents = patchAgent(state.agents, agentId, { enabled: true });
  },
  emit: ingest,
  order: orders,
  onChange: reconcileMissionCompletion,
  missionComplete: () => Boolean(state.completedAt),
  workerLimitMs: LEASE_LIMIT_MS,
});

function reconcileMissionCompletion() {
  if (!missionIsComplete(state.acceptance, state.board)) {
    scheduleReadyWork();
    return false;
  }
  if (state.completedAt) return true;
  state.completedAt = Date.now();
  store.saveMissionState({
    acceptance: state.acceptance,
    board: state.board,
    completedAt: state.completedAt,
  });
  ingest(createEvent('minimac', EVENT_KINDS.STATUS, {
    state: 'complete',
    text: 'mission complete: every required acceptance gate passed',
    from: 'you',
  }));
  return true;
}

const workPlanning = createWorkPlanningService({
  getBoard: () => state.board,
  setBoard: (board) => { state.board = board; },
  getAgents: () => state.agents,
  getAcceptance: () => state.acceptance,
  saveWorkPlan: (board) => store.saveWorkPlan(board),
  workerLimitMs: LEASE_LIMIT_MS,
});

// Close the open prayer on this agent, if there is one. Recorded as an event
// so the answer is in the run's history beside the question.
function answerPrayer(agentId, text) {
  const open = prayerOf(indexByAgent(state.events)[agentId] ?? []);
  if (!open?.why) return false;
  ingest(createEvent(agentId, EVENT_KINDS.PRAYER, {
    ...open,
    answered: true,
    answer: String(text ?? '').trim(),
  }));
  return true;
}

// A block already parsed is not parsed again. Codex re-sends a completed reply
// as a final event, so the same goals block arrived twice and put every item
// on the board twice.
const harvested = new Map();

// The parsers all read the same reassembled text.
//
// A fenced block can arrive as streamed prose OR inside the final result an
// engine sends when a turn closes - Codex uses the latter for its last word.
// Reading only messages meant a whole assemble answer, crew decision and all,
// was produced and thrown away.
function blockText(event) {
  return String(event.payload?.text ?? event.payload?.report?.text ?? '');
}

function harvestBlocks(event) {
  const text = blockText(event);
  const isAssemblyResult = Boolean(state.assembly)
    && state.agents[event.agentId]?.role === ROLES.ORCHESTRATOR
    && [EVENT_KINDS.RESULT, EVENT_KINDS.ENGINE_OUTPUT].includes(event.kind)
    && (event.kind === EVENT_KINDS.RESULT || event.payload?.final === true);
  if (!text.includes('```') && !isAssemblyResult) return; // nothing fenced, nothing to parse
  const seen = harvested.get(event.agentId);
  if (seen === text) return;
  harvested.set(event.agentId, text);

  // Every parser reads the same normalised text, whichever envelope carried it.
  const carrying = { ...event, payload: { ...event.payload, text } };
  harvestReport(carrying);
  void harvestWorkPlan(carrying).catch(() => {});
  harvestVerdicts(carrying);
}

// ----------------------------------------------------------------- monitor

// Every event passes through ingest(), so nothing has to poll to know what the
// fleet is doing. Deriving on each one would run the detectors hundreds of
// times a second during a busy turn, so the pass is coalesced.
const CARD_DEBOUNCE_MS = 250;
let cardTimer = null;

function scheduleCards() {
  if (cardTimer) return;
  cardTimer = setTimeout(() => {
    cardTimer = null;
    refreshCards();
  }, CARD_DEBOUNCE_MS);
}

function refreshCards() {
  const before = state.cards;
  const now = Date.now();
  const derived = deriveCards(
    Object.values(state.agents),
    indexByAgent(state.events),
    state.board,
    now,
  );
  const liveKeys = new Set(derived.map(cardKey));
  for (const key of state.dismissedCards) {
    if (!liveKeys.has(key)) state.dismissedCards.delete(key);
  }
  const next = stampCards(
    before,
    derived.filter((card) => !state.dismissedCards.has(cardKey(card))),
    now,
  );
  const { raised, cleared } = diffCards(before, next);
  state.cards = next;

  // A verdict outlives nothing: when the condition clears, so does the ruling.
  for (const card of cleared) delete state.verdicts[cardKey(card)];

  if (raised.length || cleared.length) {
    publish({ type: 'state', state: snapshot() });
    if (raised.length) void governanceTurn(raised);
  }
  return { raised, cleared };
}

// ---------------------------------------------------------------- governance

// The room decides WHEN something is worth a ruling; the orchestrator decides
// WHAT to do about it. He is woken only for cards nobody has seen, batched into
// one turn - a turn per card would cost a turn per card and let him answer the
// same condition three ways.
async function governanceTurn(raised) {
  if (state.governing) return; // one ruling at a time
  // Never interrupt an assemble. That turn IS the plan; cutting into it with a
  // ruling is how the plan came to be abandoned halfway through.
  if (state.assembly) return;
  const boss = Object.values(state.agents).find((a) => a.role === ROLES.ORCHESTRATOR);
  if (!boss || boss.enabled === false) return;

  // Nothing he could rule on: approvals are never his, nor is anything about
  // himself.
  const his = raised.filter((card) => routeCard(card, null, boss.id).toThor);
  if (his.length === 0) return;

  state.governing = true;
  // Say it on the floor. A ruling happening off-screen is the same as no
  // ruling: you cannot govern what you cannot see being governed.
  ingest(createEvent(boss.id, EVENT_KINDS.STATUS, {
    text: `ruling on ${his.length} card${his.length === 1 ? '' : 's'}: `
      + his.map((card) => `${card.agentName ?? card.agentId} ${card.kind}`).join(', '),
    from: 'you',
  }));
  try {
    const task = governanceTask(his, crewRoster());
    if (hasLiveWorker(boss)) {
      const sent = await eachSession(boss, (id) =>
        getDriver(boss.engine).steer(
          id,
          composeDispatch(promptContext(boss, task, { exclusiveOutput: true })),
        ));
      if (!sent.delivered) throw new Error(sent.failures[0] ?? 'the engine took nothing');
    } else {
      await COMMANDS.start({ agentId: boss.id, task, exclusiveOutput: true });
    }
  } catch (error) {
    // Never silent. A governance turn that failed is a fleet nobody is
    // watching, and that has to reach you rather than a swallowed catch.
    ingest(createBlockedEvent(boss.id, {
      category: BLOCKED_REASONS.ERROR,
      reason: `could not rule on ${his.length} cards: ${error.message}`,
    }));
  } finally {
    state.governing = false;
  }
}

// His answer, pulled out of his prose like every other block.
function harvestVerdicts(event) {
  const keys = new Set(state.cards.map(cardKey));
  const verdicts = parseVerdicts(event.payload?.text ?? '', { keys });
  if (verdicts.length === 0) return;
  for (const verdict of verdicts) applyVerdict(verdict).catch(() => {});
}

// Only ever the verbs the floor already has, so nothing here can do something
// you could not undo from the room.
async function applyVerdict(verdict) {
  verdict = guardVerdict(verdict, state.board);
  state.verdicts[verdict.id] = verdict;

  const agent = state.agents[verdict.agentId];
  const who = agent?.label ?? verdict.agentId;

  // Holding and escalating are answers, not actions - they only annotate.
  if (verdict.action === VERDICT.HOLD || verdict.action === VERDICT.ESCALATE) {
    ingest(createEvent('minimac', EVENT_KINDS.STATUS, {
      text: `${verdict.action} on ${who}: ${verdict.note || 'no reason given'}`,
      from: 'you',
    }));
    publish({ type: 'state', state: snapshot() });
    return;
  }

  if (verdict.action === VERDICT.STEER) {
    await COMMANDS.steer({ agentId: verdict.agentId, text: verdict.text });
    orders(verdict.agentId, verdict.text);
  } else if (verdict.action === VERDICT.GOAL) {
    await COMMANDS.setGoal({ agentId: verdict.agentId, objective: verdict.text });
  } else if (verdict.action === VERDICT.BENCH) {
    await COMMANDS.setActive({ agentId: verdict.agentId, active: false });
  } else if (verdict.action === VERDICT.START) {
    await COMMANDS.setActive({ agentId: verdict.agentId, active: true });
    orders(verdict.agentId, verdict.text || 'Start your next ready checkpoint', ORDER_ACTION.START);
  }
  ingest(createEvent('minimac', EVENT_KINDS.STATUS, {
    text: `${verdict.action} on ${who}: ${verdict.note || verdict.text}`,
    from: 'you',
  }));
  publish({ type: 'state', state: snapshot() });
}

// One seat, one or more workers. Each gets its own session and its own slice
// label, and every event still carries the seat's id - so the floor shows one
// desk while the work runs in parallel behind it.
async function startWorkers(agent, cwd, context) {
  const driver = getDriver(agent.engine);
  const available = freeWorkers(agent);
  const started = [];

  for (const [index, { prompt }] of workerDispatches(context).entries()) {
    const worker = available[index];
    if (!worker) break;
    const checkpointId = context.workItems?.[index]?.id ?? null;
    const startingAt = Date.now();
    const launchId = randomUUID();
    state.agents = patchAgent(
      state.agents,
      agent.id,
      patchWorker(state.agents[agent.id], worker.id, {
        checkpointId,
        engine: agent.engine,
        state: WORKER_STATE.STARTING,
        startedAt: startingAt,
        heartbeatAt: startingAt,
        failureReason: null,
        launchId,
      }),
    );
    // The lease exists before the engine can emit its first event. Fast turns
    // can finish before start() returns, and their report must still belong to
    // the exact checkpoint that launched them.
    if (checkpointId) {
      const lease = workerLeases.start({
        agentId: agent.id,
        workerId: worker.id,
        checkpointId,
        sessionId: null,
      });
      const leased = beginCheckpoint(state.board, checkpointId, lease);
      if (!leased.error) {
        state.board = leased.board;
        store.saveItem(leased.item);
      }
    }
    const resumableId = worker.resumeSessionId;
    const canResume = canResumeSession(worker, { engine: agent.engine, checkpointId })
      && typeof driver.resume === 'function';
    const workerAgent = { ...agent, workerId: worker.id, launchId };
    let sessionId;
    try {
      if (!canResume) {
        sessionId = await driver.start(workerAgent, cwd, prompt);
      } else {
        sessionId = await driver.resume(workerAgent, cwd, resumableId, prompt);
      }
    } catch (resumeError) {
      if (canResume) {
        // A saved handle can disappear. Clear only this worker's handle, then
        // start its replacement without changing another worker at the seat.
        state.agents = patchAgent(
          state.agents,
          agent.id,
          patchWorker(state.agents[agent.id], worker.id, { resumeSessionId: null }),
        );
        try {
          sessionId = await driver.start(workerAgent, cwd, prompt);
        } catch (startError) {
          state.agents = patchAgent(
            state.agents,
            agent.id,
            patchWorker(state.agents[agent.id], worker.id, {
              state: WORKER_STATE.FAILED,
              sessionId: null,
              failureReason: startError.message,
            }),
          );
          throw startError;
        }
      } else {
        state.agents = patchAgent(
          state.agents,
          agent.id,
          patchWorker(state.agents[agent.id], worker.id, {
            state: WORKER_STATE.FAILED,
            sessionId: null,
            failureReason: resumeError.message,
          }),
        );
        throw resumeError;
      }
    }
    const now = Date.now();
    const currentWorker = ensureWorkers(state.agents[agent.id])
      .find((candidate) => candidate.id === worker.id);
    const endedDuringStart = [WORKER_STATE.IDLE, WORKER_STATE.STOPPED, WORKER_STATE.FAILED]
      .includes(currentWorker?.state);
    const nextWorker = {
      ...currentWorker,
      sessionId: endedDuringStart ? null : sessionId,
      resumeSessionId: endedDuringStart ? sessionId : null,
      checkpointId,
      engine: agent.engine,
      state: endedDuringStart ? currentWorker.state : WORKER_STATE.RUNNING,
      startedAt: now,
      heartbeatAt: now,
      failureReason: null,
      launchId,
    };
    state.agents = patchAgent(
      state.agents,
      agent.id,
      patchWorker(state.agents[agent.id], worker.id, nextWorker),
    );
    store.saveWorkerSession(nextWorker);
    if (checkpointId) {
      const item = findItem(state.board, checkpointId);
      if (item?.lease?.state === 'running' && item.lease.workerId === worker.id) {
        const updated = reviseItem(state.board, checkpointId, {
          lease: { ...item.lease, sessionId },
        });
        if (!updated.error) {
          state.board = updated.board;
          store.saveItem(updated.item);
        }
      }
    }
    started.push(nextWorker);
  }
  return started;
}

// A steer reaches every worker behind the seat, not just the first. It returns
// how many sessions actually took it: swallowing the driver error here is what
// let a message be shown on the floor as delivered while the engine had thrown
// it away - a claim with no receipt, which is the one thing this tool exists
// to stop.
async function eachSession(agent, action) {
  const ids = ensureWorkers(agent).map((worker) => worker.sessionId).filter(Boolean);
  let delivered = 0;
  const failures = [];
  for (const id of ids) {
    try {
      await action(id);
      delivered += 1;
    } catch (error) {
      failures.push(error?.message ?? String(error));
    }
  }
  return { delivered, failures, attempted: ids.length };
}

// What every agent is told about everyone else: who they are, what they are on,
// and what they own.
function crewRoster() {
  return Object.values(state.agents).map((agent) => ({
    id: agent.id,
    label: agent.label ?? agent.name,
    role: agent.role,
    engine: agent.engine,
    instances: agent.instances,
    objective: getGoal(state.goals, agent.id)?.objective ?? '',
    // Whether they are currently ON this mission. Without it the orchestrator
    // is judging who is needed without knowing who is already stood down.
    enabled: agent.enabled !== false,
    active: isActive(agent),
    capabilities: { localShell: true, browserControl: false },
    claims: state.claims[agent.id] ?? [],
  }));
}

function readyWork(agentId) {
  const agent = state.agents[agentId];
  return readyCheckpoints(state.board, agentId, {
    limitMs: LEASE_LIMIT_MS,
    capacity: freeWorkers(agent).length,
  });
}

function checkpointTask(item) {
  return [
    `# Assigned task: ${item.id}`,
    item.workUnitId ? `Work unit: ${item.workUnitId}` : null,
    item.stage ? `Stage: ${item.stage.toUpperCase()}` : null,
    '',
    item.title,
    '',
    `Execution plan: ${item.plan}`,
    `Verifiable outcome: ${item.outcome}`,
    `Proof: ${item.verify}`,
    ...(item.files?.length ? [
      '',
      'Files this checkpoint owns:',
      ...item.files.map((file) => `- ${file}`),
      'These checkpoint files replace any older file assignment in the saved goal.',
    ] : []),
    '',
    'Finish this task within eight minutes. Report the gate receipts, then stand down.',
  ].filter((line) => line !== null).join('\n');
}

async function tellThor(from, text) {
  const boss = Object.values(state.agents).find((agent) => agent.role === ROLES.ORCHESTRATOR);
  if (!boss) return null;
  return COMMANDS.say({ target: boss.id, text, from });
}

// Every first dispatch and every steer reads the same live state through this
// one context builder. A caller may change the task or select an exclusive
// output fence, but it cannot silently omit the board, goal, crew, or history.
function promptContext(agent, task, {
  mentions = null,
  attachments = [],
  exclusiveOutput = false,
  goal = null,
  claims = null,
} = {}) {
  return {
    agent,
    goal: goal ?? getGoal(state.goals, agent.id),
    task: task ?? state.mission,
    skills: options.skills,
    claims: claims ?? state.claims[agent.id] ?? [],
    steps: [],
    board: state.board,
    mentions,
    attachments: [...(state.attachments ?? []), ...attachments],
    crew: crewRoster(),
    team: options.team,
    hook: options.hookText,
    overrides: middleware,
    handoff: store.handoffFor(agent.id),
    exclusiveOutput,
  };
}

// What a step currently says: the override if there is one, otherwise the
// built-in default, otherwise whatever was loaded from a file at launch.
function middlewareText(name) {
  if (typeof middleware[name] === 'string') return middleware[name];
  if (name === 'hook') return options.hookText ?? '';
  return defaultStepText(name);
}

const PLANNING_TIMEOUT_MS = 180_000;

function settleAssembly(id) {
  if (!state.assembly || state.assembly.id !== id) return false;
  if (state.assembly.timer) clearTimeout(state.assembly.timer);
  state.assembly = null;
  return true;
}

function failAssembly(id, reason) {
  if (!settleAssembly(id)) return false;
  ingest(createBlockedEvent('minimac', {
    category: BLOCKED_REASONS.ERROR,
    reason: `assemble failed: ${reason}`,
  }));
  return true;
}

// Start everyone except the orchestrator, which is already running.
async function startCrew(note, assembled = true, desired = null) {
  const assemblyId = state.assembly?.id ?? null;
  if (!assemblyId && !desired) return;
  if (assemblyId) settleAssembly(assemblyId);
  ingest(
    createEvent('minimac', EVENT_KINDS.STATUS, {
      text: note ?? 'goals set by the orchestrator - starting the crew',
      from: 'you',
    }),
  );
  // An assemble that timed out has decided nothing. Starting the whole fleet
  // on role defaults is not a safe fallback - it is the seven idle seats you
  // pressed ASSEMBLE to avoid. Say so and start nobody.
  if (!assembled) {
    ingest(createEvent('minimac', EVENT_KINDS.BLOCKED, {
      reason: 'assemble failed: Thor did not publish a complete work plan. '
        + 'No worker was started.',
    }));
    return;
  }
  const changes = [];
  for (const decision of activationPlan(state.agents, state.board, desired)) {
    const agent = state.agents[decision.agentId];
    if (decision.shouldRun && !decision.running) {
      changes.push(COMMANDS.setActive({ agentId: agent.id, active: true }));
    } else if (decision.member && decision.running && !decision.shouldRun) {
      changes.push(interruptAgent(agent.id).then(() => {
        state.agents = patchAgent(state.agents, agent.id, projectWorkers({
          ...state.agents[agent.id], enabled: true,
        }));
      }));
    } else if (decision.member && agent.enabled === false) {
      state.agents = patchAgent(state.agents, agent.id, { enabled: true });
    } else if (!decision.member && agent.enabled !== false) {
      changes.push(COMMANDS.setActive({ agentId: agent.id, active: false }));
    }
  }
  await Promise.allSettled(changes);
  scheduleReadyWork();
  publish({ type: 'state', state: snapshot() });
}

// Agents read files from disk, so an attachment travels as a path plus enough
// description that the agent knows why it was given one.
function attachmentLines(attachments) {
  const lines = attachments.map((file) => `- ${file.path}  (${file.type}, ${file.name})`);
  return `Attached by the operator - open these before you begin:\n${lines.join('\n')}`;
}

// The only way to change one agent. Always reads the current record, so a
// long await can never resurrect a stale copy over it.
function patchAgent(agents, agentId, changes) {
  const current = agents[agentId];
  if (!current) return agents;
  return { ...agents, [agentId]: { ...current, ...changes } };
}

// One application path owns checkpoint conversation writes. UI commands and
// agent tools call this function; neither transport creates its own record.
async function writeConversation({
  context, text = '', attachments = [], replyToMessageId = null, from = 'you',
  authorId = 'you', recipients = [], wake = false,
}) {
  return conversations.post({
    authorId, context, recipients, body: text, attachments, replyToMessageId, from, wake,
  });
}

// ----------------------------------------------------------------- commands

const COMMANDS = {
  setAcceptance({ required }) {
    if (state.completedAt) throw new Error('mission is complete');
    ensureRun();
    const validated = validateAcceptancePolicy({ required });
    if (validated.error) throw new Error(validated.error);
    const reconciled = reconcileAcceptanceChange(
      state.acceptance,
      validated.policy,
      state.board,
    );
    state.acceptance = validated.policy;
    state.board = reconcileReleaseCheckpoints(reconciled.board, state.agents, state.acceptance);
    store.saveMissionState({ acceptance: state.acceptance, board: state.board, completedAt: null });
    reconcileMissionCompletion();
    publish({ type: 'state', state: snapshot() });
    return { acceptance: state.acceptance, removed: reconciled.removed };
  },

  // One mission in, a goal on every seat out. Nothing is ever dispatched blind.
  async setMission({ mission, attachments = [] }) {
    if (state.completedAt) throw new Error('start a new mission before changing the mission text');
    state.mission = mission;
    ensureRun();
    state.attachments = attachments;
    // The run is titled by its mission, and the mission usually arrives after
    // the run has started, so the record has to be told.
    store.renameRun(mission);
    store.saveMissionState({ acceptance: state.acceptance });
    state.goals = deriveGoals(state.goals, state.agents, mission);
    // The orchestrator's goal is the mission, always. A goal saved on an
    // earlier run - or the old role template - must never outrank the sentence
    // you just typed, which is exactly what happened while this was derived
    // like everyone else's.
    const boss = Object.values(state.agents).find((a) => a.role === ROLES.ORCHESTRATOR);
    if (boss) {
      state.goals = setGoal(state.goals, boss.id, mission, null, 'active', 'manual');
    }
    for (const [agentId, goal] of Object.entries(state.goals)) store.saveGoal(agentId, goal);
    // Say it out loud on the floor, so a submit is never silent.
    await writeConversation({
      context: { kind: CONTEXT_KIND.MISSION, id: String(store.runId) },
      text: `mission set: ${mission}`, attachments, from: 'you', authorId: 'you',
    });
    // A new mission is a new crew. Setting a goal on Thor lands here too, so
    // every route into "here is the work" assembles - there is one assemble
    // path, not a copy of it inlined per caller.
    // The role templates above are only a floor, so nothing is ever goal-less
    // if the assemble turn fails or times out.
    await COMMANDS.assemble().catch(() => {});
    return { runId: store.runId, mission, goals: state.goals, planning: true };
  },

  // ASSEMBLE. Thor decides who this mission actually needs, brings them on,
  // stands the rest down, and gives each of the chosen a goal. Same turn that
  // setMission runs, on demand - so you can re-assemble after the mission
  // changes shape, or after you have flipped agents by hand and want Thor to
  // judge it again.
  async assemble() {
    if (state.completedAt) throw new Error('mission is complete');
    if (!state.mission) throw new Error('set the mission first - there is nobody to assemble for');
    const orchestrator = Object.values(state.agents).find((a) => a.role === 'orchestrator');
    if (!orchestrator) throw new Error('no orchestrator on the floor');
    ensureRun();
    ingest(createEvent(orchestrator.id, EVENT_KINDS.STATUS, {
      text: 'assembling: deciding who this mission needs, and standing the rest down',
      from: 'you',
    }));
    // Assembling is its OWN turn. Steering the brief into a session already
    // deep in mission work is why he never once answered it: he was pushing a
    // branch and the planning instruction arrived as an aside. Ending that turn
    // first makes the brief the whole of what he is being asked.
    if (hasLiveWorker(orchestrator)) {
      await interruptAgent(orchestrator.id);
    }
    const assemblyId = randomUUID();
    state.assembly = { id: assemblyId, timer: null };
    try {
      await COMMANDS.setActive({
        agentId: orchestrator.id,
        active: true,
        task: planningTask(state.mission, crewRoster(), state.board),
        planning: true,
        exclusiveOutput: true,
      });
    } catch (error) {
      settleAssembly(assemblyId);
      throw error;
    }
    const timer = setTimeout(() => {
      if (state.assembly?.id === assemblyId) {
        failAssembly(assemblyId, 'Thor did not publish a work plan in time');
      }
    }, PLANNING_TIMEOUT_MS);
    timer.unref?.();
    if (state.assembly?.id === assemblyId) state.assembly.timer = timer;
    else clearTimeout(timer);
    return { planning: true, assemblyId };
  },

  // START ALL means "start all work that can run now". The scheduler owns
  // readiness, dependencies, file conflicts, and capacity. Calling start on
  // every seat made normal dependency waits look like failures and also tried
  // to start Thor as a checkpoint worker.
  async startReady() {
    if (state.completedAt) throw new Error('mission is complete');
    ensureRun();
    const started = await scheduler.reconcile();
    publish({ type: 'state', state: snapshot() });
    return { started };
  },

  // A run is a conversation with the fleet. Starting a new one closes the old
  // record and resets the floor; the old one stays readable in the database.
  // Stop everything without losing it: agents are interrupted, the run is
  // closed in the record, and what happened stays on screen to be read.
  async stopRun() {
    const stopped = [];
    for (const agent of Object.values(state.agents)) {
      if (!ensureWorkers(agent).some((worker) => worker.sessionId)) continue;
      await interruptAgent(agent.id).catch(() => {});
      state.agents = patchAgent(state.agents, agent.id, projectWorkers({
        ...state.agents[agent.id], enabled: false,
      }));
      stopped.push(agent.id);
    }
    ingest(
      createEvent('minimac', EVENT_KINDS.STATUS, {
        state: 'idle',
        text: stopped.length ? `run stopped: ${stopped.join(', ')}` : 'run stopped',
        from: 'you',
      }),
    );
    store.finishRun();
    return { stopped };
  },

  // Continue an old run: the SAME conversations, picked up where they stopped.
  // The agents keep everything they already worked out, which is the whole
  // difference between continuing and starting over.
  async continueRun({ runId, note }) {
    const previous = store.getRun(Number(runId));
    if (!previous) throw new Error(`no run ${runId}`);
    if (previous.repo !== options.repo) {
      throw new Error(`run ${runId} belongs to ${previous.repo}; restart MINIMAC for that repository`);
    }
    const savedItems = store.itemsFor(Number(runId));
    const savedGoals = store.goalsFor(Number(runId));
    const savedAcceptance = store.acceptanceFor(Number(runId)) ?? createAcceptancePolicy();
    const savedBoard = { workUnits: store.workUnitsFor(Number(runId)), items: savedItems };
    if (store.missionStateFor(Number(runId))?.completedAt
      || missionIsComplete(savedAcceptance, savedBoard)) {
      throw new Error('that mission is complete; use Run Again to create a new run');
    }

    // Continue always continues. Where a session survives, the agent keeps its
    // memory; where it does not, that agent starts fresh on the same goal and
    // the feed says which ones lost their thread. A dead button is never the
    // right answer.
    const savedWorkers = store.workerSessionsFor(Number(runId));

    // Continue preserves the selected run identity. RUN AGAIN is the only
    // command that creates a new run.
    store.finishRun();
    state.mission = previous.mission;
    store.reopenRun(Number(runId));
    state.events = store.replayRun(Number(runId));
    state.acceptance = savedAcceptance;
    state.completedAt = null;
    store.saveMissionState({ acceptance: state.acceptance, completedAt: null });

    // Restore the selected run as one complete state, not as a copy of the
    // current floor with old checkpoints attached.
    state.agents = forceEngine(createRoster(DEFAULT_ROSTER, options.rosterOverrides), options.engine);
    for (const row of store.enginesFor(Number(runId))) {
      state.agents = assignEngine(state.agents, row.agent_id, row.engine);
    }
    for (const agent of Object.values(state.agents)) applySavedRuntime(agent.id);
    for (const event of state.events) state.agents = applyFleetEvent(state.agents, event);
    state.board = savedBoard;
    state.goals = deriveGoals({}, state.agents, state.mission);
    for (const row of savedGoals) {
      if (row.objective) {
        state.goals = setGoal(state.goals, row.agent_id, row.objective, row.token_budget, 'active', 'manual');
        store.saveGoal(row.agent_id, state.goals[row.agent_id]);
      }
    }

    const prompt = note
      ?? 'Continue where you left off. Restate in one line what you were doing, then carry on.';
    const resumed = [];
    const restarted = [];

    for (const agent of Object.values(state.agents)) {
      const rows = savedWorkers.filter((row) => row.agent_id === agent.id);
      if (rows.length === 0) continue;
      const workers = rows.map(hydrateWorker);
      state.agents = patchAgent(state.agents, agent.id, projectWorkers({
        ...agent, enabled: true, workers,
      }, workers));
      const activeRows = rows.filter((row) => ['running', 'blocked'].includes(row.state));
      if (activeRows.length === 0) continue;
      const checkpointIds = activeRows.map((row) => row.checkpoint_id).filter(Boolean);
      try {
        await COMMANDS.start({ agentId: agent.id, task: prompt, checkpointIds });
        resumed.push(...activeRows.map((row) => row.worker_id));
      } catch {
        // The stored conversation remains available through resumeSessionId.
        // Do not replace it with a fresh thread when recovery is not possible.
        restarted.push(...activeRows.map((row) => row.worker_id));
      }
    }

    ingest(
      createEvent('minimac', EVENT_KINDS.STATUS, {
        text: `continued run ${runId}: resumed ${resumed.join(', ') || 'none'}`
          + (restarted.length
            ? ` · no session to resume, started fresh: ${restarted.join(', ')}`
            : ''),
        from: 'you',
      }),
    );
    return { runId: store.runId, resumed, restarted };
  },

  // Run an old one again: its mission and the goals as they were, in a fresh
  // run record so the original stays intact and comparable.
  // RUN AGAIN: same mission and goals, from nothing. Its board starts empty too.
  async resumeRun({ runId }) {
    const previous = store.getRun(Number(runId));
    if (!previous) throw new Error(`no run ${runId}`);

    const saved = store.goalsFor(Number(runId));
    await COMMANDS.newRun({ mission: previous.mission, autoStart: false });

    for (const row of saved) {
      if (!row.objective) continue;
      state.goals = setGoal(
        state.goals,
        row.agent_id,
        row.objective,
        row.token_budget,
        'active',
        'manual', // it was chosen for that run, so it is not re-derived here
      );
      store.saveGoal(row.agent_id, getGoal(state.goals, row.agent_id));
    }

    for (const agent of Object.values(state.agents)) {
      await COMMANDS.start({ agentId: agent.id }).catch(() => {});
    }
    return { from: Number(runId), runId: store.runId, mission: previous.mission };
  },

  async newRun({ mission, autoStart = true }) {
    const selectedEngines = Object.fromEntries(
      Object.values(state.agents).map((agent) => [agent.id, agent.engine]),
    );
    for (const agent of Object.values(state.agents)) await interruptAgent(agent.id).catch(() => {});
    store.finishRun();
    state.agents = forceEngine(createRoster(DEFAULT_ROSTER, options.rosterOverrides), options.engine);
    for (const [agentId, engine] of Object.entries(selectedEngines)) {
      state.agents = assignEngine(state.agents, agentId, engine);
    }
    for (const agent of Object.values(state.agents)) applySavedRuntime(agent.id);
    state.goals = {};
    state.claims = {};
    state.events = [];
    // A new mission starts with an empty board. The last mission's work is kept
    // in the record but must not be handed to this crew as though it were
    // theirs - which is how a LICENSE plan turned up under a CI mission.
    state.board = createBoard();
    state.acceptance = createAcceptancePolicy();
    state.completedAt = null;
    state.cards = [];
    state.dismissedCards = new Set();
    state.verdicts = {};
    state.mission = mission ?? '';
    const id = store.startRun(state.mission, options.repo);
    store.saveMissionState({ acceptance: state.acceptance, completedAt: null });
    state.goals = deriveGoals(state.goals, state.agents, state.mission);
    for (const [agentId, goal] of Object.entries(state.goals)) store.saveGoal(agentId, goal);
    for (const agent of Object.values(state.agents)) store.saveEngine(agent.id, agent.engine);
    if (autoStart && state.mission) {
      for (const agent of Object.values(state.agents)) {
        await COMMANDS.start({ agentId: agent.id }).catch(() => {});
      }
    }
    return { runId: id, mission: state.mission };
  },

  async start({
    agentId,
    task,
    mentions = null,
    attachments = [],
    planning = false,
    exclusiveOutput = planning,
    checkpointIds = null,
  }) {
    if (state.completedAt) throw new Error('mission is complete');
    if (state.agents[agentId]?.enabled === false) return { skipped: 'disabled' };
    ensureRun();
    const agent = state.agents[agentId];
    const goal = getGoal(state.goals, agentId);
    if (!goal?.objective) throw new Error(`${agentId} has no goal - set the mission first`);
    const selectedItems = Array.isArray(checkpointIds)
      ? checkpointIds.map((id) => findItem(state.board, id)).filter(Boolean)
      : null;
    const assignedItems = agent.role === ROLES.ORCHESTRATOR
      ? []
      : selectedItems ?? (task
        ? []
        : readyWork(agentId).slice(0, Math.max(1, agent.instances ?? 1)));
    let tasks = [];
    if (agent.role === ROLES.ORCHESTRATOR) {
      tasks = [task ?? state.mission];
    } else if (assignedItems.length > 0) {
      tasks = assignedItems.map((item) =>
        [task, checkpointTask(item)].filter(Boolean).join('\n\n'));
    } else if (task) {
      tasks = [task];
    }
    if (!tasks.length) throw new Error(`${agentId} has no ready checkpoint`);
    const cwd = options.isolate ? await worktrees.create(agentId) : options.repo;
    const context = promptContext(agent, tasks[0], {
      mentions,
      attachments,
      goal: assignedItems.length ? {
        objective: `Complete the assigned checkpoint${assignedItems.length > 1 ? 's' : ''}: `
          + assignedItems.map((item) => `${item.id} — ${item.outcome}`).join('; '),
      } : null,
      claims: assignedItems.length
        ? [...new Set(assignedItems.flatMap((item) => item.files ?? []))]
        : null,
      // A planning turn owns the goals fence. Do not add the report fence.
      exclusiveOutput,
    });
    context.tasks = tasks;
    context.workItems = assignedItems;
    const missionConversation = messagesForContext(state.events, {
      kind: CONTEXT_KIND.MISSION, id: String(store.runId),
    });
    context.conversations = agent.role === ROLES.ORCHESTRATOR
      ? [missionConversation]
      : assignedItems.map((item) => [...missionConversation, ...messagesForContext(state.events, {
        kind: CONTEXT_KIND.CHECKPOINT, id: item.id,
      })].sort((left, right) => left.createdAt - right.createdAt));
    let startedWorkers;
    try {
      startedWorkers = await startWorkers(agent, cwd, context);
    } catch (error) {
      const retryAt = Date.now() + 15_000;
      for (const item of assignedItems ?? []) {
        const failed = failCheckpointStart(state.board, item.id, error.message, retryAt);
        if (!failed.error) {
          state.board = failed.board;
          store.saveItem(failed.item);
        }
      }
      if ((assignedItems ?? []).length > 0) {
        const timer = setTimeout(scheduleReadyWork, Math.max(0, retryAt - Date.now()));
        timer.unref?.();
      }
      ingest(
        createBlockedEvent(agentId, {
          category: BLOCKED_REASONS.ERROR,
          reason: `${agent.engine} could not start: ${error.message}`,
        }),
      );
      throw error;
    }
    // Re-read: events arriving during the await already changed this agent.
    if (!startedWorkers.length) throw new Error(`${agentId} has no free worker slot`);
    state.agents = patchAgent(state.agents, agentId, {
      ...projectWorkers(state.agents[agentId]),
      enabled: true,
    });
    store.clearHandoff(agentId);
    return {
      sessionId: startedWorkers[0].sessionId,
      workerIds: startedWorkers.map((worker) => worker.id),
      workers: startedWorkers.length,
    };
  },

  // The composer's single verb. One line of text, whatever it names, ends up
  // in exactly one place: the mission, or one agent.
  async say({ target, text, attachments = [], from = 'you' }) {
    const parsed = parseMentions(text, {
      agents: Object.values(state.agents), checkpoints: itemsOf(state.board), decisions: state.cards,
    });
    const namesAgent = parsed.references.some((reference) => reference.kind === 'hero');
    const routedTarget = routeOf(parsed, target);
    // A pasted path is an attachment, so dragging a file in and pasting its
    // path behave the same way.
    for (const path of await repoIndex.existingPaths(text)) {
      if (!attachments.some((file) => file.path === path)) {
        attachments = [...attachments, { path, name: path.split('/').pop(), type: 'file' }];
      }
    }
    const files = parsed.references.filter((reference) => reference.kind === 'file').map((reference) => reference.id);
    if (files.length > 0 && state.agents[routedTarget]) {
      await COMMANDS.claim({ agentId: routedTarget, patterns: files });
    }
    if (target === 'mission' && !namesAgent) {
      return COMMANDS.setMission({ mission: text, attachments });
    }

    // POLICY. One sentence that binds the whole fleet, forever. It is written
    // into the standing instruction, which the prompt pipeline adds to every
    // dispatch AND every steer - so no model decides whether it applies, and
    // an agent started an hour from now is bound by it too.
    if (target === 'policy' && !namesAgent) {
      const rule = String(text ?? '').trim();
      if (!rule) throw new Error('a policy needs something to say');
      const standing = middlewareText('hook');
      const next = standing?.trim() ? `${standing.trim()}\n- ${rule}` : `- ${rule}`;
      await COMMANDS.setMiddleware({ name: 'hook', text: next });
      ingest(createEvent('minimac', EVENT_KINDS.STATUS, {
        text: `policy, binding on everyone from now on: ${rule}`,
        from: 'you',
      }));
      return { policy: next };
    }

    // THOR. Said once; he decides who needs it and in what words.
    if (target === 'thor' && !namesAgent) {
      const boss = Object.values(state.agents).find((a) => a.role === ROLES.ORCHESTRATOR);
      if (!boss) throw new Error('no orchestrator on the floor');
      const brief = [
        '# Pass this on',
        '',
        'Mac said this once, to you, for the whole crew:',
        '',
        text,
        '',
        'Decide who actually needs to hear it and what it means for each of them. '
        + 'Say nothing to anyone it does not concern. Answer with the goals block, '
        + 'setting only the goals you are changing.',
      ].join('\n');
      return COMMANDS.say({ target: boss.id, text: brief, attachments });
    }

    const agentId = routedTarget;
    const agent = state.agents[agentId];
    if (!agent) throw new Error(`unknown agent: ${agentId}`);
    return writeConversation({
      context: { kind: CONTEXT_KIND.MISSION, id: String(store.runId) },
      text, attachments, from, authorId: 'you', recipients: [agentId], wake: true,
    });
  },

  async postConversation({ context, text = '', attachments = [], recipients = [], from = 'you' }) {
    return writeConversation({
      context, text, attachments, recipients, from, wake: from === 'you',
    });
  },

  async replyConversation({ context, text = '', attachments = [], replyToMessageId, recipients = [], from = 'you' }) {
    return writeConversation({
      context, text, attachments, replyToMessageId, recipients, from, wake: from === 'you',
    });
  },

  async reactConversation({ context, messageId, reaction, from = 'you' }) {
    return conversations.react({ authorId: from, context, messageId, reaction });
  },

  async resolveResource({ reference }) {
    return workspaceQuery.resource(reference);
  },

  // Make the orchestrator say something to a hero. The floor walks him over.
  // Used by ASSEMBLE, by his rulings, and by nothing else in normal operation.
  async orders({ agentId, text }) {
    if (!state.agents[agentId]) throw new Error(`unknown agent: ${agentId}`);
    orders(agentId, text);
    return { to: agentId };
  },

  // The working folder is a live setting, not a launch-only flag.
  // Rewrite one middleware step. It takes effect on the next dispatch and on
  // every steer, and it outlives the run.
  async setMiddleware({ name, text }) {
    if (!EDITABLE_STEPS.includes(name)) throw new Error(`${name} is not editable`);
    middleware[name] = text;
    store.saveMiddleware(name, text);
    return { name, text };
  },

  async resetMiddleware({ name }) {
    delete middleware[name];
    store.saveMiddleware(name, null);
    return { name, text: middlewareText(name) };
  },

  async setRepo({ dir }) {
    const verdict = await repoIndex.check(dir);
    if (!verdict.ok) throw new Error(`${dir}: ${verdict.reason}`);
    options.repo = dir;
    return { repo: dir, git: verdict.git };
  },

  // Pressing a button beats typing prose: the engine gets the exact decision it
  // offered. Engines without an approval protocol fall back to steering.
  async approve({ agentId, approvalId, decision }) {
    const agent = state.agents[agentId];
    const sessionId = agent && primarySessionId(agent);
    if (!sessionId) throw new Error(`${agentId} is not running`);
    const driver = getDriver(agent.engine);
    if (typeof driver.approve === 'function') {
      await driver.approve(sessionId, approvalId, decision);
    } else {
      await driver.steer(
        sessionId,
        composeDispatch(promptContext(agent, String(decision))),
      );
    }
    ingest(createEvent(agentId, EVENT_KINDS.STATUS, { approvalId, decision, from: 'you' }));
    return {};
  },

  // A prayer stays open through a conversation. Only the operator can close
  // it, and closing it is recorded beside the question and its replies.
  async settlePrayer({ agentId }) {
    if (!state.agents[agentId]) throw new Error(`no agent ${agentId}`);
    if (!answerPrayer(agentId, 'settled by Mac')) {
      throw new Error(`${agentId} has no open question`);
    }
    refreshCards();
    return { settled: true };
  },

  async dismissDecision({ key }) {
    const card = state.cards.find((candidate) => cardKey(candidate) === key);
    if (!card) return { dismissed: false };
    if (card.kind === 'approval') {
      throw new Error('answer the approval before it can leave Decisions');
    }
    if (card.kind === 'prayer') answerPrayer(card.agentId, 'dismissed by Mac');
    state.dismissedCards.add(key);
    refreshCards();
    return { dismissed: true };
  },

  async steer({ agentId, text }) {
    const agent = state.agents[agentId];
    if (!agent) throw new Error(`no agent ${agentId}`);
    // A reply does NOT close the question. You asked to be able to go back and
    // forth, and a card that vanishes on your first sentence ends the
    // conversation for you. It closes when you say it is settled.
    if (!hasLiveWorker(agent)) {
      // The answer is already recorded above, so say what happened rather than
      // pretending nothing did: the card is closed, the agent never heard it.
      throw new Error(
        `${agent.label ?? agentId} has no live session${
          agent.blockedReason ? ` - ${agent.blockedReason}` : ''
        }. Your answer is on the record; press START for them to hear it.`,
      );
    }
    const sent = await eachSession(agent, (id) =>
      getDriver(agent.engine).steer(
        id,
        composeDispatch(promptContext(agent, text)),
      ));
    // Only what the engine took is written to the floor.
    if (!sent.delivered) {
      throw new Error(
        `${agent.label ?? agentId} did not take that: ${sent.failures[0] ?? 'the engine is gone'}`,
      );
    }
    return { delivered: sent.delivered };
  },

  async setGoal({ agentId, objective, tokenBudget, status }) {
    // Giving the orchestrator a goal IS giving the fleet a mission - it would
    // be strange to write "get the repos pushed" on Thor and have the rest of
    // the crew sit there with nothing.
    if (state.agents[agentId]?.role === ROLES.ORCHESTRATOR && objective?.trim()) {
      return COMMANDS.setMission({ mission: objective.trim() });
    }
    state.goals = setGoal(state.goals, agentId, objective, tokenBudget, status);
    store.saveGoal(agentId, getGoal(state.goals, agentId));
    const agent = state.agents[agentId];
    if (agent && hasLiveWorker(agent)) {
      const message = `Your goal changed. From now on: ${objective}`;
      const sent = await eachSession(agent, async (id) => {
        const driver = getDriver(agent.engine);
        await driver.setGoal(id, objective, tokenBudget, status);
        await driver.steer(id, composeDispatch(promptContext(agent, message)));
      });
      if (!sent.delivered) {
        throw new Error(`${agent.label ?? agentId} did not receive the changed goal`);
      }
    }
    orders(agentId, objective, ORDER_ACTION.GOAL);
    return { goal: getGoal(state.goals, agentId) };
  },

  async clearGoal({ agentId }) {
    state.goals = clearGoal(state.goals, agentId);
    store.saveGoal(agentId, null);
    return {};
  },

  // Scale a seat: two Ironmen behind one desk, each on its own slice.
  async setInstances({ agentId, instances }) {
    const agent = state.agents[agentId];
    if (!agent) throw new Error(`unknown agent: ${agentId}`);
    const count = Math.min(4, Math.max(1, Number(instances) || 1));
    const resized = { ...agent, instances: count };
    state.agents = patchAgent(state.agents, agentId, projectWorkers(resized, ensureWorkers(resized)));
    return { agentId, instances: count };
  },

  async assignWork({
    id, title, plan, outcome, verify, scope, owner, needs, blockedBy, estimateMs,
    by = 'minimac',
  }) {
    if (state.completedAt) throw new Error('mission is complete');
    if (!state.agents[owner] || state.agents[owner].role === ROLES.ORCHESTRATOR) {
      throw new Error(`unknown Avenger: ${owner}`);
    }
    if (id && findItem(state.board, id)) {
      const result = reviseItem(state.board, id, {
        title, plan, outcome, verify, scope, owner, needs, blockedBy, estimateMs,
      });
      if (result.error) throw new Error(result.error);
      state.board = result.board;
      store.saveItem(result.item);
      orders(
        owner,
        `${result.item.id}: ${result.item.title}`,
        ORDER_ACTION.ASSIGN,
        result.item.id,
      );
      return { item: result.item };
    }
    const result = workBoard.add({
      id, title, plan, outcome, verify, scope, owner, needs, blockedBy, estimateMs,
    }, by);
    if (result.error) throw new Error(result.error);
    return { item: result.item, duplicate: result.duplicate === true };
  },

  async moveCheckpoint({ id, direction }) {
    if (state.completedAt) throw new Error('mission is complete');
    const running = itemsOf(state.board)
      .filter((item) => item.lease?.state === 'running')
      .map((item) => item.id);
    const result = moveCheckpointItem(state.board, id, direction, running);
    if (result.error) throw new Error(result.error);
    state.board = result.board;
    for (const item of result.items) store.saveItem(item);
    return { id, direction: Math.sign(direction) };
  },

  async pauseCheckpoint({ id, paused = true }) {
    if (state.completedAt) throw new Error('mission is complete');
    const item = findItem(state.board, id);
    if (!item) throw new Error(`no item ${id}`);
    if (paused && item.owner) await interruptCheckpoint(item.owner, id);
    const result = setCheckpointPaused(state.board, id, paused);
    if (result.error) throw new Error(result.error);
    state.board = result.board;
    store.saveItem(result.item);
    return { item: result.item };
  },

  async extendCheckpointLease({ id }) {
    if (state.completedAt) throw new Error('mission is complete');
    const item = findItem(state.board, id);
    if (!item) throw new Error(`no item ${id}`);
    const result = workerLeases.extend(item.lease);
    if (result.error) throw new Error(result.error);
    const revised = reviseItem(state.board, id, { lease: result.lease });
    if (revised.error) throw new Error(revised.error);
    state.board = revised.board;
    store.saveItem(revised.item);
    coordination.lease(result.lease.agentId, { ...result.lease, state: 'extended' });
    return { item: revised.item };
  },

  async reassignCheckpoint({ id, owner }) {
    if (state.completedAt) throw new Error('mission is complete');
    if (!state.agents[owner] || state.agents[owner].role === ROLES.ORCHESTRATOR) {
      throw new Error(`unknown Avenger: ${owner}`);
    }
    const item = findItem(state.board, id);
    if (!item) throw new Error(`no item ${id}`);
    if (item.owner && item.owner !== owner) {
      await interruptCheckpoint(item.owner, id, { clearCheckpoint: true });
    }
    const result = reviseItem(state.board, id, { owner });
    if (result.error) throw new Error(result.error);
    state.board = result.board;
    store.saveItem(result.item);
    orders(
      owner,
      `${result.item.id}: ${result.item.title}`,
      ORDER_ACTION.ASSIGN,
      result.item.id,
    );
    return { item: result.item };
  },

  async forceStartCheckpoint({ id }) {
    if (state.completedAt) throw new Error('mission is complete');
    let item = findItem(state.board, id);
    if (!item) throw new Error(`no item ${id}`);
    if (!item.owner) throw new Error('assign this checkpoint first');
    if (unmetDeps(state.board, item).length > 0) {
      throw new Error('this checkpoint is waiting on another checkpoint');
    }
    if (item.lease?.state === 'running') {
      return { item, alreadyRunning: true };
    }
    if (freeWorkers(state.agents[item.owner]).length === 0) {
      throw new Error(`${state.agents[item.owner].label ?? item.owner} has no free worker`);
    }
    if (item.paused) {
      const resumed = setCheckpointPaused(state.board, id, false);
      state.board = resumed.board;
      item = resumed.item;
      store.saveItem(item);
    }
    state.agents = patchAgent(state.agents, item.owner, { enabled: true });
    return COMMANDS.start({ agentId: item.owner, checkpointIds: [id] });
  },

  // One command owns the mission switch. Off benches and stops the agent. On
  // brings it onto the mission and starts a real middleware-composed session.
  async setActive({
    agentId,
    active,
    task,
    mentions,
    attachments = [],
    planning = false,
    exclusiveOutput = planning,
  }) {
    const agent = state.agents[agentId];
    if (!agent) throw new Error(`unknown agent: ${agentId}`);
    if (!active) {
      if (agent.role === ROLES.ORCHESTRATOR && store.runId !== null && state.mission) {
        state.agents = patchAgent(state.agents, agentId, { enabled: true });
        return { agentId, active: isActive(state.agents[agentId]), required: 'mission' };
      }
      if (hasLiveWorker(agent)) await interruptAgent(agentId);
      state.agents = patchAgent(state.agents, agentId, projectWorkers({
        ...state.agents[agentId], enabled: false,
      }));
      return { agentId, active: false };
    }
    if (hasLiveWorker(agent)) {
      state.agents = patchAgent(state.agents, agentId, { enabled: true });
      return { agentId, active: true, sessionId: primarySessionId(agent) };
    }
    state.agents = patchAgent(state.agents, agentId, { enabled: true });
    try {
      return await COMMANDS.start({
        agentId,
        task,
        mentions,
        attachments,
        planning,
        exclusiveOutput,
      });
    } catch (error) {
      state.agents = patchAgent(state.agents, agentId, {
        enabled: agent.role === ROLES.ORCHESTRATOR && Boolean(state.mission),
      });
      publish({ type: 'state', state: snapshot() });
      throw error;
    }
  },

  async assignEngine({ agentId, engine }) {
    const current = state.agents[agentId];
    if (!current) throw new Error(`unknown agent: ${agentId}`);
    if (current.engine === engine) return { engine };
    ensureRun();
    const sourceSessionIds = ensureWorkers(current)
      .map((worker) => worker.sessionId ?? worker.resumeSessionId)
      .filter(Boolean);
    await captureEngineHandoff(agentId, current.engine, engine, sourceSessionIds);
    if (hasLiveWorker(current)) await interruptAgent(agentId);
    state.agents = assignEngine(state.agents, agentId, engine);
    applySavedRuntime(agentId);
    let resetAgent = projectWorkers({
      ...state.agents[agentId],
      enabled: current.enabled,
      blockedReason: null,
    });
    for (const worker of ensureWorkers(resetAgent)) {
      resetAgent = patchWorker(resetAgent, worker.id, {
        engine,
        state: WORKER_STATE.IDLE,
        sessionId: null,
        resumeSessionId: null,
        checkpointId: null,
      });
    }
    state.agents = patchAgent(state.agents, agentId, resetAgent);
    store.saveEngine(agentId, engine);
    return { engine };
  },

  async configureRuntime({ agentId, model, effort }) {
    const current = state.agents[agentId];
    if (!current) throw new Error(`unknown agent: ${agentId}`);
    state.agents = configureAgentRuntime(state.agents, agentId, { model, effort });
    const agent = state.agents[agentId];
    store.saveSetting(runtimeKey(agent.id, agent.engine), {
      model: agent.model,
      effort: agent.effort,
    });
    await eachSession(agent, (sessionId) =>
      getDriver(agent.engine).configureRuntime?.(sessionId, agent));
    return {
      agentId,
      engine: agent.engine,
      model: agent.model,
      effort: agent.effort,
      applies: hasLiveWorker(current) ? 'next turn' : 'next start',
    };
  },

  async claim({ agentId, patterns }) {
    const result = claimFiles(state.claims, agentId, patterns);
    state.claims = result.claims;
    if (result.granted) store.saveClaims(agentId, patterns);
    return result;
  },

  async release({ agentId }) {
    state.claims = releaseClaim(state.claims, agentId);
    store.saveClaims(agentId, []);
    return {};
  },
};

scheduler = createScheduler({
  getBoard: () => state.board,
  getAgents: () => state.agents,
  start: (agentId, checkpointIds) => COMMANDS.start({ agentId, checkpointIds }),
  limitMs: LEASE_LIMIT_MS,
});

runtimeSupervisor = createRuntimeSupervisor({
  getBoard: () => state.board,
  getAgents: () => state.agents,
  markStale: (agentId, workerId, reason, observedState) =>
    expireWorkerLease(agentId, workerId, reason, observedState),
  recover: async () => scheduleReadyWork(),
  inspect: (worker) => getDriver(worker.engine).sessionHealth?.(worker.sessionId, options.repo),
});
const runtimeSupervisorTimer = setInterval(() => {
  void runtimeSupervisor.reconcileWorkers()
    .then(() => scheduleReadyWork())
    .catch((error) => ingest(createBlockedEvent('minimac', {
      category: BLOCKED_REASONS.ERROR,
      reason: `worker recovery failed: ${error.message}`,
    })));
}, 15_000);
runtimeSupervisorTimer.unref?.();

coordination = createFleetCoordination({
  getEvents: () => state.events,
  emit: ingest,
  orchestratorId: () => Object.values(state.agents)
    .find((agent) => agent.role === ROLES.ORCHESTRATOR)?.id ?? null,
  deliver: async (agentId, text, { wake = false } = {}) => {
    const agent = state.agents[agentId];
    if (!agent) throw new Error(`unknown agent: ${agentId}`);
    if (hasLiveWorker(agent)) return COMMANDS.steer({ agentId, text, record: false });
    if (!wake) throw new Error(`${agent.label ?? agentId} has no live session`);
    return COMMANDS.setActive({ agentId, active: true, task: text });
  },
});

conversations = createConversationService({
  getEvents: () => state.events,
  emit: ingest,
  id: randomUUID,
  missionId: () => String(store.runId),
  validateContext: (context) => {
    if (context.kind === CONTEXT_KIND.MISSION) return context.id === String(store.runId);
    if (context.kind === CONTEXT_KIND.CHECKPOINT) return Boolean(findItem(state.board, context.id));
    if (context.kind === CONTEXT_KIND.DECISION) {
      return state.cards.some((card) => String(card.key ?? card.id) === context.id);
    }
    return false;
  },
  validateRecipient: (agentId) => Boolean(state.agents[agentId]),
  resolveMentions: async (text) => parseMentions(text, {
    agents: Object.values(state.agents), checkpoints: itemsOf(state.board), decisions: state.cards,
  }),
  resolveSkills: async (names) => {
    if (!names.length) return [];
    const skills = await repoIndex.skills(options.repo);
    return names.map((name) => skills.find((skill) => skill.label === name)).filter(Boolean);
  },
  resolveRecipients: ({ context, authorId, recipients }) => {
    if (recipients.length) return recipients.filter((id) => id !== authorId);
    if (context.kind === CONTEXT_KIND.MISSION) {
      return Object.values(state.agents)
        .filter((agent) => agent.id !== authorId && hasLiveWorker(agent))
        .map((agent) => agent.id);
    }
    if (context.kind === CONTEXT_KIND.CHECKPOINT) {
      const owner = findItem(state.board, context.id)?.owner;
      return owner && owner !== authorId ? [owner] : [];
    }
    const owner = state.cards.find((card) => String(card.key ?? card.id) === context.id)?.agentId;
    return owner && owner !== authorId ? [owner] : [];
  },
  resolveVisibleRecipient: ({ authorId }) => Object.values(state.agents)
    .find((agent) => agent.role === ROLES.ORCHESTRATOR && agent.id !== authorId)?.id ?? null,
  deliver: async (agentId, text, { wake = false } = {}) => {
    const agent = state.agents[agentId];
    if (!agent) throw new Error(`unknown agent: ${agentId}`);
    if (hasLiveWorker(agent)) return COMMANDS.steer({ agentId, text });
    if (!wake) throw new Error(`${agent.label ?? agentId} has no live session`);
    return COMMANDS.setActive({ agentId, active: true, task: text });
  },
});

workspaceQuery = createWorkspaceQuery({
  getState: () => ({
    ...state, runId: store.runId, board: itemsOf(state.board),
    progress: projectMissionProgress(state.board, state.acceptance),
    contradictions: missionContradictions(state.board,
      Object.values(state.agents).flatMap((agent) => ensureWorkers(agent)), state.acceptance),
  }),
  resolveResource: (reference) => repoIndex.resource(options.repo, reference),
});

workerLeases = createWorkerLeaseService({
  schedule: (action, delay) => {
    const timer = setTimeout(action, delay);
    timer.unref?.();
    return timer;
  },
  cancel: clearTimeout,
  onWarning: (lease) => {
    const item = findItem(state.board, lease.checkpointId);
    if (item?.lease?.workerId !== lease.workerId
      || item.lease.expiresAt !== lease.expiresAt) return;
    coordination.lease(lease.agentId, { ...lease, state: 'warning' });
    void coordination.escalate({
      fromAgentId: lease.agentId,
      fromWorkerId: lease.workerId,
      checkpointId: lease.checkpointId,
      needs: 'decision',
      why: 'This work unit has two minutes left. Extend it once, split it, or pause it.',
    }).catch(() => {});
  },
  onExpire: (lease) => {
    const item = findItem(state.board, lease.checkpointId);
    if (item?.lease?.workerId !== lease.workerId
      || item.lease.expiresAt !== lease.expiresAt) return;
    coordination.lease(lease.agentId, { ...lease, state: 'expired' });
    void expireWorkerLease(lease.agentId, lease.workerId)
      .then(() => publish({ type: 'state', state: snapshot() }))
      .catch(() => {});
  },
});

const ciOwner = Object.values(state.agents).find((agent) => agent.role === ROLES.CODER)?.id ?? null;
const ciWatcher = createCiMonitor({
  checks: createGithubChecksPort({ repo: options.repo }),
  snapshot: () => ({
    scope: store.runId ?? 'none', mission: state.mission, items: itemsOf(state.board),
  }),
  loadBaseline: ({ scope }) => store.setting(`ci-baseline:${options.repo}:${scope}`, {}),
  saveBaseline: ({ scope }, baseline) =>
    store.saveSetting(`ci-baseline:${options.repo}:${scope}`, baseline),
  createCheckpoint: (spec) => workBoard.add(spec, 'minimac'),
  notify: (number, work) => tellThor(
    'minimac',
    `CI changed on PR ${number}. Failing now: ${work.summary}. `
      + (work.existing
        ? `Use checkpoint ${work.existing.id}.`
        : 'A new checkpoint was added for the coder.'),
  ),
  reportHealth: ({ number, state: health, error }) => ingest(createEvent(
    'minimac',
    health === 'failed' ? EVENT_KINDS.BLOCKED : EVENT_KINDS.STATUS,
    { text: health === 'failed' ? undefined : `CI watcher recovered for PR ${number}`,
      reason: health === 'failed' ? `CI watcher failed for PR ${number}: ${error}` : undefined },
  )),
  owner: ciOwner,
  estimateMs: LEASE_LIMIT_MS,
  schedule: (action, delay) => {
    const timer = setInterval(action, delay);
    timer.unref?.();
    return timer;
  },
  cancel: clearInterval,
});

// End a live engine session without deciding mission membership. This is an
// internal lifecycle step used by the one public active/bench transition and
// by Thor's isolated assemble turn. It is not a command clients can call.
async function interruptWorker(
  agentId,
  workerId,
  { workerState = WORKER_STATE.IDLE, clearCheckpoint = false } = {},
) {
  const agent = state.agents[agentId];
  if (!agent) return false;
  const worker = ensureWorkers(agent).find((candidate) => candidate.id === workerId);
  const sessionId = worker?.sessionId;
  if (!sessionId) return false;
  state.agents = patchAgent(
    state.agents,
    agentId,
    patchWorker(state.agents[agentId], workerId, { state: WORKER_STATE.STOPPING }),
  );
  try {
    await getDriver(agent.engine).interrupt(sessionId);
  } catch (error) {
    workerLeases?.clear(workerId);
    const failedWorker = patchWorker(state.agents[agentId], workerId, {
      state: WORKER_STATE.FAILED,
      sessionId: null,
      resumeSessionId: null,
      checkpointId: null,
      failureReason: error.message,
    });
    state.agents = patchAgent(state.agents, agentId, failedWorker);
    if (worker.checkpointId) {
      const retryAt = Date.now() + 15_000;
      const failed = failCheckpointStart(state.board, worker.checkpointId, error.message, retryAt);
      if (!failed.error) {
        state.board = failed.board;
        store.saveItem(failed.item);
        const timer = setTimeout(scheduleReadyWork, Math.max(0, retryAt - Date.now()));
        timer.unref?.();
      }
    }
    store.saveWorkerSession(ensureWorkers(failedWorker)
      .find((candidate) => candidate.id === workerId));
    throw error;
  }
  workerLeases?.clear(workerId);
  const next = patchWorker(state.agents[agentId], workerId, {
    state: workerState,
    sessionId: null,
    resumeSessionId: sessionId,
    checkpointId: clearCheckpoint ? null : worker.checkpointId,
  });
  state.agents = patchAgent(state.agents, agentId, next);
  if (worker.checkpointId) {
    const currentLease = findItem(state.board, worker.checkpointId)?.lease ?? {};
    const leased = reviseItem(state.board, worker.checkpointId, {
      lease: finishLease({
        ...currentLease,
        workerId,
      }, workerState),
    });
    if (!leased.error) {
      state.board = leased.board;
      store.saveItem(leased.item);
    }
  }
  store.saveWorkerSession(ensureWorkers(next).find((candidate) => candidate.id === workerId));
  refreshCards();
  return true;
}

async function expireWorkerLease(
  agentId,
  workerId,
  reason = 'worker session became stale',
  observedState = WORKER_STATE.STALE,
) {
  const agent = state.agents[agentId];
  const worker = agent && ensureWorkers(agent).find((candidate) => candidate.id === workerId);
  const leasedItem = itemsOf(state.board).find((item) =>
    item.lease?.state === 'running' && item.lease.workerId === workerId);
  if (!worker) {
    if (!leasedItem) return false;
    const retryAt = Date.now() + 15_000;
    const failed = failCheckpointStart(
      state.board,
      leasedItem.id,
      `${reason}; MINIMAC will retry`,
      retryAt,
    );
    if (!failed.error) {
      state.board = failed.board;
      store.saveItem(failed.item);
      const timer = setTimeout(scheduleReadyWork, Math.max(0, retryAt - Date.now()));
      timer.unref?.();
    }
    return true;
  }
  const engineEnded = [WORKER_STATE.STOPPED, WORKER_STATE.FAILED].includes(observedState);
  let stopped = true;
  if (worker.sessionId && !engineEnded) {
    stopped = await interruptWorker(agentId, workerId, {
      workerState: WORKER_STATE.STALE,
      clearCheckpoint: true,
    });
  } else {
    workerLeases?.clear(workerId);
    state.agents = patchAgent(state.agents, agentId, patchWorker(agent, workerId, {
      state: engineEnded ? observedState : WORKER_STATE.STALE,
      sessionId: null,
      resumeSessionId: observedState === WORKER_STATE.STOPPED
        ? worker.sessionId ?? worker.resumeSessionId
        : null,
      checkpointId: null,
      failureReason: reason,
    }));
    store.saveWorkerSession(ensureWorkers(state.agents[agentId])
      .find((candidate) => candidate.id === workerId));
  }
  const checkpointId = worker.checkpointId ?? leasedItem?.id ?? null;
  if (checkpointId) {
    const retryAt = Date.now() + 15_000;
    const failed = failCheckpointStart(
      state.board,
      checkpointId,
      `${reason}; MINIMAC will retry`,
      retryAt,
    );
    if (!failed.error) {
      state.board = failed.board;
      store.saveItem(failed.item);
      const timer = setTimeout(scheduleReadyWork, Math.max(0, retryAt - Date.now()));
      timer.unref?.();
    }
  }
  return stopped;
}

async function interruptCheckpoint(agentId, itemId, options = {}) {
  const agent = state.agents[agentId];
  const worker = agent && workerForCheckpoint(agent, itemId);
  return worker ? interruptWorker(agentId, worker.id, options) : false;
}

async function interruptAgent(agentId) {
  const agent = state.agents[agentId];
  if (!agent) throw new Error(`no agent ${agentId}`);
  answerPrayer(agentId, 'stopped by Mac');
  const live = ensureWorkers(agent).filter((worker) => worker.sessionId);
  for (const worker of live) await interruptWorker(agentId, worker.id);
  state.agents = patchAgent(state.agents, agentId, projectWorkers(state.agents[agentId]));
  refreshCards();
}

async function handleCommand(cmd) {
  const command = COMMANDS[cmd.type];
  if (!command) throw new Error(`unknown command: ${cmd.type}`);
  const result = await command(cmd);
  scheduleReadyWork();
  publish({ type: 'state', state: snapshot() });
  return result;
}

// -------------------------------------------------------------------- wire

function snapshot() {
  const workers = Object.values(state.agents).flatMap((agent) => ensureWorkers(agent));
  return {
    agents: Object.fromEntries(
      Object.entries(state.agents).map(([id, agent]) => [id, publicAgent(agent)]),
    ),
    goals: state.goals,
    claims: state.claims,
    mission: state.mission,
    repo: options.repo,
    runId: store.runId,
    // Every card carries whatever Thor said about it. Nothing is hidden.
    cards: state.cards.map((card) => ({
      ...card,
      key: cardKey(card),
      verdict: state.verdicts[cardKey(card)] ?? null,
    })),
    board: itemsOf(state.board),
    // One mission truth, two views. Flow is derived from checkpoints and is
    // never stored or accepted as a second progress record.
    flows: projectMissionFlows(state.board),
    acceptance: state.acceptance,
    progress: projectMissionProgress(state.board, state.acceptance),
    completedAt: state.completedAt,
    quality: repositoryQualitySummary(state.board),
    contradictions: missionContradictions(state.board, workers, state.acceptance),
    tokenEstimate: estimateDispatchTokens({
      mission: state.mission,
      board: state.board,
      crew: crewRoster(),
      attachments: state.attachments,
    }),
    workspace: workspaceQuery ? {
      mission: workspaceQuery.mission(),
      heroes: Object.keys(state.agents).map((id) => workspaceQuery.hero(id)).filter(Boolean),
      checkpoints: itemsOf(state.board).map((item) => workspaceQuery.checkpoint(item.id)).filter(Boolean),
      decisions: state.cards.map((card) => workspaceQuery.decision(card.key ?? card.id)).filter(Boolean),
    } : null,
    schema: buildOutputSchema(),
  };
}

function activeCheckpointIds(agentId) {
  return itemsOf(state.board)
    .filter((item) => item.lease?.state === 'running' && item.lease.agentId === agentId)
    .map((item) => item.id);
}

function publicAgent(agent) {
  return agent
    ? { ...agent, workItemIds: activeCheckpointIds(agent.id), active: isActive(agent) }
    : agent;
}

function publish(message) {
  const frame = `data: ${JSON.stringify(message)}\n\n`;
  for (const res of subscribers) res.write(frame);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/events') return subscribe(res);
  if (url.pathname === '/agent-tool' && req.method === 'POST') return agentTool(req, res);
  if (url.pathname === '/cmd' && req.method === 'POST') return command(req, res);
  if (url.pathname === '/upload' && req.method === 'POST') return upload(req, res);
  if (url.pathname === '/history') {
    const agentId = url.searchParams.get('agent');
    return json(res, 200, { events: eventsFor(state.events, agentId) });
  }
  if (url.pathname === '/files') {
    const found = await repoIndex.search(options.repo, url.searchParams.get('q') ?? '', 20);
    return json(res, 200, { files: found });
  }
  // An uploaded file, read back for display. Confined to the attachments
  // directory so a crafted path cannot read anything else.
  if (url.pathname === '/attachment') {
    const wanted = resolve(String(url.searchParams.get('path') ?? ''));
    const root = join(ROOT, 'data', 'attachments');
    if (!wanted.startsWith(root)) return json(res, 403, { error: 'forbidden' });
    return serveStatic(wanted.slice(ROOT.length), res);
  }
  // Repository references in a conversation are links, not copied content.
  // Resolve them against the configured repository and never outside it.
  if (url.pathname === '/repo-file') {
    const root = resolve(options.repo);
    const wanted = resolve(root, String(url.searchParams.get('path') ?? ''));
    if (wanted !== root && !wanted.startsWith(`${root}${sep}`)) {
      return json(res, 403, { error: 'forbidden' });
    }
    return serveTextResource(wanted, res);
  }
  if (url.pathname === '/dirs') {
    return json(res, 200, await repoIndex.dirs(url.searchParams.get('path') ?? ''));
  }
  if (url.pathname === '/middleware') {
    return json(res, 200, {
      order: dispatchPipeline().names(),
      steps: EDITABLE_STEPS.map((name) => ({
        name,
        text: middlewareText(name),
        overridden: typeof middleware[name] === 'string',
      })),
    });
  }
  if (url.pathname === '/skills') {
    const skills = await repoIndex.skills(options.repo);
    return json(res, 200, { skills: skills.map((skill) => skill.label) });
  }
  if (url.pathname === '/skill-file') {
    const id = String(url.searchParams.get('id') ?? '');
    const skill = (await repoIndex.skills(options.repo)).find((candidate) => candidate.id === id);
    if (!skill) return json(res, 404, { error: 'not found' });
    return serveTextResource(skill.path, res);
  }
  if (url.pathname === '/runs') {
    return json(res, 200, { runs: store.listRuns(Number(url.searchParams.get('limit') ?? 20)) });
  }
  if (url.pathname === '/replay') {
    const runId = Number(url.searchParams.get('run'));
    const agentId = url.searchParams.get('agent');
    const events = agentId ? store.replay(runId, agentId) : store.replayRun(runId);
    const board = { workUnits: store.workUnitsFor(runId), items: store.itemsFor(runId) };
    const acceptance = store.acceptanceFor(runId) ?? createAcceptancePolicy();
    return json(res, 200, {
      run: store.getRun(runId),
      events,
      missionState: {
        board: board.items,
        flows: projectMissionFlows(board),
        acceptance,
        progress: projectMissionProgress(board, acceptance),
        quality: repositoryQualitySummary(board),
        contradictions: missionContradictions(board, [], acceptance),
      },
    });
  }
  return serveStatic(url.pathname, res);
});

function subscribe(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  subscribers.add(res);
  res.write(`data: ${JSON.stringify({ type: 'state', state: snapshot() })}\n\n`);
  res.on('close', () => subscribers.delete(res));
}

async function command(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    const result = await handleCommand(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    json(res, 200, { ok: true, result });
  } catch (error) {
    json(res, 400, { ok: false, error: error.message });
  }
}

async function agentTool(req, res) {
  const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const principal = agentsByToken.get(token);
  if (!principal) return json(res, 401, { ok: false, error: 'invalid agent tool token' });
  if (!principalIsActive(principal)) {
    return json(res, 401, { ok: false, error: 'inactive agent tool principal' });
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    const call = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const result = await executeAgentTool(principal, call.name, call.arguments ?? {});
    publish({ type: 'state', state: snapshot() });
    return json(res, 200, { ok: true, result });
  } catch (error) {
    return json(res, 400, { ok: false, error: error.message });
  }
}

function principalIsActive({ agentId, workerId }) {
  const agent = state.agents[agentId];
  if (!agent) return false;
  if (!workerId) return hasLiveWorker(agent);
  return ensureWorkers(agent).some((worker) => worker.id === workerId && Boolean(worker.sessionId));
}

async function executeAgentTool(principal, name, args) {
  const { agentId: callerId, workerId } = principal;
  const caller = state.agents[callerId];
  if (!caller || !roleCanUseTool(caller.role, name)) {
    throw new Error(`${callerId} cannot use ${name}`);
  }

  if (name === AGENT_TOOL.REPORT) {
    harvestReport({
      agentId: callerId,
      payload: {
        text: `\`\`\`${REPORT_FENCE}\n${JSON.stringify(args)}\n\`\`\``,
        workerId,
      },
    });
    return { recorded: true };
  }
  if (name === AGENT_TOOL.CHECKPOINT) {
    const worker = workerId
      ? ensureWorkers(caller).find((candidate) => candidate.id === workerId)
      : null;
    const move = worker?.checkpointId ? { ...args, item: worker.checkpointId } : args;
    const result = workBoard.updateCheckpoint(callerId, move, workerId);
    if (result.error) throw new Error(result.error);
    return { updated: move.item, gate: move.gate, state: move.state };
  }
  if (name === AGENT_TOOL.INSPECT) {
    const checkpoints = itemsOf(state.board);
    const avengers = Object.values(state.agents)
      .filter((agent) => agent.role !== ROLES.ORCHESTRATOR)
      .map((agent) => {
        const inUse = liveWorkers(agent).length;
        const owned = checkpoints.filter((item) => item.owner === agent.id && !isDone(item));
        const active = owned.filter((item) =>
          item.lease?.agentId === agent.id && item.lease.state === 'running');
        const ready = readyCheckpoints(state.board, agent.id, {
          limitMs: LEASE_LIMIT_MS,
          capacity: owned.length,
        });
        return {
          id: agent.id,
          role: agent.role,
          enabled: agent.enabled !== false,
          status: agent.status,
          capacity: agent.instances,
          inUse,
          free: Math.max(0, agent.instances - inUse),
          activeCheckpointIds: active.map((item) => item.id),
          readyCheckpointIds: ready.map((item) => item.id),
          blockedCheckpointIds: owned
            .filter((item) => !canWork(state.board, item, agent.id))
            .map((item) => item.id),
          goal: getGoal(state.goals, agent.id)?.objective ?? null,
          capabilities: { localShell: true, browserControl: false },
        };
      });
    return {
      capacity: {
        seats: avengers.length,
        workerSlots: avengers.reduce((sum, agent) => sum + agent.capacity, 0),
        inUse: avengers.reduce((sum, agent) => sum + agent.inUse, 0),
        free: avengers.reduce((sum, agent) => sum + agent.free, 0),
        readyUnowned: checkpoints.filter((item) =>
          !item.owner && checkpointState(state.board, item) !== 'blocked').length,
      },
      avengers,
      checkpoints: checkpoints.map((item) => ({
        id: item.id,
        title: item.title,
        owner: item.owner,
        state: checkpointState(state.board, item),
        blockedBy: item.blockedBy,
        estimateMs: item.estimateMs,
      })),
    };
  }
  if (name === AGENT_TOOL.ESCALATE) {
    const worker = ensureWorkers(caller).find((candidate) => candidate.id === workerId);
    const escalation = await coordination.escalate({
      fromAgentId: callerId,
      fromWorkerId: workerId,
      checkpointId: args.checkpointId ?? worker?.checkpointId ?? null,
      needs: args.needs,
      why: args.why,
      involvedAgentId: args.agent ?? null,
      receipt: args.receipt ?? '',
    });
    return { escalated: true, to: escalation.toAgentId, id: escalation.id };
  }
  if (name === AGENT_TOOL.POST || name === AGENT_TOOL.REPLY) {
    return writeConversation({
      context: { kind: args.contextKind, id: args.contextId }, text: args.text,
      replyToMessageId: args.replyToMessageId ?? null, recipients: args.recipients ?? [],
      attachments: args.attachments ?? [], from: callerId, authorId: callerId,
    });
  }
  if (name === AGENT_TOOL.REACT) {
    return conversations.react({ authorId: callerId,
      context: { kind: args.contextKind, id: args.contextId },
      messageId: args.messageId, reaction: args.reaction });
  }
  if (name === AGENT_TOOL.SPLIT) {
    const result = workBoard.requestSplit(callerId, args.id, args.parts, workerId);
    if (result.error) throw new Error(result.error);
    await interruptWorker(callerId, workerId, { clearCheckpoint: true });
    return { split: args.id, checkpoints: result.parts.map((part) => part.id) };
  }
  if (name === AGENT_TOOL.ASSEMBLE) {
    const result = await harvestWorkPlan({
      agentId: callerId,
      payload: { text: `\`\`\`${WORK_PLAN_FENCE}\n${JSON.stringify(args)}\n\`\`\`` },
    });
    if (!result?.applied) throw new Error(result?.error ?? 'assemble was not applied');
    return { assembled: true, ...result };
  }
  if (name === AGENT_TOOL.PAUSE) {
    return COMMANDS.pauseCheckpoint({ id: args.id, paused: true });
  }
  if (name === AGENT_TOOL.EXTEND) {
    return COMMANDS.extendCheckpointLease({ id: args.id });
  }
  if (name === AGENT_TOOL.RESUME) {
    return COMMANDS.forceStartCheckpoint({ id: args.id });
  }
  const target = state.agents[args.agentId];
  if ([AGENT_TOOL.START, AGENT_TOOL.BENCH, AGENT_TOOL.GOAL].includes(name)) {
    if (!target || target.role === ROLES.ORCHESTRATOR) {
      throw new Error(`unknown Avenger: ${args.agentId}`);
    }
  }
  if (name === AGENT_TOOL.START) {
    state.agents = patchAgent(state.agents, args.agentId, { enabled: true });
    const result = await COMMANDS.start({ agentId: args.agentId });
    const checkpoint = findItem(state.board, activeCheckpointIds(args.agentId)[0]);
    orders(
      args.agentId,
      checkpoint ? `Start ${checkpoint.title}` : 'Start your next ready checkpoint',
      ORDER_ACTION.START,
      checkpoint?.id ?? null,
    );
    return result;
  }
  if (name === AGENT_TOOL.BENCH) {
    return COMMANDS.setActive({ agentId: args.agentId, active: false });
  }
  if (name === AGENT_TOOL.GOAL) {
    return COMMANDS.setGoal({ agentId: args.agentId, objective: args.objective });
  }
  if (name === AGENT_TOOL.ASSIGN) {
    return COMMANDS.assignWork({ ...args, by: callerId });
  }
  if (name === AGENT_TOOL.CLOSE) {
    if (state.completedAt) throw new Error('mission is complete');
    const closed = closeItem(state.board, args.id, args.disposition);
    if (closed.error) throw new Error(closed.error);
    state.board = closed.board;
    for (const item of state.board.items) store.saveItem(item);
    return { id: args.id, state: args.disposition };
  }
  throw new Error(`unknown agent tool: ${name}`);
}

async function upload(req, res) {
  try {
    const name = decodeURIComponent(String(req.headers['x-filename'] ?? 'file'));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const saved = await uploads.save(name, Buffer.concat(chunks), store.runId);
    json(res, 200, { ok: true, file: saved });
  } catch (error) {
    json(res, 400, { ok: false, error: error.message });
  }
}

async function serveTextResource(path, res) {
  try {
    const info = await stat(path);
    if (!info.isFile()) return json(res, 404, { error: 'not found' });
    if (info.size > MAX_REFERENCE_BYTES) {
      return json(res, 413, { error: 'file is too large to preview' });
    }
    const body = await readFile(path);
    if (body.includes(0)) return json(res, 415, { error: 'binary files cannot be previewed' });
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    return res.end(body);
  } catch {
    return json(res, 404, { error: 'not found' });
  }
}

async function serveStatic(pathname, res) {
  // Asset paths contain spaces ("Models/GLTF format"), so decode before joining.
  const decoded = decodeURIComponent(pathname);
  const relative = normalize(decoded === '/' ? '/floor.html' : decoded).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, relative);
  if (!file.startsWith(ROOT)) return json(res, 403, { error: 'forbidden' });
  try {
    const body = await readFile(file);
    const type = extname(file);
    // Code changes constantly while this is being built; a cached module means
    // the user is looking at a version that no longer exists. Assets may cache.
    const volatile = type === '.mjs' || type === '.js' || type === '.html' || type === '.css';
    res.writeHead(200, {
      'content-type': MIME[type] ?? 'application/octet-stream',
      'cache-control': volatile ? 'no-store, must-revalidate' : 'public, max-age=3600',
    });
    res.end(body);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// One engine for every seat, for a demo or a bake-off. Without it each agent
// keeps the engine set on the roster.
function forceEngine(agents, engine) {
  if (!engine) return agents;
  return Object.keys(agents).reduce(
    (configured, agentId) => assignEngine(configured, agentId, engine),
    agents,
  );
}

// A flag whose "value" is the next flag was never given a value.
function value(raw) {
  return typeof raw === 'string' && raw.startsWith('--') ? true : raw;
}

function parseArgs(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) flags.set(argv[i].slice(2), argv[i + 1] ?? true);
  }
  return {
    port: Number(flags.get('port') ?? 4600),
    repo: resolve(String(flags.get('repo') ?? process.cwd())),
    codexUrl: String(flags.get('codex-url') ?? 'ws://127.0.0.1:4573'),
    // --remote-control on its own is the orchestrator, which is the point of
    // the flag; `all` is every seat and `off` is nobody. A bare flag followed
    // by another flag is still a bare flag.
    remote: remoteMode(value(flags.get('remote-control'))),
    // --contract still names the file the standing instruction is seeded from.
    contractPath: flags.get('contract') ? String(flags.get('contract')) : null,
    hookPath: flags.get('hook') ? String(flags.get('hook')) : null,
    hookText: '',
    skills: String(flags.get('skills') ?? '').split(',').filter(Boolean),
    isolate: flags.get('isolate') === true || flags.get('isolate') === 'true',
    mission: String(flags.get('mission') ?? ''),
    engine: flags.get('engine') ? String(flags.get('engine')) : null,
    rosterPath: flags.get('roster') ? String(flags.get('roster')) : null,
    team: String(flags.get('team') ?? 'the Avengers'),
    rosterOverrides: {},
  };
}

// Appended to every message to every agent, first dispatch and every steer.
if (options.hookPath) {
  options.hookText = await readFile(options.hookPath, 'utf8').catch(() => '');
}

// The engineering contract is a property of the REPO, not of how the server was
// launched. Requiring --contract meant it was silently absent every time it was
// forgotten - which was every time.
const CONTRACT_FILES = [
  '.codex/ENGINEERING_CONTRACT.md',
  '.claude/ENGINEERING_CONTRACT.md',
  'ENGINEERING_CONTRACT.md',
];

async function findContract(repo, explicit) {
  if (explicit) {
    return { text: await readFile(explicit, 'utf8').catch(() => ''), from: explicit };
  }
  for (const name of CONTRACT_FILES) {
    const path = join(repo, name);
    const text = await readFile(path, 'utf8').catch(() => null);
    if (text?.trim()) return { text, from: path };
  }
  return { text: '', from: null };
}

const contract = await findContract(options.repo, options.contractPath);
// The repo's engineering contract IS the standing instruction. There is one
// channel, and this is what it starts with; POLICY appends to the same text.
options.contractFrom = contract.from;
options.hookText = [options.hookText, contract.text].filter((part) => part?.trim()).join('\n\n');

// A run is created when work actually begins, not when the server boots -
// otherwise every restart leaves an empty "unnamed run" in the history.
function ensureRun() {
  if (store.runId !== null) return store.runId;
  const id = store.startRun(state.mission, options.repo);
  for (const agent of Object.values(state.agents)) store.saveEngine(agent.id, agent.engine);
  return id;
}

// A restart is NOT the end of a run. Do not send an engine interrupt. Persist
// every conversation handle, leave the run open, and reconcile it at startup.
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  ciWatcher.stop();
  for (const agent of Object.values(state.agents)) {
    for (const worker of ensureWorkers(agent)) store.saveWorkerSession(worker);
  }
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { void shutdown(); });
}

// Codex agents need a daemon listening before they can start. Bringing it up
// here means a blocked crew is never waiting on a command in another terminal.
// Nothing is adopted: a daemon that is already running stays running when we
// exit, and one we started dies with us.
async function ensureEngines() {
  const codex = Object.values(state.agents).filter((agent) => agent.engine === ENGINES.CODEX);
  if (codex.length === 0) return;
  // Codex has no per-session switch, so wanting it for ONE codex seat means
  // every session on that daemon gets it. Said out loud rather than assumed.
  const remote = codex.some((agent) => wantsRemote(agent, options.remote));
  const result = await ensureCodexServer({
    url: options.codexUrl,
    remoteControl: remote,
    onLog: (line) => process.stdout.write(`codex: ${line}\n`),
  });
  if (remote && result.started) {
    process.stdout.write(
      `codex remote control: on for every codex seat - ${codex.map((a) => a.label).join(', ')}\n`,
    );
  }
  process.stdout.write(`codex app-server: ${result.reason}\n`);
  if (result.ok && result.started) {
    process.on('exit', () => result.stop?.());
  }
  if (!result.ok) {
    // Said on the floor as well as the terminal: a crew that cannot start is a
    // decision, not a log line.
    ingest(createEvent('minimac', EVENT_KINDS.STATUS, {
      text: `codex is not available - ${result.reason}`,
      from: 'you',
    }));
  }
}

// What the operator gets told about who is reachable from elsewhere. Named
// seats, not a mode word: "boss" means nothing on a phone, "minimac-thor" is
// the thing you will be looking at.
function remoteLine() {
  if (options.remote === REMOTE.OFF) return 'off - every session stays on this machine';
  const named = Object.values(state.agents)
    .filter((agent) => wantsRemote(agent, options.remote))
    .map((agent) => `${remoteName(agent, { team: options.team })} (${agent.label})`);
  return named.length ? named.join(', ') : 'nobody on this roster';
}

server.listen(options.port, async () => {
  process.stdout.write(
    `minimac on http://127.0.0.1:${options.port}  repo=${options.repo}\n`,
  );
  process.stdout.write(
    options.contractFrom
      ? `engineering contract: ${options.contractFrom}\n`
      : 'engineering contract: NONE FOUND - agents are working without one\n',
  );
  process.stdout.write(`remote control: ${remoteLine()}\n`);
  await ensureEngines();
  await reconcileAdoptedSessions();
  ciWatcher.start();
  publish({ type: 'state', state: snapshot() });
});
