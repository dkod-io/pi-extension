---
name: dkh
description: >
  Autonomous harness for building complete applications from a single prompt. Uses dkod for
  parallel agent execution with AST-level semantic merging. Multiple generators run
  simultaneously as Pi RPC subprocesses — dkod handles merge conflicts at the AST level.
  Fully autonomous: one prompt in, working tested PR out.
---

# dkod Harness for Pi

Run `/dkh` followed by a build prompt to trigger a fully autonomous build pipeline:

1. **Plan** — Planner analyzes the codebase and produces parallel work units
2. **Build** — N generators run simultaneously (Pi RPC subprocesses + dkod sessions)
3. **Land** — Orchestrator verifies, reviews, approves, and merges all changesets
4. **Eval** — Evaluator tests the live app via chrome-devtools
5. **Ship** — Push as PR, or fix and retry (max 3 rounds)

## Prerequisites

- dk CLI v0.2.69+ (`curl -fsSL https://dkod.io/install.sh | sh`)
- Authenticated (`dk login`)
- Target repo connected to dkod (app.dkod.io)

## Commands

- `/dkh <prompt>` — full autonomous build
- `/dkh:plan <prompt>` — planning only (produce spec + work units)
- `/dkh:eval` — evaluate current app against criteria
- `/dkod:config` — verify dk binary and authentication
