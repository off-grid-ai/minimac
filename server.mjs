// Transport and wiring only. Every rule lives in core/; every I/O detail lives
// in adapters/. This file moves messages between them.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appendEvent,
  BLOCKED_REASONS,
  createBlockedEvent,
  createEvent,
  EVENT_KINDS,
  eventsFor,
} from './core/events.mjs';
import { createRoster, assignEngine, DEFAULT_ROSTER, ENGINES, ROLES } from './core/roster.mjs';
import { setGoal, getGoal, clearGoal, deriveGoals } from './core/goals.mjs';
import { claimFiles, releaseClaim } from './core/claims.mjs';
import {
  composeDispatch,
  buildOutputSchema,
  withHook,
  REPORT_FENCE,
  GOALS_FENCE,
  planningTask,
  EDITABLE_STEPS,
  defaultStepText,
  dispatchPipeline,
} from './core/dispatch.mjs';
import { createDriverRegistry } from './ports/driver.mjs';
import { createCodexDriver } from './adapters/codex.mjs';
import { createClaudeDriver } from './adapters/claude.mjs';
import { createSimDriver } from './adapters/sim.mjs';
import { createStore } from './adapters/store.mjs';
import { createWorktrees } from './adapters/git.mjs';
import { createRepoIndex } from './adapters/fs.mjs';
import { createUploads } from './adapters/uploads.mjs';
import { parseMentions, routeOf } from './core/mentions.mjs';

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
  awaitingGoals: false,
  mission: options.mission,
};

state.goals = deriveGoals(state.goals, state.agents, state.mission);

const store = createStore({ file: join(ROOT, 'data', 'minimac.db') });
const worktrees = createWorktrees({ repo: options.repo, root: join(ROOT, 'worktrees') });
const repoIndex = createRepoIndex();
const uploads = createUploads({ dir: join(ROOT, 'data', 'attachments') });
// How this fleet is told to work. Survives runs and restarts.
const middleware = store.middleware();
const getDriver = createDriverRegistry({
  [ENGINES.CODEX]: createCodexDriver({ url: options.codexUrl }),
  [ENGINES.CLAUDE]: createClaudeDriver({}),
  [ENGINES.SIM]: createSimDriver(),
});

for (const engine of Object.values(ENGINES)) {
  getDriver(engine).onEvent(ingest);
}

const subscribers = new Set();

// ---------------------------------------------------------------- ingestion

// An agent's report arrives inside its prose. Pulling it out here means both
// engines produce the same flows and claims without either CLI having to
// support a schema flag.
const REPORT_BLOCK = new RegExp('```' + REPORT_FENCE + '\\s*([\\s\\S]*?)```');
const GOALS_BLOCK = new RegExp('```' + GOALS_FENCE + '\\s*([\\s\\S]*?)```');

// The orchestrator's answer to "what should each of them be doing".
function harvestGoals(event) {
  const match = GOALS_BLOCK.exec(String(event.payload?.text ?? ''));
  if (!match) return;

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return;
  }

  let applied = 0;
  for (const [agentId, objective] of Object.entries(parsed.goals ?? {})) {
    if (!state.agents[agentId] || typeof objective !== 'string' || !objective.trim()) continue;
    state.goals = setGoal(state.goals, agentId, objective.trim(), null, 'active', 'derived');
    store.saveGoal(agentId, getGoal(state.goals, agentId));
    applied += 1;
  }
  if (applied > 0) startCrew(`${event.agentId} set goals for ${applied} agents`);
}

function harvestReport(event) {
  if (event.kind !== EVENT_KINDS.MESSAGE) return;
  const match = REPORT_BLOCK.exec(String(event.payload?.text ?? ''));
  if (!match) return;

  let report;
  try {
    report = JSON.parse(match[1]);
  } catch {
    return; // a malformed block is not a report; the prose still stands
  }

  if (Array.isArray(report.flows) && report.flows.length > 0) {
    ingest(createEvent(event.agentId, EVENT_KINDS.PLAN, { steps: report.flows }));
  }
  for (const claim of report.claims ?? []) {
    ingest(createEvent(event.agentId, EVENT_KINDS.CLAIM, claim));
  }
}

