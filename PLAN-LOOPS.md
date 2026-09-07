# Loops, middleware prompts, and estimates

The standing rules Mac repeats to every agent, moved out of his typing and into
the dispatch. That is the point of the middleware layer: **a rule he has to type
again is a rule the tool failed to hold.**

Four rules, from `VISION.md`'s bar and stated directly:

1. Every task carries an estimate, **in agent time**.
2. Plan three ways before writing code.
3. Plan three ways before writing tests.
4. Plan three ways before debugging.

---

## A. The plan-times-three loop

### The rule

Before an agent writes code, writes a test, or starts debugging, it produces
**three approaches**, picks one, and says why the other two lose. One model call,
before any edit — not three attempts at the work.

Three is the number because one is a reflex and two is a false binary. It is
cheap: a few hundred tokens against a wrong approach that costs an hour.

### Why it is middleware, not a prompt

It must bind **every agent, every dispatch, and every steer**, including agents
started an hour from now. `withHook()` already appends middleware to all three.
A rule that lives in one prompt is a rule that decays.

### Files

**`core/dispatch.mjs`**
- `+ PLAN_THREE` — the rule text.
- `+ planThreeRules()` — returns it, so `defaultStepText()` can restore it.
- `~ dispatchPipeline()` — a `plan-three` step, placed **before** `task` so the
  agent reads the discipline before it reads the job.
- `~ EDITABLE_STEPS` — add `'plan-three'` so it is rewritable from MIDDLEWARE.
- `~ defaultStepText()` — return `planThreeRules()` for it.

### The gate that makes it real

A rule nobody checks is decoration. The agent must emit its three options in the
report block, so the room can see the choice was actually made:

```json
"approach": { "chosen": "one line",
              "rejected": ["one line", "one line"],
              "why": "one line" }
```

- `core/dispatch.mjs` — `~ reportInstruction()`, `~ buildOutputSchema()`.
- `core/monitor.mjs` — `+ unplannedCard()`: an agent that produced a diff with no
  `approach` for this step raises a card. **The loop is enforced by the room, not
  by trust.**

---

## B. Estimates in agent time

### The rule

Wall-clock minutes are meaningless for an agent — it does not take coffee breaks
and it does not think at human speed. The unit has to be **how long the agent
will take**, and it must be declared *before* the step starts, or the estimate is
written after the fact to match reality and proves nothing.

`REPORTING_RULES` already says "estimate each step in minutes". Two things are
wrong with it: it does not say *whose* minutes, and nothing enforces that the
estimate came first.

### Files

**`core/dispatch.mjs`**
- `~ REPORTING_RULES` — say agent time explicitly, and that an estimate given
  after a step has started is not an estimate.
- `~ buildOutputSchema()` — `estimateMs` becomes **required** on every step.

**`core/derive.mjs`**
- `+ lateEstimate(step, timings)` — an estimate first seen after the step began.
  Recorded, so a step cannot be quietly re-promised once it is already late.

**`core/monitor.mjs`**
- `+ noEstimateCard()` — a running step with no estimate is a card. Today it is
  rendered as "no estimate given" and then ignored by everything.

---

## C. Showing estimates

The bar was blocks and a multiplier, which taught nothing. It is now one line —
**`TIME · 13m of 5m · 260%`** — and that is the atom. Three places use it:

**1. At the step (done).** `burn()` in `ui/panels.mjs`. Red past the estimate.

**2. At the agent — the number that answers "should I look at this one?"**
- `core/derive.mjs` — `+ agentBurn(agent, events, now)`: total actual against
  total estimate across that agent's steps.
- `ui/scene.mjs` — the nameplate carries it when it is over. You should not have
  to open a desk to learn someone is late.

**3. At the fleet — the north star, on screen.**
- `ui/main.mjs` — `~ renderHeader()`: `fleet: 41m of 25m` in the top bar.
  This is the single number the whole tool exists to keep honest.

Never a bar, never a bare multiplier: **label, value, percent.**

---

## D. Order

1. **B and C** first — small, deterministic, no contract risk, and estimates are
   the north star made visible.
2. **A** next — it changes the report block every agent obeys, so it lands with
   its enforcement card in the same pass.
3. Then back to Phase 2 governance, which gets sharper for having both: Thor can
   rule on "late, and never planned".

~380 lines across 6 files. None of it is a rewrite.

## Open

- **Three every time, or three when it matters?** Plan-times-three on a one-line
  fix is waste. I would scope it to steps whose estimate is over ~5 agent-minutes
  or that touch more than one file, and say so in the rule. Tell me if you want it
  unconditional instead.
