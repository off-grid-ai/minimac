// A third engine that happens to be fake. Implementing the same port means the
// floor is alive with no CLI running, and the UI needs no simulation branch.
//
// It is also the first ninety seconds anyone sees, so it has to show the thing
// MINIMAC is for rather than a progress bar: six agents working, plans with
// estimates, steps closed by verification pings, a diff that grows, claims you
// can check and claims you cannot, ONE agent quietly looping past its estimate
// with nothing to show for it, and one stopped dead on a permission it cannot
// grant itself. Steering either of them genuinely moves them on - the same
// steer() the real adapters implement, doing real work here.

import { randomUUID } from 'node:crypto';
import {
  APPROVAL_KINDS,
  BLOCKED_REASONS,
  createApprovalEvent,
  createApprovalResolvedEvent,
  createBlockedEvent,
  createEvent,
  EVENT_KINDS,
  PING_KINDS,
} from '../core/events.mjs';

const TICK_MS = 250;

// The cast. Estimates are what each agent DECLARES up front; how long a step
// really takes is measured by the runner, which is the whole point.
const CAST = Object.freeze({
  pm: {
    startDelayMs: 0,
    toolEveryMs: 4_000,
    files: ['docs/flows/replay-meeting-cards.md', 'docs/acceptance.md'],
    steps: [
      { step: 'flows accepted with the user visible result named', estimateMs: 18_000, diff: 40 },
      { step: 'acceptance criteria written per flow', estimateMs: 16_000, diff: 30 },
      { step: 'scope fence agreed with CODER', estimateMs: 16_000, diff: 12 },
    ],
    claims: [
      { at: 1, text: '3 flows accepted, 11 acceptance criteria', receipt: 'wc -l docs/acceptance.md' },
    ],
  },
  ux: {
    startDelayMs: 4_000,
    toolEveryMs: 3_500,
    files: ['src/replay/meeting-card.tsx', 'src/design/tokens.ts'],
    steps: [
      { step: 'card reads at a glance', estimateMs: 16_000, diff: 90 },
      { step: 'scrub feels immediate', estimateMs: 14_000, diff: 60 },
      { step: 'empty and error states drawn', estimateMs: 14_000, diff: 45 },
    ],
    // The one claim with no command behind it: it sounds fine and grades GUESSED.
    claims: [
      { at: 1, text: 'the scrub feels instant now', receipt: '' },
      { at: 2, text: '3 states drawn, 195 lines', receipt: 'git diff --stat src/replay/meeting-card.tsx' },
    ],
  },
  coder: {
    startDelayMs: 2_000,
    toolEveryMs: 2_500,
    files: [
      'src/replay/timeline.ts',
      'src/replay/meeting-card.tsx',
      'src/capture/capture-drain.ts',
      'src/memory/index.ts',
    ],
    steps: [
      { step: 'user opens Replay and sees today', estimateMs: 8_000, diff: 120 },
      { step: 'user scrubs to 14:02', estimateMs: 10_000, diff: 140 },
      { step: 'the meeting card appears', estimateMs: 12_000, diff: 160 },
      { step: 'user opens the transcript', estimateMs: 8_000, diff: 90 },
      { step: 'user jumps to the source frame', estimateMs: 8_000, diff: 70 },
    ],
    trouble: { kind: 'loop', atStep: 2, target: 'src/capture/capture-drain.ts', action: 'read' },
    claims: [
      { at: 0, text: '120 lines changed in timeline.ts', receipt: 'git diff --stat src/replay/timeline.ts' },
      { at: 1, text: '260 lines changed so far', receipt: 'git diff --shortstat' },
    ],
  },
  tester: {
    startDelayMs: 12_000,
    toolEveryMs: 4_000,
    files: ['tests/replay.spec.ts', 'tests/capture.spec.ts'],
    steps: [
      { step: 'replay renders at 14:02', estimateMs: 14_000, diff: 55 },
      { step: 'transcript opens', estimateMs: 16_000, diff: 50 },
      { step: 'jump-to-source lands on the frame', estimateMs: 14_000, diff: 60 },
    ],
    verifies: 'coder',
    claims: [
      { at: 0, text: '3 specs green, 0 skipped', receipt: 'npx playwright test --reporter=line' },
      { at: 2, text: 'jump-to-source verified on the real frame', receipt: 'npx playwright test tests/replay.spec.ts' },
    ],
  },
  auditor: {
    startDelayMs: 20_000,
    toolEveryMs: 4_500,
    files: ['src/replay/timeline.ts', 'src/capture/capture-drain.ts'],
    steps: [
      { step: 'diff obeys the contract', estimateMs: 12_000, diff: 0 },
      { step: 'no duplicate ownership', estimateMs: 14_000, diff: 0 },
      { step: 'no test weakened', estimateMs: 12_000, diff: 0 },
    ],
    trouble: {
      kind: 'blocked',
      atStep: 1,
      afterMs: 5_000,
      summary: 'run `git push --force-with-lease origin audit/replay`',
      detail: 'force-push rewrites the shared branch. MINIMAC will not decide this for you.',
    },
    claims: [
      { at: 0, text: '0 contract violations across 4 files', receipt: 'node tools/contract-check.mjs' },
    ],
  },
  minimac: {
    startDelayMs: 0,
    toolEveryMs: 9_000,
    files: ['docs/GAPS_BACKLOG.md'],
    steps: [
      { step: 'route work and fence the claims', estimateMs: 30_000, diff: 8 },
      { step: 'hold the gates', estimateMs: 30_000, diff: 4 },
      { step: 'report with receipts', estimateMs: 28_000, diff: 6 },
    ],
    claims: [
      { at: 2, text: '5 of 6 seats reported with receipts', receipt: 'sqlite3 data/minimac.db "select count(*) from events where kind=\'claim\'"' },
    ],
  },
});

