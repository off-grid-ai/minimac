# MINIMAC

A floor for watching and steering a fleet of AI coding agents.

Ten minutes of agent work should take ten minutes — and you should know inside one of them
if it will not.

## Run it

```bash
node server.mjs --repo /path/to/the/project/you/want/worked/on
```

Then open http://127.0.0.1:4600.

`--repo` is the folder the agents work in. Everything else has a default, including the
Codex daemon: minimac starts one if nothing is listening, and leaves alone one that is.

| flag | what it does | default |
|---|---|---|
| `--repo <dir>` | the project the agents work in | the current directory |
| `--mission "..."` | what the fleet is for; every seat gets a goal derived from it | none |
| `--port <n>` | where the floor is served | `4600` |
| `--engine <name>` | force every seat onto one engine: `codex`, `claude` or `sim` | per-agent from the roster |
| `--roster <file>` | your own names, colours and meshes for each seat | the built-in roster |
| `--team "..."` | what the Avengers call themselves in every dispatch | `the Avengers` |
| `--contract <file>` | seed the standing instruction from this file | `.codex/ENGINEERING_CONTRACT.md` in the repo |
| `--hook "..."` | extra standing instruction, on top of the contract | none |
| `--skills a,b` | skills every agent is told to apply, e.g. `hygiene,tests` | none |
| `--isolate` | give each agent its own git worktree so they cannot collide | off |
| `--codex-url <ws>` | the Codex app-server socket | `ws://127.0.0.1:4573` |
| `--remote-control [who]` | which seats you can reach from your phone: `boss`, `all`, `off` | `boss` — the orchestrator, always |

To see the floor without any CLI running, use the simulated engine:

```bash
node server.mjs --engine sim --mission "demo run"
```

## Remote control

Thor is on your account's remote control whenever the floor is up, so the Codex or
Claude app on another device opens the same conversation the floor is showing. He is
the seat worth reaching that way: the crew reports to him, and he rules on everything
the floor derives. `--remote-control all` puts every seat on it; `--remote-control off`
keeps every session on this machine.

The two engines honour it differently, and it is worth knowing which one a seat is on:

- **Claude** takes it per session, so only the named seats get one. The name is what
  you pick it out by on the other device — `minimac-the-avengers-thor`, stable across
  restarts, so a seat resumes under the name it already had.
- **Codex** enables it on the app-server daemon, not on one thread. Wanting it for the
  orchestrator therefore turns it on for every Codex seat on that daemon, and minimac
  says so on the way up. A daemon that was already listening is left exactly as it is —
  its sessions are on whatever footing it was started with.

## Engines

Each seat runs on Codex or Claude, switchable from the Avengers panel at any time; it takes
effect on that agent's next dispatch. The floor never knows which engine a desk is on.

- **Codex** talks to `codex app-server` over its JSON-RPC socket. Started automatically.
- **Claude** spawns `claude --print` in streaming mode.
- **Sim** is a scripted fake behind the same port, for demos.

## The loop

1. **Type the mission.** Every seat gets a role-derived goal immediately, so nobody can be
   dispatched blind. Those show as `GOAL · default` — placeholders, not decisions.
2. **ASSEMBLE.** The orchestrator decides who the mission actually needs, stands the rest
   down, writes each of the chosen a real goal, and splits the work into board items with
   owners. He can ask for several of one hero when the work genuinely splits — three pull
   requests to review is three reviewers.
3. **START ALL.** The Avengers work. He walks each order across the floor as he gives it.
4. **Answer what reaches you.** Everything else is his.

## What you are looking at

- **The Avengers bar** — always on, never moving: every hero, whether they are working, and
  what they are doing in plain words. A bubble is an *event*; this is *state*.
- **The floor** — one desk per agent. Posture is state: typing, thinking, pacing (the loop
  detector firing), slumped when blocked, out of the chair when carrying an order. Monitor
  brightness is event rate, paper is diff size, an emerald pulse is a verified step. A hero
  who is not working says nothing.
- **The header** — the whole question at once: what is left, how far along, and time
  against the fleet's own estimate. Red when the fleet is past its promise.
- **FEED** — the stream, with the board pinned above it. Filters: `all`, `crosstalk` (only
  the heroes talking to each other), `signal` (that plus anything that changes what happens
  next), `evidence` (claims, and the command behind each), `board` (work moving).