function ingest(event) {
  state.events = appendEvent(state.events, event);
  state.agents = applyToAgent(state.agents, event);
  store.record(event);
  publish({ type: 'event', event, agent: state.agents[event.agentId] });
  harvestReport(event);
  if (event.kind === EVENT_KINDS.MESSAGE) harvestGoals(event);
}

function applyToAgent(agents, event) {
  const agent = agents[event.agentId];
  if (!agent) return agents;
  const next = { ...agent, lastEventTs: event.ts };

  if (event.kind === EVENT_KINDS.STATUS && event.payload.state) {
    next.status = event.payload.state;
  }
  if (event.kind === EVENT_KINDS.PLAN) {
    next.flows = mergeFlows(agent.flows, event.payload.steps ?? []);
  }
  if (event.kind === EVENT_KINDS.DIFF) {
    next.diffLines = event.payload.lines ?? agent.diffLines;
  }
  if (event.kind === EVENT_KINDS.BLOCKED) {
    next.status = 'blocked';
    next.blockedReason = event.payload.reason ?? null;
  }
  return { ...agents, [event.agentId]: next };
}

// Estimates come from the first plan and are never silently rewritten, so a
// later plan cannot quietly move the goalposts.
function mergeFlows(existing, incoming) {
  return incoming.map((step, index) => {
    const previous = existing[index];
    return {
      ...step,
      estimateMs: previous?.estimateMs ?? step.estimateMs ?? null,
      actualMs: step.actualMs ?? previous?.actualMs ?? 0,
    };
  });
}

// One seat, one or more workers. Each gets its own session and its own slice
// label, and every event still carries the seat's id - so the floor shows one
// desk while the work runs in parallel behind it.
async function startWorkers(agent, cwd, task, mentions, attachments) {
  const driver = getDriver(agent.engine);
  const sessionIds = [];

  for (let index = 0; index < agent.instances; index += 1) {
    const instance = agent.instances > 1
      ? { index: index + 1, label: `${agent.name} #${index + 1}` }
      : null;
    const prompt = composeDispatch({
      agent,
      instance,
      goal: getGoal(state.goals, agent.id),
      task: task ?? state.mission,
      contractText: options.contractText,
      skills: options.skills,
      claims: state.claims[agent.id] ?? [],
      mentions,
      attachments: [...(state.attachments ?? []), ...attachments],
      crew: crewRoster(),
      team: options.team,
      hook: options.hookText,
      overrides: middleware,
    });
    sessionIds.push(await driver.start(agent, cwd, prompt));
  }

  state.agents = patchAgent(state.agents, agent.id, { sessionIds });
  return sessionIds[0];
}

// A steer reaches every worker behind the seat, not just the first.
async function eachSession(agent, action) {
  const ids = agent.sessionIds?.length ? agent.sessionIds : [agent.sessionId].filter(Boolean);
  for (const id of ids) await action(id).catch(() => {});
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
    claims: state.claims[agent.id] ?? [],
  }));
}

// What a step currently says: the override if there is one, otherwise the
// built-in default, otherwise whatever was loaded from a file at launch.
function middlewareText(name) {
  if (typeof middleware[name] === 'string') return middleware[name];
  if (name === 'contract') return options.contractText ?? '';
  if (name === 'hook') return options.hookText ?? '';
  return defaultStepText(name);
}

const PLANNING_TIMEOUT_MS = 180_000;

