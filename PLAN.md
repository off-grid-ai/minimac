# Plan of action

Checked against `VISION.md`. The test for every item: **does it shorten the time
between an agent going wrong and you seeing it?**

Gates: **coded** → **wired** (reachable from the UI) → **verified** (watched live).
Nothing is done before verified.

---

## Phase 0 — verify what is already built

No new code. One pass with the app open. Everything below is **wired, unverified**.

| # | thing | evidence needed |
|---|---|---|
| 0.1 | `aimCamera()` centres the seated hero (`ui/scene.mjs`) | screenshot, hero mid-frame |
| 0.2 | Six desks fit — `DESK_SPACING` 1.42, `VIEW_WIDTH` 12.2 | screenshot, all six + no wall clip |
| 0.3 | Desk view — goal + FLOW + EVIDENCE (`ui/goalstrip.mjs`) | screenshot with real claims |
| 0.4 | `#floor` yields `--panel-w`, panel coexists | screenshot, panel open, nobody hidden |
| 0.5 | RETRY on blocked cards | **VERIFIED** — rendering, and Thor started (`sessionId 01a07945…`) |
| 0.6 | PLAN button → `COMMANDS.plan()` | a real planning turn |
| 0.7 | Thor's `crew` field disables a hero | a run where he benches someone |
| 0.8 | Capt. Marvel's `binary` move | **never once fired** — needs a reviewer RESULT |

---

## Phase 1 — one monitor, on the server

`core/derive.mjs` already sees every loop, overrun, silence and unbacked claim,
unpolled, for free — `ingest()` is the chokepoint every event crosses. It runs in
the **browser only**, so its knowledge reaches a screen and nothing that can act.

**`core/monitor.mjs`** *(new, pure)*
- `+ deriveCards(agents, eventsByAgent, now)` — every agent's `pendingDecisions()`
  in one call, sorted. Lifted from `decisions()` in `ui/main.mjs:315`.
- `+ diffCards(previous, next)` — `{ raised, cleared }` by `cardKey()`, so a
  standing condition is raised once, not once per event.

**`server.mjs`**
- `+ import { deriveCards, diffCards } from './core/monitor.mjs'`
- `+ state.eventsByAgent` — the server keeps no per-agent index today; `ingest()`
  only appends to `state.events`.
- `~ ingest(event)` — after `applyToAgent`, call `refreshCards()`.
- `+ refreshCards()` — debounced (250ms); recompute, diff, stash `state.cards`.
- `~ snapshot()` — add `cards: state.cards`.

**`ui/main.mjs`**
- `~ applySnapshot(snapshot)` — read `snapshot.cards`.
- `~ decisions(now)` — render server cards instead of deriving; keep the local
  path only as the fallback when `cards` is absent.
- `− pendingApproval()` stays (approvals are still read from events).

No visible change. This is the spine.

---

## Phase 2 — governance: Thor stays awake

The monitor decides **when**; Thor decides **what**. He never sees the 95% that is
normal, so he never drowns and never polls.

**`core/governance.mjs`** *(written, unwired — 210 lines)*
- `GOVERNANCE` / `GOVERNANCE_MODES` / `isGovernanceMode()`
- `VERDICT` / `isVerdictAction()` / `cardKey()`
- `routeCard(mode, card, verdict)` / `mayAct(mode)`
- `governanceTask(cards, crew, mode)` / `parseVerdicts(text, {keys})`
- `~ routeCard` — add a `cleared` case once Phase 1 gives it card lifecycles.

**`server.mjs`**
- `+ state.governance` (mode) and `state.verdicts` (by `cardKey`).
- `+ governanceTurn()` — called by `refreshCards()` when `raised.length`. Guards:
  one turn in flight (`state.governing`), cards batched, skipped when the
  orchestrator is disabled or already mid-turn.
- `+ harvestVerdicts(event)` — the third harvester beside `harvestGoals()` and
  `harvestReport()`; parses the `minimac-verdict` block and calls `applyVerdict()`.
