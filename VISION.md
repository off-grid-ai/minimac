# MINIMAC — vision, mission, and the bar

The source of truth for why this exists. Everything below was said across several
sessions and is aggregated here so it stops living in a transcript. Read it before
adding a surface. If a change does not move the north star, it is not the work.

---

## North star

**Ten minutes of agent work takes ten minutes — and you know inside one of them if it won't.**

## Vision

You command a crew, you never babysit one. Directing a fleet of AI agents should feel
like watching a team work, not reading their logs. Eventually the commander's seat is
filled by an orchestrator trained on your own decisions.

## Mission

Make every agent's work visible, evidence-backed, and steerable at a glance. Turn raw
machine output into the one thing a human can act on: what's moving, what's stuck, and
what needs you.

## Goal

Make the fleet worth looking at, so you catch drift while it's still ten minutes old —
not three hours.

---

## Why it exists

You're accountable for work you can't see. The output is walls of lint counts, file
paths and commands that mean nothing at a glance, so you stopped watching. Your only
lever is interrupting and asking it to explain itself in words you understand. That's
you doing by hand what a tool should do.

## What it solves

Agents drift, loop on the same file, and report confident numbers with nothing behind
them — "95% done" becomes "62 errors and nothing pushed." Run several and they collide,
duplicate work, and wait on each other in silence. Goals get set once and never tracked
again. You end up the bottleneck and the last to know.

## How it solves it

A thin layer sits between you and the agents. Every dispatch carries your engineering
contract, the agent's role, its goal, and a schema that forces answers as user flows
with a receipt behind each claim. One server drives both Codex and Claude, records every
event, and derives what neither reports — repeat loops, time against estimate, silence,
claims with no evidence. A live floor renders it as a room of working agents, so state is
something you glance at, not something you read. It taps you only when the call is yours:
steer, split, or kill, with goals editable per worker and for the orchestrator.

## What outcomes it achieves

You catch a stall in minutes instead of finding it three hours later. You run five agents
with less attention than one used to cost, because the screen tells you which one needs
you. Status you can trust: every claim carries the command that produced it, so "done"
means done. And you stop repeating the same correction, because it's enforced at dispatch
instead of typed again each session.

## Why it beats the alternatives

CrewAI and LangGraph orchestrate prompts, but your workers are already complete agents —
you need a supervisor, not another agent loop. The CLIs' own output is a firehose with no
notion of drift, loops, or unbacked claims. Nothing else grades a claim by whether a
command actually produced it. And nothing else is a screen you'd willingly keep open on a
second monitor.

---

## The bar (Mac's guidance, ingested)

- **The room IS the product**, not a skin on a dashboard. A tab you have to go find is a
  failure of the room.
- **Everything arrives as user flows in plain English**, with a receipt behind each claim.
- **Icons over words, toggles over buttons.** Nothing raw or machine-shaped reaches your
  eyes.
- **Interaction is a loop**: you act, the world visibly answers.
- **Nothing ships unwatched.** Verified live, not merely merged. A premature "complete"
  is a defect.

## How it fits Off Grid

It runs entirely on your machine, watching your own tools, with nothing leaving the
device. Same thesis as the rest of the product — your work stays yours, and you keep
control of it — applied to the agents doing the work.

---

## The standing failure mode

Recorded because it has already happened, and it is the thing to check this doc against:

> "That promise is *legibility and steering*, and I've spent the afternoon building a
> dashboard around it — tabs, runs, editors, a folder picker — while FLOW and EVIDENCE
> are still empty, drift still shows as false alarms, and you still can't tell what an
> agent is doing without reading a log. Every feature I added was real; almost none of it
> moved the north star."

The test for any proposed change: **does it shorten the time between an agent going wrong
and you seeing it?** If not, it is a surface, and surfaces are the drift.