// Start everyone except the orchestrator, which is already running.
function startCrew(note) {
  if (!state.awaitingGoals) return;
  state.awaitingGoals = false;
  ingest(
    createEvent('minimac', EVENT_KINDS.STATUS, {
      text: note ?? 'goals set by the orchestrator - starting the crew',
      from: 'you',
    }),
  );
  for (const agent of Object.values(state.agents)) {
    if (agent.role === 'orchestrator' || agent.sessionId) continue;
    COMMANDS.start({ agentId: agent.id }).catch(() => {});
  }
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

// ----------------------------------------------------------------- commands

const COMMANDS = {
  // One mission in, a goal on every seat out. Nothing is ever dispatched blind.
  async setMission({ mission, attachments = [] }) {
    state.mission = mission;
    ensureRun();
    state.attachments = attachments;
    // The run is titled by its mission, and the mission usually arrives after
    // the run has started, so the record has to be told.
    store.renameRun(mission);
    state.goals = deriveGoals(state.goals, state.agents, mission);
    for (const [agentId, goal] of Object.entries(state.goals)) store.saveGoal(agentId, goal);
    // Say it out loud on the floor, so a submit is never silent.
    ingest(
      createEvent('minimac', EVENT_KINDS.MESSAGE, {
        text: `mission set: ${mission}`,
        attachments,
        from: 'you',
      }),
    );
    // The orchestrator sets the crew's goals before the crew starts. The
    // role templates above are only a floor, so nothing is ever goal-less if
    // this planning turn fails or times out.
    const orchestrator = Object.values(state.agents).find((a) => a.role === 'orchestrator');
    if (!orchestrator) return { mission, goals: state.goals };

    state.awaitingGoals = true;
    await COMMANDS.start({
      agentId: orchestrator.id,
      task: planningTask(mission, crewRoster()),
    }).catch(() => {});

    // If no goals come back, the crew still starts - late is better than never.
    setTimeout(() => {
      if (state.awaitingGoals) startCrew('the orchestrator did not set goals in time');
    }, PLANNING_TIMEOUT_MS);

    return { mission, goals: state.goals, planning: true };
  },

  // A run is a conversation with the fleet. Starting a new one closes the old
  // record and resets the floor; the old one stays readable in the database.
  // Stop everything without losing it: agents are interrupted, the run is
  // closed in the record, and what happened stays on screen to be read.
  async stopRun() {
    const stopped = [];
    for (const agent of Object.values(state.agents)) {
      if (!agent.sessionId) continue;
      await getDriver(agent.engine).interrupt(agent.sessionId).catch(() => {});
      state.agents = patchAgent(state.agents, agent.id, { status: 'stopped', sessionId: null });
      stopped.push(agent.id);
    }
    store.finishRun();
    ingest(
      createEvent('minimac', EVENT_KINDS.STATUS, {
        state: 'idle',
        text: stopped.length ? `run stopped: ${stopped.join(', ')}` : 'run stopped',
        from: 'you',
      }),
    );
    return { stopped };
  },

  // Continue an old run: the SAME conversations, picked up where they stopped.
  // The agents keep everything they already worked out, which is the whole
  // difference between continuing and starting over.
  async continueRun({ runId, note }) {
    const previous = store.getRun(Number(runId));
    if (!previous) throw new Error(`no run ${runId}`);

    // Continue always continues. Where a session survives, the agent keeps its
    // memory; where it does not, that agent starts fresh on the same goal and
    // the feed says which ones lost their thread. A dead button is never the
    // right answer.
    const sessions = new Map(
      store.sessionsFor(Number(runId)).map((row) => [row.agent_id, row.session_id]),
    );

    // Continuing opens a NEW run record carrying the old mission, so the fleet
    // has one current run and the history stays honest about what happened when.
    store.finishRun();
    state.events = [];
    state.mission = previous.mission;
    store.startRun(state.mission, options.repo);
    for (const agent of Object.values(state.agents)) store.saveEngine(agent.id, agent.engine);

    for (const row of store.goalsFor(Number(runId))) {
      if (row.objective) {
        state.goals = setGoal(state.goals, row.agent_id, row.objective, row.token_budget, 'active', 'manual');
      }
    }

    const prompt = note
      ?? 'Continue where you left off. Restate in one line what you were doing, then carry on.';
    const resumed = [];
    const restarted = [];

    for (const agent of Object.values(state.agents)) {
      const previousSession = sessions.get(agent.id);
      const driver = getDriver(agent.engine);
      try {
        if (!previousSession) throw new Error('no session recorded');
        if (typeof driver.resume !== 'function') throw new Error('engine cannot resume');
        const sessionId = await driver.resume(agent, options.repo, previousSession, prompt);
        state.agents = patchAgent(state.agents, agent.id, { sessionId, status: 'running' });
        store.saveSession(agent.id, sessionId, agent.engine);
        resumed.push(agent.id);
      } catch {
        await COMMANDS.start({ agentId: agent.id }).catch(() => {});
        restarted.push(agent.id);
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
    return { resumed, restarted };
  },

  // Run an old one again: its mission and the goals as they were, in a fresh
  // run record so the original stays intact and comparable.
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
    for (const agent of Object.values(state.agents)) {
      if (agent.sessionId) await getDriver(agent.engine).interrupt(agent.sessionId).catch(() => {});
    }
    store.finishRun();
    state.agents = forceEngine(createRoster(DEFAULT_ROSTER, options.rosterOverrides), options.engine);
    state.goals = {};
    state.claims = {};
    state.events = [];
    state.mission = mission ?? '';
    const id = store.startRun(state.mission, options.repo);
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

  async start({ agentId, task, mentions = null, attachments = [] }) {
    if (state.agents[agentId]?.enabled === false) return { skipped: 'disabled' };
    ensureRun();
    const agent = state.agents[agentId];
    const goal = getGoal(state.goals, agentId);
    if (!goal?.objective) throw new Error(`${agentId} has no goal - set the mission first`);
    const cwd = options.isolate ? await worktrees.create(agentId) : options.repo;
    const prompt = composeDispatch({
      agent,
      goal,
      task: task ?? state.mission,
      contractText: options.contractText,
      skills: options.skills,
      claims: state.claims[agentId] ?? [],
      mentions,
      attachments: [...(state.attachments ?? []), ...attachments],
      crew: crewRoster(),
      team: options.team,
      hook: options.hookText,
      overrides: middleware,
    });
    let sessionId;
    try {
      sessionId = await startWorkers(agent, cwd, task, mentions, attachments);
    } catch (error) {
      ingest(
        createBlockedEvent(agentId, {
          category: BLOCKED_REASONS.ERROR,
          reason: `${agent.engine} could not start: ${error.message}`,
        }),
      );
      throw error;
    }
    // Re-read: events arriving during the await already changed this agent.
    state.agents = patchAgent(state.agents, agentId, { sessionId, status: 'running' });
    store.saveSession(agentId, sessionId, agent.engine);
    return { sessionId, workers: agent.instances };
  },

  // The composer's single verb. One line of text, whatever it names, ends up
  // in exactly one place: the mission, or one agent.
  async say({ target, text, attachments = [] }) {
    const parsed = parseMentions(text, { agentIds: Object.keys(state.agents) });
    // A pasted path is an attachment, so dragging a file in and pasting its
    // path behave the same way.
    for (const path of await repoIndex.existingPaths(text)) {
      if (!attachments.some((file) => file.path === path)) {
        attachments = [...attachments, { path, name: path.split('/').pop(), type: 'file' }];
      }
    }
    if (parsed.files.length > 0 && target !== 'mission') {
      await COMMANDS.claim({ agentId: routeOf(parsed, target), patterns: parsed.files });
    }
    if (target === 'mission') return COMMANDS.setMission({ mission: text, attachments });

    const agentId = routeOf(parsed, target);
    const agent = state.agents[agentId];
    if (!agent) throw new Error(`unknown agent: ${agentId}`);
    ingest(createEvent(agentId, EVENT_KINDS.MESSAGE, { text, from: 'you', attachments }));
    const body = attachments.length > 0 ? `${text}\n\n${attachmentLines(attachments)}` : text;
    return agent.sessionId
      ? COMMANDS.steer({ agentId, text: body })
      : COMMANDS.start({ agentId, task: text, mentions: parsed, attachments });
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
    if (!agent?.sessionId) throw new Error(`${agentId} is not running`);
    const driver = getDriver(agent.engine);
    if (typeof driver.approve === 'function') {
      await driver.approve(agent.sessionId, approvalId, decision);
    } else {
      await driver.steer(agent.sessionId, decision);
    }
    ingest(createEvent(agentId, EVENT_KINDS.STATUS, { approvalId, decision, from: 'you' }));
    return {};
  },

  async steer({ agentId, text }) {
    const agent = state.agents[agentId];
    if (!agent?.sessionId) throw new Error(`${agentId} is not running`);
    await eachSession(agent, (id) =>
      getDriver(agent.engine).steer(id, withHook(text, options.hookText, middleware)));
    ingest(createEvent(agentId, EVENT_KINDS.MESSAGE, { text, from: 'you' }));
    return {};
  },

  async interrupt({ agentId }) {
    const agent = state.agents[agentId];
    if (agent) await eachSession(agent, (id) => getDriver(agent.engine).interrupt(id));
    state.agents = patchAgent(state.agents, agentId, {
      status: 'stopped', sessionId: null, sessionIds: [],
    });
    return {};
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
    if (agent?.sessionId) {
      await getDriver(agent.engine).setGoal(agent.sessionId, objective, tokenBudget, status);
    }
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
    state.agents = patchAgent(state.agents, agentId, { instances: count });
    return { agentId, instances: count };
  },

  async setEnabled({ agentId, enabled }) {
    const agent = state.agents[agentId];
    if (!agent) throw new Error(`unknown agent: ${agentId}`);
    if (!enabled && agent.sessionId) await COMMANDS.interrupt({ agentId });
    state.agents = patchAgent(state.agents, agentId, { enabled: !!enabled });
    return { agentId, enabled: !!enabled };
  },

  async assignEngine({ agentId, engine }) {
    state.agents = assignEngine(state.agents, agentId, engine);
    store.saveEngine(agentId, engine);
    return { engine };
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

async function handleCommand(cmd) {
  const command = COMMANDS[cmd.type];
  if (!command) throw new Error(`unknown command: ${cmd.type}`);
  const result = await command(cmd);
  publish({ type: 'state', state: snapshot() });
  return result;
}

// -------------------------------------------------------------------- wire

function snapshot() {
  return {
    agents: state.agents,
    goals: state.goals,
    claims: state.claims,
    mission: state.mission,
    repo: options.repo,
    runId: store.runId,
    schema: buildOutputSchema(),
  };
}

function publish(message) {
  const frame = `data: ${JSON.stringify(message)}\n\n`;
  for (const res of subscribers) res.write(frame);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/events') return subscribe(res);
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
    return json(res, 200, { skills: await repoIndex.skills(options.repo) });
  }
  if (url.pathname === '/runs') {
    return json(res, 200, { runs: store.listRuns(Number(url.searchParams.get('limit') ?? 20)) });
  }
  if (url.pathname === '/replay') {
    const runId = Number(url.searchParams.get('run'));
    const agentId = url.searchParams.get('agent');
    const events = agentId ? store.replay(runId, agentId) : store.replayRun(runId);
    return json(res, 200, { events });
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
  return Object.fromEntries(
    Object.entries(agents).map(([id, agent]) => [id, { ...agent, engine }]),
  );
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
    contractPath: flags.get('contract') ? String(flags.get('contract')) : null,
    contractText: '',
    hookPath: flags.get('hook') ? String(flags.get('hook')) : null,
    hookText: '',
    skills: String(flags.get('skills') ?? '').split(',').filter(Boolean),
    isolate: flags.get('isolate') === true || flags.get('isolate') === 'true',
    mission: String(flags.get('mission') ?? ''),
    engine: flags.get('engine') ? String(flags.get('engine')) : null,
    rosterPath: flags.get('roster') ? String(flags.get('roster')) : null,
    team: String(flags.get('team') ?? 'the crew'),
    rosterOverrides: {},
  };
}

// Appended to every message to every agent, first dispatch and every steer.
if (options.hookPath) {
  options.hookText = await readFile(options.hookPath, 'utf8').catch(() => '');
}

if (options.contractPath) {
  options.contractText = await readFile(options.contractPath, 'utf8').catch(() => '');
}

// A run is created when work actually begins, not when the server boots -
// otherwise every restart leaves an empty "unnamed run" in the history.
function ensureRun() {
  if (store.runId !== null) return store.runId;
  const id = store.startRun(state.mission, options.repo);
  for (const agent of Object.values(state.agents)) store.saveEngine(agent.id, agent.engine);
  return id;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    store.finishRun();
    process.exit(0);
  });
}

server.listen(options.port, () => {
  process.stdout.write(
    `minimac on http://127.0.0.1:${options.port}  repo=${options.repo}\n`,
  );
});
