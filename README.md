# MINIMAC

A floor for watching and steering a fleet of AI coding agents.

Catch drift while it is ten minutes old, not three hours old.

## Run it

```bash
node server.mjs --repo /path/to/the/project/you/want/worked/on
```

Then open http://127.0.0.1:4600.

`--repo` is the folder the agents work in. Everything else has a default.

| flag | what it does | default |
|---|---|---|
| `--repo <dir>` | the project the agents work in | the current directory |
| `--mission "..."` | the run's mission; every agent gets a goal derived from it | `unnamed run` |
| `--port <n>` | where the floor is served | `4600` |
| `--engine <name>` | force every seat onto one engine: `codex`, `claude` or `sim` | per-agent from the roster |
| `--contract <file>` | a contract prepended to every dispatch, e.g. your ENGINEERING_CONTRACT.md | none |
| `--skills a,b` | skills every agent is told to apply, e.g. `hygiene,tests` | none |
| `--isolate` | give each agent its own git worktree so they cannot collide | off |
| `--codex-url <ws>` | the Codex app-server socket | `ws://127.0.0.1:4573` |

A realistic run:

```bash
node server.mjs \
  --repo ~/wednesday/off-grid-ai/desktop \
  --mission "Ship Replay meeting cards end to end" \
  --contract ~/wednesday/off-grid-ai/.codex/ENGINEERING_CONTRACT.md \
  --skills hygiene,tests \
  --isolate
```

To see the floor without any CLI running, use the simulated engine:

```bash
node server.mjs --engine sim --mission "demo run"
```

## Engines

Each seat runs on Codex or Claude, switchable from the crew panel at any time; it takes
effect on that agent's next dispatch.

- **Codex** talks to `codex app-server`. Start it first: `codex app-server daemon start`.
- **Claude** spawns `claude --print` in streaming mode. Nothing to start.
- **Sim** is a scripted fake that implements the same port, for demos.

## What you are looking at

- **The floor** — one desk per agent. Posture is state: typing, thinking, pacing (that is
  the loop detector firing), slumped when blocked. Monitor brightness is event rate. Paper
  is diff size. An emerald pulse is a verified step.
- **Flow contract** — the agent's promised steps in user-flow language, each with a burn
  bar of actual against estimate.
- **Evidence tape** — every claim, graded `observed` / `derived` / `guessed`. A claim with
  no command behind it is dimmed and struck through.
- **Decisions** — the only thing allowed to interrupt you. Steer, split, or kill.

## Goals

Set the mission and every seat gets a goal derived from its role — product writes the flow
contract, tester proves it on the real surface, and so on. An agent with no goal cannot be
started. Edit any goal in the crew panel; a goal you set by hand is never overwritten.

## Where the data goes

`data/minimac.db` (SQLite, via Node's built-in `node:sqlite`). Every run, event, goal and
claim is recorded, so a finished run can be replayed and measured — which is how estimates
eventually come from your real history instead of an agent's guess.

`GET /runs` lists runs. `GET /replay?run=<id>&agent=<id>` returns one agent's stream.

## Layout

```
core/       pure domain - no I/O, no DOM
ports/      the one Driver interface every engine implements
adapters/   codex, claude, sim, sqlite, git worktrees
server.mjs  transport and wiring only
ui/         the floor and the panels
assets/     Kenney pixel art (CC0)
```

Art from [Kenney](https://kenney.nl) under CC0.
