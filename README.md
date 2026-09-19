# MINIMAC

MINIMAC is a local control room for a fleet of AI coding agents. You can plan a mission,
watch each checkpoint, talk to the team, and see the proof behind completion.

## Requirements

- Node.js 22 or newer
- Codex CLI, Claude Code, or both
- Git for repository work

## Start MINIMAC

```bash
node server.mjs --repo /path/to/project
```

Open [http://127.0.0.1:4600](http://127.0.0.1:4600).

`--repo` is the repository that the agents change. MINIMAC starts a Codex app-server when
one is not already available. It does not replace a server that is already running.

| Flag | Result | Default |
|---|---|---|
| `--repo <dir>` | Select the repository that the agents change | Current directory |
| `--mission "..."` | Create a mission at startup | No mission |
| `--port <n>` | Select the local HTTP port | `4600` |
| `--engine <name>` | Use `codex`, `claude`, or `sim` for every seat | Roster setting |
| `--roster <file>` | Load a custom crew roster | Built-in roster |
| `--team "..."` | Set the crew name in dispatch text | `the Avengers` |
| `--contract <file>` | Load one engineering contract | First contract found in the repository |
| `--hook <file>` | Append another instruction file to every dispatch | None |
| `--skills a,b` | Add skills to every agent dispatch | None |
| `--isolate` | Give each worker a separate Git worktree | Off |
| `--codex-url <ws>` | Select the Codex app-server socket | `ws://127.0.0.1:4573` |
| `--remote-control [mode]` | Enable remote control for `boss`, `all`, or `off` | `boss` |

Without `--contract`, MINIMAC checks these files in order:

1. `.codex/ENGINEERING_CONTRACT.md`
2. `.claude/ENGINEERING_CONTRACT.md`
3. `ENGINEERING_CONTRACT.md`

To open the floor without a real coding engine, use the simulator:

```bash
node server.mjs --engine sim --mission "demo run"
```

## Run a mission

1. Enter a mission and send it. MINIMAC creates the run and wakes Thor to make the work plan.
2. Review the plan, required acceptance gates, owners, files, and dependencies.
3. Select **START ALL**. MINIMAC starts only checkpoints that are ready. It silently skips
   blocked roles and continues ready work through the scheduler.
4. Use **DECISIONS** when an agent needs your answer. Use the Main room or a checkpoint thread
   for normal conversation.
5. Read the quality evidence before the mission is complete.

**ASSEMBLE** runs the planning step again. Use it when the mission changes or when the current
plan needs a new crew or new checkpoints.

## Product model

MINIMAC has one mission, work units inside that mission, and checkpoints inside each work unit.
Each checkpoint has one owner, one lease, dependencies, files, proof, and a clear state.

The main panels show different projections of the same saved state:

- **FLOW** groups work by repository and user outcome.
- **CHECKPOINTS** shows the plan, owner, dependencies, gate state, retry state, and evidence.
- **FEED** contains the Main room and checkpoint threads.
- **AVENGERS** shows worker health and lets you select engine, model, effort, and capacity.
- **DECISIONS** shows only items that need user action.
- **MIDDLEWARE** shows the instruction pipeline used for every dispatch.
- **MISSIONS** opens current and earlier runs. Each row includes its run ID.

The selected run, panel, and Feed detail level are stored in the URL:

```text
?run=106&tab=feed&detail=summary
```

A refresh restores those values.

## Conversations

Each mission has one Main room. Each checkpoint gets one automatic thread.

- The Main room contains the mission, Thor's plan, mission-wide messages, milestone cards,
  and the final result.
- A checkpoint thread contains its brief, owner, state, messages, agent output, files,
  attachments, evidence, questions, and result.
- A message stays in the context where it was written.
- A reply keeps the context and parent message.
- Delivery state is shown as queued, delivered, read, or failed.
- Messages can contain typed references to agents, checkpoints, decisions, files, and skills.
- The same message renderer and composer are used in mission, checkpoint, and hero detail views.

Click a hero to open that hero in the Feed. A visible hero message can also create one ordered
walk across the floor. Walks queue without overlap. Speech bubbles can be dismissed.

## Work units and checkpoints

Thor publishes work units before workers start. Stage codes have these fixed meanings:

| Code | Stage | Required proof |
|---|---|---|
| `pw` | Product | Product outcome and acceptance criteria |
| `dw` | Design | Design decision and user-flow proof |
| `cw` | Coding | Code, wiring, lint, and commits |
| `tw` | Testing | Test result |
| `aw` | Audit | Independent audit result |
| `rw` | Review | Final review result |

Dependencies and file ownership decide when a checkpoint can run. A worker can ask MINIMAC to
split a checkpoint when the real task is too large. A failed test, audit, review, or pre-push
check can create a repair checkpoint without replacing valid completed work.

## Acceptance and completion

The mission controls show which gates are required. The default policy requires coding, wiring,
lint, test, audit, review, commits, pre-push, and push. Product and design gates are added when
the work plan requires those stages.

Work progress and quality progress are separate. A mission is complete only when every required
gate passes. The quality view records the command, result, time, repository, and checkpoint for
each proof item. Contradictions such as a completed mission with a failed test are shown as alerts.

MINIMAC also estimates the context size before ASSEMBLE and before a cold worker start. The
estimate tells you when a worker can resume the same checkpoint and when a new session is needed.

## Workers and engines

Each hero can use Codex or Claude. The Avengers panel shows and edits the engine, model, effort,
and capacity for each hero. A setting change applies to the next dispatch.

- **Codex** uses `codex app-server` through its JSON-RPC socket.
- **Claude** uses `claude --print` in streaming mode. MINIMAC uses a bounded context policy for
  new and resumed Claude sessions.
- **Sim** is a scripted engine for local demos.

Worker lifecycle state is saved independently from checkpoint state. MINIMAC tracks starting,
running, stopping, stale, failed, and stopped workers. A checkpoint lease has a stable identity,
so late output from an old worker cannot complete new work.

On restart, MINIMAC restores the open run, saved workers, checkpoints, conversations, acceptance
policy, retry state, and evidence. Live sessions are checked before they are reused. Stale work is
recovered through the normal scheduler.

## Remote control

The default `boss` mode makes Thor available through the engine's remote-control feature.
`--remote-control all` enables it for every seat. `--remote-control off` keeps all sessions local.

Claude applies remote control per session. Codex applies it to the app-server daemon, so all Codex
sessions on that daemon share the same setting. MINIMAC does not change a daemon that was already
running.

## Middleware and fleet tools

Every dispatch and steer passes through one ordered middleware pipeline. It includes the
engineering contract, current policy, role, crew, goal, checkpoint brief, dependencies, files,
proof requirements, relevant conversation, and report contract. Editable steps are visible in
**MIDDLEWARE**.

Every Codex and Claude session also receives the local `minimac` MCP server. The MCP process does
not own fleet state. It sends authenticated requests to the running MINIMAC server, which owns the
roster, workers, goals, board, conversations, reports, and events.

Workers can report progress, request a checkpoint split, and escalate to Thor. Thor can inspect
the crew and board, publish or regroup a plan, change goals, start ready work, and bench workers.
Tool calls and UI actions use the same application services.

## Data and local API

MINIMAC stores local state in `data/minimac.db` with Node's built-in SQLite support. The `data/`
directory is ignored by Git.

- `GET /runs` lists missions.
- `GET /replay?run=<id>&agent=<id>` returns one agent's event stream.

## Repository layout

```text
core/         Pure domain logic: board, workers, flows, conversations, acceptance, and estimates
application/  Use cases: planning, scheduling, leases, conversations, and runtime supervision
ports/        Engine and storage interfaces
adapters/     Codex, Claude, simulator, SQLite, Git, file, and upload adapters
ui/           Floor, panels, detail views, conversations, and controls
test/         Node test suites
server.mjs    HTTP, WebSocket, command, and application wiring
floor.html    Shared layout and visual tokens
```

The server uses Node built-ins. The browser loads one pinned Three.js build from a CDN.

Custom roster settings belong in `roster.json`, which Git ignores. Use `roster.example.json` as
the template. Custom character models belong in `assets/characters/`, which Git also ignores.

The floor uses CC0 art from [Kenney](https://kenney.nl).