// Who claims what, so the fence is visible on the floor from the first second.
const FENCES = Object.freeze({
  coder: ['src/replay/**', 'src/capture/**'],
  tester: ['tests/**'],
  ux: ['src/design/**'],
  pm: ['docs/**'],
});

export function createSimDriver() {
  const handlers = new Set();
  const arcs = new Map();          // agentId -> arc state
  const sessionByAgent = new Map(); // agentId -> sessionId
  const agentBySession = new Map(); // sessionId -> agentId
  const workflowSessions = new Map();
  const workflowAttempts = new Map();
  let ticker = null;
  let startedAt = 0;

  const emit = (event) => {
    for (const handler of handlers) handler(event);
  };

  // ------------------------------------------------------------------ arcs

  function createArc(agent) {
    // Cloned, because the runner measures into it. The cast is a script, not
    // a scoreboard - two runs must not inherit each other's timings.
    const config = structuredClone(CAST[agent.id] ?? CAST.coder);
    return {
      agentId: agent.id,
      config,
      opened: false,
      finished: false,
      stepIndex: 0,
      stepStartedAt: null,
      nextToolAt: 0,
      toolCount: 0,
      diffLines: 0,
      stuckSince: null,
      blocked: false,
      approvalId: null,
      guessMade: false,
      pendingComplete: null, // the tool call whose completion is still owed
      statuses: config.steps.map(() => 'pending'),
    };
  }

  function planEvent(arc, now) {
    return createEvent(arc.agentId, EVENT_KINDS.PLAN, {
      steps: arc.config.steps.map((step, index) => ({
        id: `f${index + 1}`,
        step: step.step,
        user_visible_result: step.step,
        status: arc.statuses[index],
        estimateMs: step.estimateMs,
        // Measured here, not declared: the runner owns the clock.
        actualMs: measuredMs(arc, index, now),
      })),
    });
  }

  function measuredMs(arc, index, now) {
    if (index < arc.stepIndex) return arc.config.steps[index].measuredMs ?? 0;
    if (index === arc.stepIndex && arc.stepStartedAt !== null) return now - arc.stepStartedAt;
    return 0;
  }

  // ---------------------------------------------------------------- runner

  function open(arc, now) {
    arc.opened = true;
    arc.stepStartedAt = now;
    arc.statuses[0] = 'running';
    arc.nextToolAt = now + arc.config.toolEveryMs;
    emit(createEvent(arc.agentId, EVENT_KINDS.STATUS, { state: 'running' }));
    emit(planEvent(arc, now));
    const fence = FENCES[arc.agentId];
    if (fence) {
      emit(
        createEvent(arc.agentId, EVENT_KINDS.PING, {
          kind: PING_KINDS.CLAIMING,
          to: 'minimac',
          patterns: fence,
        }),
      );
    }
  }

  function advance(arc, now) {
    if (arc.finished) return;
    if (!arc.opened) {
      if (now - startedAt >= arc.config.startDelayMs) open(arc, now);
      return;
    }
    if (arc.blocked) return;

    const trouble = arc.config.trouble;
    const inTrouble = trouble && trouble.atStep === arc.stepIndex;

    if (inTrouble && trouble.kind === 'blocked') {
      if (now - arc.stepStartedAt >= (trouble.afterMs ?? 4_000)) return block(arc, trouble, now);
    }

    if (now >= arc.nextToolAt) runTool(arc, now, inTrouble && trouble.kind === 'loop' ? trouble : null);

    // A loop never ends its step. That is what makes the estimate blow past
    // 2x with nothing in the diff to justify it.
    const stuck = inTrouble && trouble.kind === 'loop' && arc.stuckSince !== null;
    if (stuck) {
      if (!arc.guessMade && now - arc.stuckSince > 12_000) {
        arc.guessMade = true;
        emit(
          createEvent(arc.agentId, EVENT_KINDS.CLAIM, {
            text: 'roughly 210 lines left here, maybe 2 more hours',
            receipt: '',
          }),
        );
      }
      // Keep re-declaring the plan so the measured overrun is visible live.
      if (arc.toolCount % 4 === 0) emit(planEvent(arc, now));
      return;
    }

    if (now - arc.stepStartedAt >= arc.config.steps[arc.stepIndex].estimateMs) completeStep(arc, now);
  }

  function runTool(arc, now, loop) {
    // Every call is opened and then closed, so "in flight" is a fact about the
    // stream rather than a guess about the gap between two events.
    closePendingCall(arc);

    const step = arc.config.steps[arc.stepIndex];
    const file = loop ? loop.target : arc.config.files[arc.toolCount % arc.config.files.length];
    const action = loop ? loop.action : toolAction(arc.toolCount);
    const call = { action, target: action === 'run' ? `npm test -- ${file}` : file };

    emit(createEvent(arc.agentId, EVENT_KINDS.TOOL, { ...call, phase: 'started' }));
    arc.pendingComplete = call;
    arc.toolCount += 1;
    arc.nextToolAt = now + arc.config.toolEveryMs;

    if (loop) {
      arc.stuckSince ??= now;
      return; // the diff does NOT move. That is the tell.
    }

    if (step.diff > 0) {
      arc.diffLines += Math.max(1, Math.round(step.diff / 4));
      emit(
        createEvent(arc.agentId, EVENT_KINDS.DIFF, {
          lines: arc.diffLines,
          receipt: 'git diff --shortstat',
        }),
      );
    }
  }

  function completeStep(arc, now) {
    closePendingCall(arc);
    const index = arc.stepIndex;
    const step = arc.config.steps[index];
    step.measuredMs = now - arc.stepStartedAt;
    arc.statuses[index] = 'verified';

    emit(
      createEvent(arc.agentId, EVENT_KINDS.PING, {
        kind: PING_KINDS.VERIFIED,
        to: arc.config.verifies ?? undefined,
        step: step.step,
      }),
    );

    const claim = (arc.config.claims ?? []).find((entry) => entry.at === index);
    if (claim) {
      emit(createEvent(arc.agentId, EVENT_KINDS.CLAIM, { text: claim.text, receipt: claim.receipt }));
    }

    arc.stepIndex += 1;
    if (arc.stepIndex >= arc.config.steps.length) {
      emit(planEvent(arc, now));
      return finish(arc, now);
    }
    arc.stepStartedAt = now;
    arc.statuses[arc.stepIndex] = 'running';
    emit(planEvent(arc, now));
  }

  function block(arc, trouble, now) {
    arc.blocked = true;
    arc.approvalId = randomUUID();
    emit(
      createApprovalEvent(arc.agentId, {
        id: arc.approvalId,
        approvalKind: APPROVAL_KINDS.COMMAND,
        summary: trouble.summary,
        detail: trouble.detail,
        decisions: ['accept', 'decline'],
        engine: 'sim',
      }),
    );
    emit(
      createBlockedEvent(arc.agentId, {
        category: BLOCKED_REASONS.APPROVAL,
        reason: trouble.summary,
        approvalId: arc.approvalId,
      }),
    );
    emit(
      createEvent(arc.agentId, EVENT_KINDS.PING, {
        kind: PING_KINDS.BLOCKED_ON,
        to: 'minimac',
        detail: trouble.summary,
      }),
    );
  }

  // The blocked agent moves again, and the card that held it clears. Declining
  // is not the same as accepting: the work is skipped rather than done, which
  // is why the decision is recorded on the resolution event.
  function unblock(arc, decision, by, now) {
    const approvalId = arc.approvalId;
    arc.blocked = false;
    arc.approvalId = null;
    arc.config.trouble = null; // answered once is answered; do not re-ask
    emit(
      createApprovalResolvedEvent(arc.agentId, {
        id: approvalId,
        decision,
        by,
        summary: 'force-push decision',
        engine: 'sim',
      }),
    );
    if (decision === 'cancel') {
      emit(createEvent(arc.agentId, EVENT_KINDS.STATUS, { state: 'stopped' }));
      arc.finished = true;
      return;
    }
    emit(createEvent(arc.agentId, EVENT_KINDS.STATUS, { state: 'running' }));
    arc.stepStartedAt = now;
    arc.nextToolAt = now;
  }

  function finish(arc, now) {
    closePendingCall(arc);
    arc.finished = true;
    const fence = FENCES[arc.agentId];
    if (fence) {
      emit(
        createEvent(arc.agentId, EVENT_KINDS.PING, {
          kind: PING_KINDS.RELEASED,
          to: 'minimac',
          patterns: fence,
        }),
      );
    }
    emit(
      createEvent(arc.agentId, EVENT_KINDS.RESULT, {
        report: {
          flows: arc.config.steps.map((step, index) => ({
            id: `f${index + 1}`,
            step: step.step,
            status: 'verified',
            measuredMs: step.measuredMs ?? null,
            estimateMs: step.estimateMs,
          })),
          diffLines: arc.diffLines,
        },
        durationMs: now - startedAt,
        receipt: 'git diff --shortstat',
      }),
    );
    emit(createEvent(arc.agentId, EVENT_KINDS.STATUS, { state: 'stopped' }));
  }

  function closePendingCall(arc) {
    if (!arc.pendingComplete) return;
    emit(
      createEvent(arc.agentId, EVENT_KINDS.TOOL, { ...arc.pendingComplete, phase: 'completed', ok: true }),
    );
    arc.pendingComplete = null;
  }

  function tick() {
    const now = Date.now();
    for (const arc of arcs.values()) advance(arc, now);
    if ([...arcs.values()].every((arc) => arc.finished)) stopTicker();
  }

  function stopTicker() {
    if (ticker) clearInterval(ticker);
    ticker = null;
  }

  // The whole floor is one story, so the first seat started raises the curtain
  // for the cast. Starting another seat later joins the run already in flight.
  function ensemble(agent) {
    if (ticker) return;
    startedAt = Date.now();
    for (const id of Object.keys(CAST)) {
      if (!arcs.has(id)) arcs.set(id, createArc({ id }));
      if (!sessionByAgent.has(id)) {
        const sessionId = randomUUID();
        sessionByAgent.set(id, sessionId);
        agentBySession.set(sessionId, id);
      }
    }
    if (!arcs.has(agent.id)) arcs.set(agent.id, createArc(agent));
    ticker = setInterval(tick, TICK_MS);
  }

  function workflowPlan() {
    const stages = [
      ['pw', 'pm'], ['dw', 'ux'], ['cw', 'coder'],
      ['tw', 'tester'], ['aw', 'auditor'], ['rw', 'reviewer'],
    ];
    return {
      crew: { coder: 2, tester: 2, auditor: 2, reviewer: 2, ux: 2, pm: 2 },
      workUnits: ['w1', 'w2'].map((id, index) => ({
        id,
        title: `Prove parallel outcome ${index + 1}`,
        outcome: `Parallel outcome ${index + 1} is complete and verified.`,
        scope: `sim/${id}`,
        blockedBy: [],
        stages: stages.map(([stage, owner]) => ({
          stage,
          required: true,
          owner,
          plan: `Complete ${stage.toUpperCase()} for ${id}.`,
          verify: `Record ${stage.toUpperCase()} proof for ${id}.`,
          files: [`sim/${id}/${stage}.txt`],
          estimateMs: 60_000,
        })),
      })),
    };
  }

  function workflowEvent(session, kind, payload = {}) {
    emit(createEvent(session.agent.id, kind, {
      ...payload,
      sessionId: session.id,
      workerId: session.agent.workerId ?? null,
      checkpointId: session.checkpointId,
      engine: 'sim',
    }));
  }

  function workflowGates(agent, checkpointId) {
    if (checkpointId === 'release.prepush') return ['prepush'];
    if (checkpointId === 'release.push') return ['push'];
    return {
      pm: ['product'],
      ux: ['design'],
      coder: ['coding', 'wiring', 'lint', 'commits'],
      tester: ['test'],
      auditor: ['audit'],
      reviewer: ['review'],
    }[agent.id] ?? [];
  }

  function startWorkflow(agent, prompt) {
    const id = randomUUID();
    const checkpointId = /^# Assigned task: (\S+)/m.exec(prompt)?.[1] ?? null;
    const session = { id, agent, checkpointId, state: 'running', finished: false };
    workflowSessions.set(id, session);
    agentBySession.set(id, agent.id);

    setTimeout(() => {
      if (session.finished) return;
      workflowEvent(session, EVENT_KINDS.STATUS, { state: 'running' });
      if (agent.id === 'minimac' && prompt.includes('# First job: assemble the crew')) {
        workflowEvent(session, EVENT_KINDS.MESSAGE, {
          text: `\`\`\`minimac-work-plan\n${JSON.stringify(workflowPlan())}\n\`\`\``,
        });
        return;
      }
      if (!checkpointId) return;
      const attempt = (workflowAttempts.get(checkpointId) ?? 0) + 1;
      workflowAttempts.set(checkpointId, attempt);
      if (checkpointId === 'w2.cw' && attempt === 1) {
        session.state = 'stopped';
        session.finished = true;
        workflowEvent(session, EVENT_KINDS.STATUS, { state: 'stopped' });
        return;
      }
      const failedVerification = checkpointId === 'w1.tw' && attempt === 1;
      const gates = workflowGates(agent, checkpointId).map((gate) => ({
        item: checkpointId,
        gate,
        state: failedVerification ? 'fail' : 'pass',
        receipt: failedVerification
          ? 'simulated focused check: one reproducible failure'
          : `simulated ${gate} proof for ${checkpointId}`,
      }));
      const discoveries = failedVerification ? [{
        id: 'focused-regression',
        checkpointId,
        title: 'Fix the focused regression',
        outcome: 'The focused regression passes when verification runs again.',
        scope: 'sim/w1',
        receipt: 'simulated focused check: one reproducible failure',
        files: ['sim/w1/cw.txt'],
      }] : [];
      workflowEvent(session, EVENT_KINDS.MESSAGE, {
        text: `\`\`\`minimac\n${JSON.stringify({ claims: [], discoveries, gates })}\n\`\`\``,
      });
    }, 40);
    return id;
  }

  return {
    async start(agent, _cwd, prompt) {
      if (prompt.includes('# Assigned task:') || prompt.includes('# First job: assemble the crew')) {
        return startWorkflow(agent, prompt);
      }
      ensemble(agent);
      const existing = sessionByAgent.get(agent.id);
      if (existing) return existing;
      const sessionId = randomUUID();
      sessionByAgent.set(agent.id, sessionId);
      agentBySession.set(sessionId, agent.id);
      return sessionId;
    },

    async setGoal(sessionId, objective) {
      const agentId = agentBySession.get(sessionId);
      if (agentId && objective) {
        emit(createEvent(agentId, EVENT_KINDS.STATUS, { goal: objective }));
      }
    },

    // Steering a simulated agent actually unsticks it, so the interaction is
    // real: the loop breaks, the blocked approval is answered, and the step it
    // was stuck on closes with the diff it should have produced.
    async steer(sessionId, text) {
      const agentId = agentBySession.get(sessionId);
      const arc = arcs.get(agentId);
      if (!arc || arc.finished) return;
      const now = Date.now();

      emit(createEvent(agentId, EVENT_KINDS.MESSAGE, { text: `acknowledged: ${text}` }));

      if (arc.blocked) {
        unblock(arc, 'accept', 'steer', now);
        return;
      }

      if (arc.stuckSince !== null) {
        arc.stuckSince = null;
        arc.config.trouble = null; // the loop is broken, not paused
        const step = arc.config.steps[arc.stepIndex];
        arc.diffLines += step.diff;
        emit(
          createEvent(agentId, EVENT_KINDS.DIFF, {
            lines: arc.diffLines,
            receipt: 'git diff --shortstat',
          }),
        );
        emit(
          createEvent(agentId, EVENT_KINDS.CLAIM, {
            text: `${arc.diffLines} lines changed, ${step.step} landed`,
            receipt: 'git diff --shortstat',
          }),
        );
        completeStep(arc, now);
        arc.nextToolAt = now;
      }
    },

    // The same decision the real adapters take, doing the same real work here:
    // the AUDITOR clears on a button press, not only on typed prose.
    async approve(sessionId, approvalId, decision) {
      const arc = arcs.get(agentBySession.get(sessionId));
      if (!arc?.blocked) throw new Error(`no approval waiting on ${sessionId}`);
      if (approvalId != null && arc.approvalId !== approvalId) {
        throw new Error(`approval ${approvalId} is not the one waiting`);
      }
      unblock(arc, decision?.value ?? decision, 'you', Date.now());
    },

    async interrupt(sessionId) {
      const workflow = workflowSessions.get(sessionId);
      if (workflow) {
        if (!workflow.finished) {
          workflow.state = 'stopped';
          workflow.finished = true;
          workflowEvent(workflow, EVENT_KINDS.STATUS, { state: 'stopped' });
        }
        return;
      }
      const agentId = agentBySession.get(sessionId);
      const arc = arcs.get(agentId);
      if (!arc || arc.finished) return;
      arc.finished = true;
      arc.blocked = false;
      emit(createEvent(agentId, EVENT_KINDS.STATUS, { state: 'stopped' }));
      if ([...arcs.values()].every((entry) => entry.finished)) stopTicker();
    },

    async sessionHealth(sessionId) {
      const workflow = workflowSessions.get(sessionId);
      if (workflow) return { state: workflow.state, live: !workflow.finished };
      const arc = arcs.get(agentBySession.get(sessionId));
      if (!arc || arc.finished) return { state: 'stopped', live: false };
      return { state: arc.blocked ? 'running' : 'running', live: true };
    },

    onEvent(handler) {
      handlers.add(handler);
    },
  };
}

function toolAction(count) {
  if (count % 4 === 3) return 'run';
  if (count % 4 === 1) return 'edit';
  return 'read';
}
