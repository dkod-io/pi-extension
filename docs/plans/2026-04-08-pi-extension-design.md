# Design: dkod Pi Extension

**Date:** 2026-04-08
**Status:** Approved

## Overview

A Pi TUI extension that brings dkod's parallel agent execution to Pi users.
Install with `pi install npm:@dkod/pi`, run `/dkh <prompt>`, get a working PR.

## Key Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| dkod interface | dk CLI binary (--json mode) | No HTTP client, no custom tools. CLI handles auth, gRPC, protocol. All 13 agent commands available in v0.2.69. |
| Prompt sharing | Vendor copies in pi-extension | Prompts will diverge for Pi (dk CLI syntax, RPC parallelism, Pi-specific tool names). |
| Auth | dk login (CLI handles it) | No custom auth flow needed. dk CLI manages its own credentials. |
| Parallelism | RPC subprocesses (pi --mode rpc) | True OS-level parallelism. Each generator is an isolated Pi process using dk CLI via Bash. |
| Tool constraints | Runtime enforcement via tool_call event | Block Write/Edit/Bash-file-writes/GitHub-API during generator sessions. Prompts get ignored, event hooks do not. |

## Architecture

The extension is thin. It does not wrap the dkod API. It delegates to the dk CLI binary.

```
Pi TUI Session
  - /dkh command triggers orchestrator prompt
       - Planner (in-process): Bash dk --json agent connect/context
       - N Generators (RPC subprocesses, parallel)
         each: Bash dk --json agent connect/file-write/submit
         tool_call guard blocks Write/Edit in each subprocess
       - Land (orchestrator): Bash dk --json agent verify/review/approve/merge
       - File Sync: Bash dk push --branch + git checkout
       - Smoke Test: Bash bun install + bun dev + chrome-devtools
       - Evaluators (sequential, in-process): chrome-devtools testing
```

## dk CLI Command Mapping (v0.2.69)

All commands support --json for machine-parseable output.

| Operation | dk CLI command | Key flags |
|-----------|---------------|-----------|
| Connect | dk agent connect --repo R --intent I | --json |
| Search | dk agent context --session S | --json |
| Read file | dk agent file-read --session S --path P | --json |
| Write file | dk agent file-write --session S | --json |
| List files | dk agent file-list --session S | --json |
| Submit | dk agent submit --session S | --json |
| Verify | dk agent verify --session S | --json |
| Review | dk agent review --session S --changeset C | --json |
| Approve | dk agent approve --session S | --json |
| Merge | dk agent merge --session S | --json |
| Watch | dk agent watch --session S | --json |
| Status | dk agent status --session S | --json |
| Push | dk push | various modes |

## File Structure

```
dkod-io/pi-extension/
  package.json                  @dkod/pi, keywords: pi-package
  tsconfig.json
  src/
    index.ts                    Extension factory: registers commands + guard
    guard.ts                    tool_call handler: blocks Write/Edit/git in generators
    parallel.ts                 RPC subprocess manager: spawn/collect N generators
    commands/
      dkh.ts                    /dkh: full autonomous build
      plan.ts                   /dkh:plan: planning only
      eval.ts                   /dkh:eval: evaluation only
      config.ts                 /dkod:config: verify dk binary + dk login
    prompts/                    Adapted from harness for Pi + dk CLI
      orchestrator.md
      planner.md
      generator.md
      evaluator.md
  skills/
    dkh/
      SKILL.md                  Pi skill format
  README.md
```

## Component Details

### src/index.ts: Extension Factory

Registers commands, tool guard, and checks dk binary is on PATH at session start.
No custom tool registrations. All dkod operations go through Bash + dk CLI.

### src/guard.ts: Runtime Tool Enforcement

Subscribes to tool_call event. When a generator session flag is active:

Blocked tools:
- write, edit: bypass dkod session isolation
- bash: if command contains file write operations or git commands
- Any mcp github tools

Allowed tools:
- bash: for dk CLI commands, timeout, ls, pwd (read-only)
- read: reading files is non-destructive
- grep, find, ls: search/discovery tools

Returns block: true with guidance to use dk CLI instead.

### src/parallel.ts: RPC Subprocess Manager

Spawns N pi --mode rpc --no-session processes, one per generator work unit.
Each subprocess receives the generator prompt + work unit via JSONL stdin.
Collects changeset_id + review_score from each stdout.
45-minute timeout per generator. Guard extension loaded in each subprocess.

### src/prompts/: Adapted Agent Prompts

Copied from harness, modified for Pi + dk CLI:

| Change | Harness (Claude Code) | Pi Extension |
|--------|----------------------|--------------|
| dkod ops | MCP tool calls | Bash: dk --json agent ... |
| Parallelism | Agent() tool dispatch | RPC subprocesses via parallel.ts |
| Tool blocking | Prompt-level FORBIDDEN table | Runtime tool_call event guard |
| Model selection | model: parameter on Agent | Pi setModel() API per session |

### Commands

| Command | Description |
|---------|-------------|
| /dkh prompt | Full autonomous build: plan, build, land, eval, ship |
| /dkh:plan prompt | Planning only: produce spec + work units |
| /dkh:eval | Evaluate current app state against criteria |
| /dkod:config | Verify dk binary, run dk login, check connection |

## Install Experience

```
# 1. Install dk CLI
curl -fsSL https://dkod.io/install.sh | sh

# 2. Authenticate
dk login

# 3. Install the Pi extension
pi install npm:@dkod/pi

# 4. Build something
/dkh Build a task management app with kanban boards and real-time sync
```

## NOT in v1

- Custom TUI widgets (dkod status panel, progress bars)
- Model profile selection UI (hardcode balanced)
- dk binary auto-install (user installs manually)
- Pi marketplace listing (manual npm install first)
