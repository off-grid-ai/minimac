// The middleware. Every dispatch to every engine is composed here, so the
// engineering contract, the role, the goal and the output shape are enforced
// once instead of re-typed each session.

import { ROLES } from './roster.mjs';
import { createPipeline, defineStep } from './middleware.mjs';

export const STEP_STATUS = Object.freeze({
  CODED: 'coded',
  WIRED: 'wired',
  VERIFIED: 'verified',
});

const ROLE_PROMPTS = Object.freeze({
  [ROLES.ORCHESTRATOR]:
    'You route work. You do not write production code. You assign tasks to workers, ' +
    'watch their flows, and escalate to the human when two workers disagree on a fact ' +
    'or a worker fails the same step twice.',
  [ROLES.CODER]:
    'You write the smallest coherent change that satisfies the flow contract. ' +
    'You touch only files inside your claim.',
  [ROLES.TESTER]:
    'You verify flows by running real commands. Your verdict is an exit code, never an opinion. ' +
    'You do not edit production code.',
  [ROLES.AUDITOR]:
    'You review the diff against the contract. Every finding names a file and a line. ' +
    'A finding you cannot point at does not exist.',
  [ROLES.UX]:
    'You own what the user sees and does. You express work as user flows and reject any ' +
    'step that cannot be described as something a person perceives.',
  [ROLES.PRODUCT]:
    'You own the flow contract and its acceptance criteria. You write them before any code ' +
    'and you do not revise them mid-run without saying so explicitly.',
});

