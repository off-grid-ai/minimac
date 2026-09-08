// The crew. Roles are data, not code - adding one is a row here, and the
// engine behind any of them is switchable at any time from the floor.

import { createWorker, hasLiveWorker } from './workers.mjs';

export const ENGINES = Object.freeze({ CODEX: 'codex', CLAUDE: 'claude', SIM: 'sim' });

export const MODEL_OPTIONS = Object.freeze({
  [ENGINES.CODEX]: Object.freeze([
    { value: '', label: 'DEFAULT' },
    { value: 'gpt-6-astra', label: 'GPT-6 ASTRA' },
    { value: 'gpt-5.6-sol', label: 'GPT-5.6 SOL' },
    { value: 'gpt-5.6-terra', label: 'GPT-5.6 TERRA' },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6 LUNA' },
    { value: 'gpt-5.5', label: 'GPT-5.5' },
  ]),
  [ENGINES.CLAUDE]: Object.freeze([
    { value: 'claude-opus-5', label: 'OPUS 5' },
    { value: 'sonnet', label: 'SONNET' },
    { value: 'haiku', label: 'HAIKU' },
  ]),
  [ENGINES.SIM]: Object.freeze([{ value: '', label: 'SIM' }]),
});

export const EFFORT_OPTIONS = Object.freeze({
  [ENGINES.CODEX]: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  [ENGINES.CLAUDE]: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
  [ENGINES.SIM]: Object.freeze(['medium']),
});

export function defaultRuntime(engine) {
  return {
    model: engine === ENGINES.CLAUDE ? 'claude-opus-5' : '',
    effort: 'medium',
  };
}

export const ROLES = Object.freeze({
  ORCHESTRATOR: 'orchestrator',
  CODER: 'coder',
  TESTER: 'tester',
  AUDITOR: 'auditor',
  REVIEWER: 'reviewer',
  UX: 'ux',
  PRODUCT: 'product',
});

export const DEFAULT_ROSTER = Object.freeze([
  {
    id: 'minimac', name: 'Thor', role: ROLES.ORCHESTRATOR, engine: ENGINES.CODEX,
    color: '#2b2f36', move: 'lightning',
  },
  {
    id: 'coder', name: 'Ironman', role: ROLES.CODER, engine: ENGINES.CODEX,
    color: '#c8541f', move: 'repulsor',
  },
  {
    id: 'tester', name: 'Hulk', role: ROLES.TESTER, engine: ENGINES.CLAUDE,
    color: '#4f8a4a', move: 'smash',
  },
  {
    id: 'auditor', name: 'Strange', role: ROLES.AUDITOR, engine: ENGINES.CLAUDE,
    color: '#1f8f8a', move: 'portal',
  },
  {
    id: 'reviewer', name: 'Capt. Marvel', role: ROLES.REVIEWER, engine: ENGINES.CLAUDE,
    color: '#3a63c4', move: 'binary',
  },
  {
    id: 'ux', name: 'Vision', role: ROLES.UX, engine: ENGINES.CODEX,
    color: '#d99a3f', move: 'beam',
  },
  {
    id: 'pm', name: 'Wanda', role: ROLES.PRODUCT, engine: ENGINES.CLAUDE,
    color: '#a33a4a', move: 'hex',
  },
]);

// One place decides how an agent is written, so the floor, the panels and the
// composer never disagree. A persona keeps its seat visible: "Thor (minimac)".
export function agentLabel(name, id) {
  return name.toLowerCase() === id.toLowerCase() ? name : `${name} (${id})`;
}

export function createAgent(spec) {
  const runtime = defaultRuntime(spec.engine);
  const instances = Math.max(1, Number(spec.instances) || 1);
  return {
    id: spec.id,
    name: spec.name,
    label: agentLabel(spec.name, spec.id),
    role: spec.role,
    engine: spec.engine,
    model: spec.model ?? runtime.model,
    effort: spec.effort ?? runtime.effort,
    // Optional per-agent look, read by the scene. Never required.
    mesh: spec.mesh ?? null,
    move: spec.move ?? null,
    // A crew member you do not need on this mission. Kept in the roster, but
    // never dispatched and never shown on the floor.
    enabled: spec.enabled !== false,
    // One desk on the floor, this many real sessions behind it. Thor is told
    // the count and must split the work into disjoint, verifiable slices.
    instances,
    color: spec.color ?? null,
    workers: Array.from({ length: instances }, (_, index) => createWorker(spec.id, index)),
    status: 'idle', // idle | running | blocked | stopped
    blockedReason: null,
    claims: [],
    diffLines: 0,
    lastEventTs: null,
  };
}

// The mission switch means "working now". Mission membership and engine
// lifecycle stay separate inside the server; consumers get this one read-only
// projection and never have to rebuild the rule themselves.
export function isActive(agent) {
  return agent?.enabled !== false && hasLiveWorker(agent);
}

export function createRoster(specs = DEFAULT_ROSTER, overrides = {}) {
  return Object.fromEntries(
    specs.map((spec) => {
      const override = overrides[spec.id] ?? {};
      // Roles and ids are the product; names and looks are personal taste.
      return [spec.id, createAgent({ ...spec, ...override, id: spec.id, role: spec.role })];
    }),
  );
}

export function assignEngine(agents, agentId, engine) {
  if (!Object.values(ENGINES).includes(engine)) {
    throw new Error(`unknown engine: ${engine}`);
  }
  const agent = agents[agentId];
  if (!agent) throw new Error(`unknown agent: ${agentId}`);
  return { ...agents, [agentId]: { ...agent, engine, ...defaultRuntime(engine) } };
}

export function configureRuntime(agents, agentId, { model, effort }) {
  const agent = agents[agentId];
  if (!agent) throw new Error(`unknown agent: ${agentId}`);
  const models = MODEL_OPTIONS[agent.engine] ?? [];
  const efforts = EFFORT_OPTIONS[agent.engine] ?? [];
  const nextModel = model === undefined ? agent.model : String(model);
  const nextEffort = effort === undefined ? agent.effort : String(effort);
  if (!models.some((option) => option.value === nextModel)) {
    throw new Error(`unknown ${agent.engine} model: ${nextModel || 'default'}`);
  }
  if (!efforts.includes(nextEffort)) {
    throw new Error(`unknown ${agent.engine} effort: ${nextEffort}`);
  }
  return { ...agents, [agentId]: { ...agent, model: nextModel, effort: nextEffort } };
}

export function workersOf(agents) {
  return Object.values(agents).filter((agent) => agent.role !== ROLES.ORCHESTRATOR);
}