- `+ applyVerdict(verdict)` — maps to existing verbs only:
  `steer→COMMANDS.steer`, `goal→COMMANDS.setGoal`, `bench→COMMANDS.setActive`,
  `hold`/`escalate`→annotate the card. Nothing new can touch files.
- `~ ingest()` — call `harvestVerdicts` alongside the other two.
- `+ COMMANDS.setGovernance({ mode })` — validated by `isGovernanceMode`.
- `~ snapshot()` — add `governance` and per-card `verdict`.
- `~ refreshCards()` — filter through `routeCard()` before it reaches the snapshot.

**`adapters/store.mjs`**
- `+ saveGovernance(mode)` / `+ governance()` — same shape as
  `saveMiddleware()` / `middleware()`, so the mode outlives runs and restarts.

**`ui/panels.mjs`**
- `~ observationCard()` — render `decision.verdict.note` as Thor's line on the card.
- `~ actionRow()` — in *advises* mode, a verdict's action becomes an APPLY button.

**`floor.html` / `ui/main.mjs`**
- `+ #governance` — a three-position switch in the top bar (advises / acts /
  governs), beside PLAN.
- `~ pickDom()` — add `governance`.
- `~ wireChrome()` — `send('setGovernance', { mode })`.
- `~ ACTION_WORDS` — add `setGovernance`.

**Invariant:** `routeCard()` returns `toThor: false` for any approval, in every
mode. Approvals freeze an engine; they are always yours.

---

## Phase 3 — prayToThor

Derived signal is involuntary, which is its value. But "I need a decision", "we
are about to touch the same file", "my goal contradicts Wanda's" can never be
derived. No new transport — one field on the block every agent already emits.

**`core/dispatch.mjs`**
- `~ reportInstruction()` — document the optional field:
  `"escalate": { "why": "one line", "needs": "decision|unblock|conflict" }`

**`core/monitor.mjs`**
- `+ prayerCard(event)` — turn an `escalate` payload into a card of kind `prayer`.

**`server.mjs`**
- `~ harvestReport()` — when the parsed report carries `escalate`, ingest a
  `PRAYER` event.
- `~ refreshCards()` — merge prayer cards with derived ones.

**`core/events.mjs`**
- `+ EVENT_KINDS.PRAYER`

Two ways in, one way out: a prayer obeys the same switch as a derived card.

---

## Phase 4 — speak once

`COMMANDS.say()` has two destinations, both dumb: MISSION replaces the objective
for everyone, or you name one agent by hand.

**`core/mentions.mjs`**
- `~ routeOf(parsed, target)` — accept `'policy'` and `'thor'` as targets.

**`server.mjs`**
- `~ COMMANDS.say()` — two new branches:
  - `target === 'policy'` → `COMMANDS.setMiddleware({ name: 'hook', text })`.
    `withHook()` already appends this to **every dispatch and every steer** and it
    is persisted; it is only unreachable from where you speak. No model in the path.
  - `target === 'thor'` → a routing turn; he answers with per-agent steers.

**`ui/composer.mjs`**
- `~ setTarget()` — MISSION / POLICY / THOR / a named hero.

Phase 4.2 depends on Phases 1–2: routing well needs knowing what everyone is doing.

---

## Open question

**Does Thor lose mission work?** He is the orchestrator — he assembles the team,
routes the work, and never fights himself; the only one facing the room. But today
he pushes submodules, and supervising a room you are working in is the
contradiction. It is already costing us: he has never once answered an ASSEMBLE
brief, because it arrives as an aside while he is mid-push.

If yes: `COMMANDS.start()` refuses a mission task for the orchestrator, and
`startCrew()` never gives him one. He keeps his desk and his character either way.

## Carried, not scheduled

- **The ~8 minute worker lifetime** from the original spec (idx 121) was never
  built — workers run unbounded. Logged so it stops being invisible.
- **Nothing spawns `codex app-server`.** minimac only connects to
  `ws://127.0.0.1:4573`. Every codex agent blocks until you run
  `codex app-server --listen ws://127.0.0.1:4573` by hand.