- **DECISIONS** — the only thing allowed to interrupt you. Derived cards (a loop, an
  overrun, silence, a missing estimate, a plan that was never sharpened) and questions the
  heroes ask you themselves. Answering a question opens a thread; it closes when you say
  SETTLED.
- **AVENGERS** — each seat's engine, how many of them, its goal, its working switch, and
  a conversation input. The same input stays under a selected agent's feed.
- **MISSIONS** — every past mission, kept whole. CONTINUE resumes the same conversations;
  RUN AGAIN starts them clean on the same goals.

Standing at a desk shows that agent's own flow and evidence there.

## The board

One shared list of work, so coordination stops being prose. An item has an owner, a gate
chain — `coding → wiring → lint → test → commits → push` — evidence, and what it is waiting
on. The chain is enforced: a gate cannot pass before the ones before it, cannot pass
without the command that proved it, and cannot be moved by anyone but its owner. Velocity
is gate-completion rate, because an agent can talk for an hour and pass nothing.

## Governance

The room derives what nobody reported — repeat loops, time against the agent's own
estimate, silence that means hung rather than thinking, claims with no command behind them.
A new finding wakes the orchestrator in one batched turn, and he rules: hold, steer,
re-goal, start, bench, or escalate to you. Start opens a real session. Bench stops that
session and takes the Avenger off the mission; those are one action, not two states.
You see every card he touched.

Two invariants. An approval freezes an engine and is never delegated. A card *about* the
orchestrator never goes to the orchestrator — nobody supervises themselves.

Heroes can also ask for you directly, for the things watching them could never reveal:
a decision, a conflict, something they are blocked on. And they can stand themselves down
when their work is finished, rather than sitting idle in a chair.

## Fleet tools

Every Codex and Claude session gets the same local `minimac` MCP server. The MCP process
has no fleet state. It sends authenticated calls to the running MINIMAC server, which is
the single owner of the roster, goals, board, reports, and events.

All Avengers can report progress and escalate a handoff to Thor. Thor can assemble the
full roster, start or bench an Avenger, change an Avenger's goal, and assign shared board
work. Assemble starts the selected Avengers and benches all others. These tools use the
same server operations as the floor controls, so a tool call and a click cannot disagree.

## Speaking once

The composer has three destinations besides a named hero:

- **MISSION** — what this run is for.
- **POLICY** — one sentence that binds every agent on every dispatch and every steer, from
  now on, with no model in the path deciding whether it applies.
- **THOR** — say it once; he decides who needs to hear it and what it means for each.

## The middleware

Every dispatch and every steer is composed through one ordered pipeline, so a rule you
would otherwise retype each session is enforced once. It carries the standing instruction
(your repo's engineering contract, plus any policy), the role, the crew, the goal, the
board, that agent's own closed steps, the plan-sharpening loop, the house style, and the
report contract. Rewrite any editable step live in MIDDLEWARE.

Messages from the agent conversation inputs use this same pipeline. They are stored once,
then sent with the current middleware. A message to a benched Avenger starts the session
through that pipeline before it is delivered.

**Plan, sharpen, sharpen again** — for the coder, tester and auditor: write the plan,
attack it and rewrite, cut it and rewrite, act on the third. The room raises a card when a
step ran on a first draft.

## Where the data goes

`data/minimac.db` (SQLite, via Node's built-in `node:sqlite`). Every mission, event, goal,
board item and claim is recorded, so a morning that went wrong can be reopened and read
back — and so estimates can eventually come from your real history instead of a guess.

A restart is not the end of a mission: minimac rejoins the open one, replays its history
into the monitor, and honestly resets every agent to idle with no session, because those
sessions really are gone.

`GET /runs` lists missions. `GET /replay?run=<id>&agent=<id>` returns one agent's stream.

## Layout

```
core/       pure domain - no I/O, no DOM, no clock it was not handed
              board, monitor, governance, errands, flows, derive,
              dispatch, events, goals, roster, readable, claims,
              mentions, middleware, attention
ports/      the one Driver interface every engine implements
adapters/   codex, codexd (daemon lifecycle), claude, sim,
              sqlite store, git worktrees, fs, uploads
server.mjs  transport and wiring only
ui/         the floor and the panels
assets/     Kenney pixel art (CC0)
```

Zero dependencies: Node built-ins on the server, one pinned three.js from a CDN in the
browser.

Your own roster lives in `roster.json` (gitignored); `roster.example.json` is the template.
Drop a `.glb` into `assets/characters/` and that seat uses it.

Art from [Kenney](https://kenney.nl) under CC0.
