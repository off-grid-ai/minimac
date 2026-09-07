// The middleware. Every dispatch to every engine is composed here, so the
// engineering contract, the role, the goal and the output shape are enforced
// once instead of re-typed each session.

import { ROLES } from './roster.mjs';
import { GATES } from './flows.mjs';
import { boardBrief } from './board.mjs';
import { createPipeline, defineStep } from './middleware.mjs';

// Three roles pick an implementation approach, so three roles plan before they
// act. The rest judge, route or specify - "pick one of three ways to build it"
// is not their job, and a planning turn each would be spend for nothing.
export const PLANS_THRICE = Object.freeze(
  new Set([ROLES.CODER, ROLES.TESTER, ROLES.AUDITOR]),
);

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
  [ROLES.REVIEWER]:
    'You review the change as a reviewer would on a pull request: the diff, the '
    + 'commits, the description. You judge whether it should be merged and say so '
    + 'plainly, with the reason. Every comment names a file and a line and says what '
    + 'to change, and you give exactly one verdict - approve, or request changes with '
    + 'the blocking reasons listed. You never approve a change whose checks you have '
    + 'not seen pass. You do not write production code, and you do not repeat the '
    + 'auditor - the auditor checks the work against the engineering contract, you '
    + 'check whether a person should accept this change.',
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
          required: ['step', 'user_visible_result', 'status', 'estimateMs'],
          properties: {
            step: { type: 'string' },
            user_visible_result: {
              type: 'string',
              description: 'What a person sees or can do. Never a file or a command.',
            },
            status: { type: 'string', enum: Object.values(STEP_STATUS) },
            estimateMs: {
              type: 'integer',
              description: 'Agent time for this step, in ms, declared before it starts.',
            },
            scope: {
              type: 'string',
              description: 'Where this happens, as a path: "mobile", "shared/sync".',
            },
            gates: {
              type: 'object',
              description: 'Fixed gates. Pass only with a command in claims behind it.',
              properties: Object.fromEntries(GATES.map((gate) => [gate, {
                type: 'string',
                enum: ['pass', 'fail', 'running', 'pending'],
              }])),
            },
            approach: {
              type: 'object',
              description: 'One plan, sharpened twice. Coder, tester and auditor only.',
              properties: {
                plan: { type: 'string' },
                sharpened: { type: 'string' },
                cut: { type: 'string' },
                inputs: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'The earlier steps this plan was built on.',
                },
              },
            },
            actualMs: { type: 'integer' },
            evidence: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      escalate: {
        type: 'object',
        description: 'Ask for attention. Only for what watching you could never reveal.',
        properties: {
          why: { type: 'string' },
          needs: { type: 'string', enum: ['decision', 'unblock', 'conflict'] },
        },
      },
      standDown: {
        type: 'object',
        description: 'End your own session. Only when your goal is met or nothing is left.',
        properties: { why: { type: 'string' } },
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

export function reportInstruction(role = null) {
  const plans = role === null || PLANS_THRICE.has(role);
  const approach = plans
    ? ',\n     "approach": {"plan": "the plan you are acting on",\n'
      + '                  "sharpened": "what pass 2 changed, and why",\n'
      + '                  "cut": "what pass 3 removed, and why",\n'
      + '                  "inputs": ["step 1", "step 2"]}'
    : '';
  return [
    '# How you must report',
    '',
    'END EVERY REPLY with a fenced block exactly like this, and nothing after it:',
    '',
    '```' + REPORT_FENCE,
    '{',
    '  "flows": [',
    '    {"step": "what you are doing", "user_visible_result": "what a person can see",',
    '     "scope": "repo/area", "status": "coded|wired|verified", "estimateMs": 300000,',
    '     "gates": {"coding": "pass", "wiring": "running", "lint": "pending",',
    '               "test": "pending", "commits": "pending", "push": "pending"}' + approach + '}',
    '  ],',
    '  "claims": [',
    '    {"text": "a factual statement", "receipt": "the exact command that produced it"}',
    '  ],',
    '  "escalate": {"why": "one line", "needs": "decision|unblock|conflict"},',
    '  "standDown": {"why": "one line"},',
    '  "gates": [',
    '    {"item": "w1", "gate": "test", "state": "pass|fail|running",',
    '     "receipt": "the exact command that proved it"}',
    '  ]',
    '}',
    '```',
    '',
    'Rules for that block:',
    '- flows is your whole plan, restated every time, with each step\'s current status.',
    '- scope says WHERE the step happens, as a path: the repo, then the area inside it '
      + '("mobile", "mobile/release", "shared/sync"). It is how the floor rolls your work '
      + 'up per repo. Use the same scope string for every step in the same place.',
    `- gates are fixed: ${GATES.join(', ')}. Each is "pass", "fail", "running" or "pending". `
      + 'A gate is "pass" ONLY if a command proved it and that command is in claims. Never '
      + 'mark a gate pass because you believe it would pass.',
    '- user_visible_result is what a PERSON sees. Never a file, command or count.',
    '- estimateMs is AGENT time: how long YOU will take, not how long a person would. '
      + 'Give it BEFORE the step starts. An estimate written after the fact is not an estimate.',
    '- Every step carries an estimate. A step with no estimate cannot be late, which is '
      + 'why one is never optional.',
    '- Every number you state anywhere goes in claims with the command that produced it.',
    '- If you have no command behind a number, set receipt to "" and say so.',
    '- If your work no longer matches your goal, say so in a flow step rather than continuing.',
    '- gates is how you move the BOARD. Name the item id you own, the gate, and '
      + 'the command that proved it. A pass without a receipt is rejected, and a '
      + 'gate cannot pass before the ones before it.',
    '- Work only on items you own. If something needs doing on an item you do not '
      + 'own, escalate - never reach into it.',
    '- standDown is OPTIONAL and ends your own session. Use it the moment your '
      + 'goal is met, or when you have nothing real left to do on this mission. '
      + 'Sitting idle in a chair costs tokens and fills the floor with noise; '
      + 'saying so and stopping is the honest move, not a failure.',
    '- Never stand down with work outstanding, a question unanswered, or a gate '
      + 'unproved. Say what is left instead.',
    '- escalate is OPTIONAL and how you ask for the room\'s attention. Use it only for '
      + 'what nobody could work out by watching you: you need a decision, you are blocked '
      + 'on something you cannot get, or your work collides with another agent\'s. Leave it '
      + 'out entirely when you are simply working.',
    ...(plans ? [
      '- approach is the plan you acted on after sharpening it twice: "plan" is the '
      + 'final one, "sharpened" says what attacking it changed, "cut" says what '
      + 'making it smaller removed. If either is empty you skipped a pass. '
      + '"inputs" names the earlier steps you planned against - the results you '
      + 'read, not the ones you meant to read.',
    ] : []),
  ].join('\n');
}

// Plan, then make the plan better, then make the better plan better.
//
// Three PASSES over one plan, not three alternatives to choose between. It is
// the so-what-times-three move from copywriting: you do not write three
// headlines, you write one and then interrogate it twice until it earns its
// place. A first plan is a reflex; the second pass finds what it assumed; the
// third finds what it can lose.
//
// The other half matters as much: each pass starts from what the PREVIOUS
// steps actually produced. An agent that plans once and then executes for
// forty minutes is planning against facts that stopped being true at step two.
export function planThreeRules() {
  return [
    '# Plan, sharpen, sharpen again',
    '',
    'Before you write code, before you write a test, and before you start '
    + 'debugging - every single time. Three passes over ONE plan. Not three '
    + 'options to pick from: one plan, made better twice.',
    '',
    '**Pass 0 - read.** What did your previous steps actually produce? Not what '
    + 'you meant them to produce - what the receipts say happened.',
    '',
    '**Pass 1 - write the plan.** How you will do this step, in the fewest steps '
    + 'that finish it.',
    '',
    '**Pass 2 - attack it: what is wrong with this?** What does it assume that '
    + 'you have not checked? Where does it fail? What did it not account for? '
    + 'Then REWRITE the plan so those answers are handled. Do not annotate it - '
    + 'replace it.',
    '',
    '**Pass 3 - attack it again: what can go?** What is the smallest version of '
    + 'pass 2 that still delivers the same outcome? What step exists out of habit '
    + 'rather than need? What are you building that nobody asked for? REWRITE it '
    + 'smaller.',
    '',
    'Then act on pass 3, and only pass 3.',
    '',
    'Rules:',
    '- Each pass must CHANGE something. A pass that produces the same plan means '
    + 'you did not attack it - go again, harder.',
    '- One thinking pass per number, not three attempts at the work.',
    '- A step that changes nothing - a read, a look - needs no plan. A step that '
    + 'writes anything does.',
    '- If pass 3 needs something you do not have, stop and report blocked. Do not '
    + 'start on the least-bad option.',
    '- Report it under "approach": the final plan, and one line each on what pass '
    + '2 and pass 3 changed. "inputs" names the earlier steps you planned against.',
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
  'Estimate every step in AGENT minutes - your own working time - before you start it, '
    + 'and report the actual when it closes. An estimate given after the step began is not one.',
  'Plan the next step against what the previous steps actually produced, not against the '
    + 'task as you first read it.',
  'If you repeat the same read or the same command three times, stop and report blocked.',
].join('\n- ');

// What this agent has already done, in its own words, with what each step
// actually produced. Every step is meant to plan against these, so they have
// to be IN the prompt - an agent cannot take its previous steps as inputs if
// it is never shown them.
export function priorSteps(steps = []) {
  const closed = steps.filter((step) => step?.status && step.status !== 'pending');
  if (closed.length === 0) return null;
  const lines = closed.map((step, index) => {
    const took = Number.isFinite(step.actualMs) ? `  (took ${Math.round(step.actualMs / 60000)}m)` : '';
    const saw = step.user_visible_result ? `\n    a person can now: ${step.user_visible_result}` : '';
    const proof = Array.isArray(step.evidence) && step.evidence.length
      ? `\n    proof: ${step.evidence.join('; ')}`
      : '';
    return `${index + 1}. ${step.step}  [${step.status}]${took}${saw}${proof}`;
  });
  return [
    '# What you have already done',
    '',
    'Plan your next step against these, not against the task as you first read it.',
    '',
    ...lines,
  ].join('\n');
}

export function composeDispatch(context) {
  return dispatchPipeline(context.extraSteps ?? []).compose(context).text;
}

// One ordered list, so what an agent is told is readable top to bottom, and a
// new rule is a new entry rather than a new branch.
// Which steps a person may rewrite from the UI, and the default each falls
// back to. Dynamic steps (role, goal, crew, task) are composed from live state
// and are deliberately not editable as free text.
export const EDITABLE_STEPS = Object.freeze([
  'plain-language', 'reporting', 'report-block', 'plan-three', 'hook',
]);

export function defaultStepText(name) {
  if (name === 'plain-language') return plainLanguageRules();
  if (name === 'reporting') return `# Reporting rules\n\n- ${REPORTING_RULES}`;
  if (name === 'report-block') return reportInstruction();
  if (name === 'plan-three') return planThreeRules();
  return '';
}

function overridden(context, name, fallback) {
  const custom = context.overrides?.[name];
  if (typeof custom === 'string') return custom.trim() ? custom : null;
  return fallback;
}

export function dispatchPipeline(extraSteps = []) {
  return createPipeline([
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
    // ONE fence per turn. An assemble turn is asked for the goals block, and
    // appending "end every reply with the report block" on top of that made
    // the orchestrator answer with the report block instead - which is why he
    // produced 158 events and not one crew decision.
    defineStep('report-block', (context) => (
      context.planning
        ? null
        : overridden(context, 'report-block', reportInstruction(context.agent?.role)))),

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

    defineStep('board', ({ board, agent }) => boardBrief(board, agent?.id)),

    defineStep('prior-steps', ({ steps }) => priorSteps(steps)),

    defineStep('plan-three', (context) => (
      PLANS_THRICE.has(context.agent?.role)
        ? overridden(context, 'plan-three', planThreeRules())
        : null)),

    defineStep('task', ({ task }) => `# Task\n\n${task}`),

    // The hook is the ONE standing channel: it rides every dispatch and every
    // steer, and the engineering contract is simply what it holds by default.
    // Having a separate "contract" slot meant two names for one thing, two
    // places to look, and a rule that could be in one and not the other.
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
// A steer is a dispatch too. It carries the same house style, the same standing
// instruction, and - for the roles that plan - the same discipline and the same
// chain of what they have already done. A rule that only rides on the first
// message is a rule the agent has forgotten by the third turn.
export function withHook(
  text, hook, overrides = {}, agent = null, steps = [], board = null,
) {
  const style = typeof overrides['plain-language'] === 'string'
    ? overrides['plain-language']
    : plainLanguageRules();
  const standing = typeof overrides.hook === 'string' ? overrides.hook : hook;
  const parts = [text];
  // The board rides every message too. It is the shared truth; a steer that
  // does not carry it is asking an agent to act on a memory of it.
  const shared = boardBrief(board, agent?.id);
  if (shared) parts.push(shared);
  const done = priorSteps(steps);
  if (done) parts.push(done);
  if (PLANS_THRICE.has(agent?.role)) {
    const plan = typeof overrides['plan-three'] === 'string'
      ? overrides['plan-three']
      : planThreeRules();
    if (plan?.trim()) parts.push(plan);
  }
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
      + `  [${member.enabled === false ? 'currently STOOD DOWN' : 'currently on'}]`
      + (member.instances > 1 ? `  — ${member.instances} workers share this seat` : ''))
    .join('\n');

  return [
    '# First job: assemble the crew',
    '',
    `The mission is:\n\n${mission}`,
    '',
    'Two decisions, in this order: WHO this mission needs, then what each of them '
    + 'is for. Be ruthless about the first - the smallest crew that can finish the '
    + 'mission is the right crew. Decide what each of these agents should be doing for '
      + 'THIS mission specifically:',
    roster,
    '',
    'Look at the actual repository first if that changes your answer.',
    '',
    'Then end your reply with exactly this block:',
    '',
    'This turn has ONE job and ONE output. Do not write a report block, do not '
    + 'start any work, and do not end with anything after this:',
    '',
    '```' + GOALS_FENCE,
    '{ "crew": { "coder": true, "reviewer": 3, "ux": false },',
    '  "goals": { "coder": "one sentence", "tester": "one sentence" },',
    '  "items": [',
    '    {"title": "what a person gets when this is done", "scope": "repo/area",',
    '     "owner": "coder", "needs": ["coding","lint","test"], "blockedBy": [],',
    '     "estimateMs": 600000}',
    '  ] }',
    '```',
    '',
    'Rules for the crew - this half is NOT optional:',
    '- "crew" MUST name EVERY agent listed above. false takes an agent off the '
      + 'mission; true brings one on; a NUMBER from 1 to 4 brings on that many '
      + 'workers sharing the seat, each on its own slice. A block without a full '
      + 'crew is rejected and you will be asked again.',
    '- Ask for several of the same hero only when the work truly splits - three '
      + 'pull requests to review is three reviewers; one pull request is not.',
    '- Read the mission\'s OWN WORDS first. If it asks for something a role exists '
      + 'for - a review, a test, a design, a contract - that role is ON. Benching '
      + 'the reviewer on a mission that says "review" is not a small crew, it is '
      + 'the wrong crew.',
    '- Otherwise default to FALSE: an agent earns a place by having work on THIS '
      + 'mission that no one else would do.',
    '- Most missions need two or three. Pushing a branch does not need a product '
      + 'specialist or a designer; a design change does not need a tester.',
    '- Anything that will reach a shared branch gets a reviewer. Nobody merges '
      + 'their own work here.',
    '- An idle seat is not free. It burns tokens, fills the floor with noise, and '
      + 'invents work to look busy.',
    '- Only give a goal to an agent you set true.',
    '',
    'Rules for the board ("items") - this is the work itself:',
    '- Split the mission into the smallest number of items that can be worked '
      + 'INDEPENDENTLY. Two items must never need the same file at the same time.',
    '- Every item has exactly one owner from the crew you brought on.',
    '- "needs" lists only the gates this item really has. A docs change has no '
      + 'test gate; inventing one makes an item nobody can ever finish.',
    '- "blockedBy" names the item ids that must finish first. Use it - it is how '
      + 'one hero waits on another without either of them guessing.',
    '- Give each item an estimate in AGENT minutes.',
    '- The gates are walked in order and a pass needs the command that proved it. '
      + 'Nobody can report a push over untested code.',
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