// The one rule that ends "talk to me in user flows": it is the only valid
// shape, so it cannot be forgotten.
export function buildOutputSchema() {
  return {
    type: 'object',
    required: ['flows', 'claims'],
    properties: {
      flows: {
        type: 'array',
        items: {
          type: 'object',
          required: ['step', 'user_visible_result', 'status'],
          properties: {
            step: { type: 'string' },
            user_visible_result: {
              type: 'string',
              description: 'What a person sees or can do. Never a file or a command.',
            },
            status: { type: 'string', enum: Object.values(STEP_STATUS) },
            estimateMs: { type: 'integer' },
            actualMs: { type: 'integer' },
            evidence: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      claims: {
        type: 'array',
        items: {
          type: 'object',
          required: ['text', 'receipt'],
          properties: {
            text: { type: 'string' },
            receipt: {
              type: 'string',
              description: 'The exact command or file read that produced this. Empty if none.',
            },
            derivedFrom: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  };
}

// The one block every agent must emit. Neither CLI reliably honours a JSON
// schema flag mid-conversation, so the contract is carried in the message
// itself and parsed back out - the same shape from both engines.
export const REPORT_FENCE = 'minimac';

export function reportInstruction() {
  return [
    '# How you must report',
    '',
    'END EVERY REPLY with a fenced block exactly like this, and nothing after it:',
    '',
    '```' + REPORT_FENCE,
    '{',
    '  "flows": [',
    '    {"step": "what you are doing", "user_visible_result": "what a person can see",',
    '     "status": "coded|wired|verified", "estimateMs": 300000}',
    '  ],',
    '  "claims": [',
    '    {"text": "a factual statement", "receipt": "the exact command that produced it"}',
    '  ]',
    '}',
    '```',
    '',
    'Rules for that block:',
    '- flows is your whole plan, restated every time, with each step\'s current status.',
    '- user_visible_result is what a PERSON sees. Never a file, command or count.',
    '- Every number you state anywhere goes in claims with the command that produced it.',
    '- If you have no command behind a number, set receipt to "" and say so.',
    '- If your work no longer matches your goal, say so in a flow step rather than continuing.',
  ].join('\n');
}

// The house style. This is the middleware's whole point: an agent's default
// register is a wall of commands and counts, and nobody can govern from that.
// It rides on EVERY message, first dispatch and every steer, because a style
// asked for once is dropped by the third turn.
export function plainLanguageRules() {
  return [
    '# How to write, on every single message',
    '',
    'Write so a product person can follow it without opening a terminal.',
    '',
    '- Under five lines per reply, unless Mac asks for more.',
    '- One idea per sentence. Twenty words at most.',
    '- Bullet points, not paragraphs. Never a wall of text.',
    '- Simple words. No jargon, no idioms, no abbreviations a newcomer would not know.',
    '- Active voice, present tense. "The push fails", not "it was found that the push had failed".',
    '- Lead with the outcome, then the detail. Never the other way round.',
    '- Describe what a PERSON can see or do. Not files, commands, or line counts.',
    '- A command belongs in a receipt, never in a sentence.',
    '- If you must name something technical, say in plain words what it is for.',
    '',
    'Before any detail, give one line: what you are doing, and what it will let Mac do.',
  ].join('\n');
}

const REPORTING_RULES = [
  'Report every step as a user flow: what the person does, and what they then see.',
  'Never report progress as files touched, commands run, or percentages.',
  'A step is "coded" until it is wired, and "wired" until it is proved on the real surface.',
  'Every factual claim carries the exact command that produced it. If you did not run one, say so.',
  'Estimate each step in minutes before you start it, and report the actual when it closes.',
  'If you repeat the same read or the same command three times, stop and report blocked.',
].join('\n- ');

export function composeDispatch(context) {
  return dispatchPipeline(context.extraSteps ?? []).compose(context).text;
}

// One ordered list, so what an agent is told is readable top to bottom, and a
// new rule is a new entry rather than a new branch.
// Which steps a person may rewrite from the UI, and the default each falls
// back to. Dynamic steps (role, goal, crew, task) are composed from live state
// and are deliberately not editable as free text.
export const EDITABLE_STEPS = Object.freeze(['plain-language', 'reporting', 'report-block', 'contract', 'hook']);

export function defaultStepText(name) {
  if (name === 'plain-language') return plainLanguageRules();
  if (name === 'reporting') return `# Reporting rules\n\n- ${REPORTING_RULES}`;
  if (name === 'report-block') return reportInstruction();
  return '';
}

function overridden(context, name, fallback) {
  const custom = context.overrides?.[name];
  if (typeof custom === 'string') return custom.trim() ? custom : null;
  return fallback;
}

export function dispatchPipeline(extraSteps = []) {
  return createPipeline([
    defineStep('contract', (context) => {
      const text = overridden(context, 'contract', context.contractText);
      return text ? `# Engineering contract\n\n${text}` : null;
    }),

    defineStep('role', ({ agent, instance }) => {
      const of = agent.instances > 1 && instance
        ? `\n\nYou are ${instance.label}, one of ${agent.instances} working this seat. `
          + 'Another worker shares your role. Stay strictly inside the slice you were '
          + 'given, never touch a file outside it, and report your slice on its own.'
        : '';
      return `# Your role: ${instance?.label ?? agent.label ?? agent.name}\n\n`
        + `${ROLE_PROMPTS[agent.role] ?? ''}${of}`;
    }),

    defineStep('crew', ({ agent, crew = [], team = 'the crew' }) =>
      (crew.length > 1 ? crewSection(agent, crew, team) : null)),

    defineStep('goal', ({ goal }) =>
      goal?.objective && `# Your goal\n\n${goal.objective}`),

    defineStep('claims', ({ claims = [] }) =>
      (claims.length > 0
        ? `# Files you own\n\n${claims.join('\n')}\n\nDo not edit anything else.`
        : null)),

    // The two style steps ride on every message, not just the first.
    defineStep('plain-language', (context) =>
      overridden(context, 'plain-language', plainLanguageRules())),
    defineStep('reporting', (context) =>
      overridden(context, 'reporting', `# Reporting rules\n\n- ${REPORTING_RULES}`)),
    defineStep('report-block', (context) =>
      overridden(context, 'report-block', reportInstruction())),

    defineStep('skills', ({ skills = [], mentions }) => {
      const all = allSkills(skills, mentions);
      return all.length > 0 ? `# Apply these\n\n${all.map((x) => `/${x}`).join('\n')}` : null;
    }),

    defineStep('attachments', ({ attachments = [] }) =>
      (attachments.length > 0
        ? `# Attachments\n\nThe operator attached these. Open them before you begin:\n${attachments
            .map((file) => `- ${file.path}  (${file.type})`)
            .join('\n')}`
        : null)),

    defineStep('mentions', ({ mentions }) =>
      (mentions?.files?.length > 0
        ? `# Named by the operator\n\nStart from these files:\n${mentions.files.join('\n')}`
        : null)),

    defineStep('task', ({ task }) => `# Task\n\n${task}`),

    defineStep('hook', (context) => {
      const text = overridden(context, 'hook', context.hook);
      return text ? `# Standing instruction\n\n${text}` : null;
    }),

    ...extraSteps,
  ]);
}

function allSkills(skills, mentions) {
  return [...new Set([...skills, ...(mentions?.skills ?? [])])];
}

// An agent that does not know the team exists will duplicate its work or wait
// on it silently. It gets the roster, and the rules of coordination with it.
function crewSection(agent, crew, team) {
  const others = crew
    .filter((member) => member.id !== agent.id)
    .map((member) => {
      const goal = member.objective ? ` - working on: ${member.objective}` : '';
      const owns = member.claims?.length ? ` - owns: ${member.claims.join(', ')}` : '';
      return `- ${member.label} (${member.role}, ${member.engine})${goal}${owns}`;
    });

  return [
    `# The team: ${team}`,
    '',
    `You are ${agent.label ?? agent.name}, the ${agent.role}. The rest of ${team}:`,
    ...others,
    '',
    'How this team works:',
    '- You never message another agent directly and you never wait on one silently.',
    '- Address the human when you need something, and name the agent you need it from.',
    '- Work only inside the files you own. If you need a file someone else owns, say so and stop.',
    '- Trust their reported results the way you would want yours trusted: by the receipt.',
  ].join('\n');
}

// A standing instruction rides on EVERY message, not just the first one, so a
// steer half an hour in carries the same rules as the opening dispatch.
// A steer carries the style rules and the standing instruction too, so turn
// twenty reads exactly like turn one.
export function withHook(text, hook, overrides = {}) {
  const style = typeof overrides['plain-language'] === 'string'
    ? overrides['plain-language']
    : plainLanguageRules();
  const standing = typeof overrides.hook === 'string' ? overrides.hook : hook;
  const parts = [text];
  if (style?.trim()) parts.push(style);
  if (standing?.trim()) parts.push(`# Standing instruction\n\n${standing}`);
  return parts.join('\n\n---\n\n');
}

// The orchestrator writes the crew's goals. A template can only restate the
// mission; Thor can read the repo, weigh what each role is actually for on
// THIS mission, and say so in one sentence each.
export const GOALS_FENCE = 'minimac-goals';

export function planningTask(mission, crew) {
  const roster = crew
    .filter((member) => member.role !== 'orchestrator')
    .map((member) => `- ${member.id}  (${member.label}, ${member.role})`
      + (member.instances > 1 ? `  — ${member.instances} workers share this seat` : ''))
    .join('\n');

  return [
    '# First job: set the crew\'s goals',
    '',
    `The mission is:\n\n${mission}`,
    '',
    'Before anyone starts, decide what each of these agents should be doing for '
      + 'THIS mission specifically:',
    roster,
    '',
    'Look at the actual repository first if that changes your answer.',
    '',
    'Then end your reply with exactly this block:',
    '',
    '```' + GOALS_FENCE,
    '{ "goals": { "coder": "one sentence", "tester": "one sentence" } }',
    '```',
    '',
    'Rules for the goals:',
    '- One or two sentences each. A goal a person can hold in their head.',
    '- Specific to this mission. Never restate the mission itself - they all have it.',
    '- Say what DONE looks like for that agent, not how to do it.',
    '- Use the agent ids above as the keys.',
    '- Where a seat has more than one worker, say how the work SPLITS: give each '
      + 'worker a disjoint slice, its own files, and its own verifiable outcome. '
      + 'Two workers must never be able to touch the same file.',
  ].join('\n');
}
