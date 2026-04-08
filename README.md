# @dkod/pi

dkod extension for [Pi](https://github.com/badlogic/pi-mono) — parallel agent execution with AST-level semantic merging.

One prompt in. Working, tested PR out. Zero human interaction in between.

## What is this?

A Pi TUI extension that brings [dkod](https://dkod.io)'s parallel agent execution to Pi. Multiple AI agents implement different parts of your application simultaneously — dkod's AST-level merge eliminates conflicts between agents editing the same files.

Built on the [dkod harness](https://github.com/dkod-io/harness) architecture: Planner, Generator, Evaluator pattern from [Anthropic's research](https://www.anthropic.com/engineering/harness-design-long-running-apps).

## Install

```bash
# 1. Install dk CLI
curl -fsSL https://dkod.io/install.sh | sh

# 2. Authenticate
dk login

# 3. Install the Pi extension
pi install npm:@dkod/pi
```

## Usage

### Full autonomous build

```
/dkh Build a project management webapp with kanban boards, team collaboration, and real-time updates
```

That's it. The harness does the rest.

### Plan only

```
/dkh:plan Build a recipe sharing platform with user profiles and ingredient search
```

### Evaluate existing code

```
/dkh:eval
```

### Check setup

```
/dkod:config
```

## How it works

```
"Build a task management app"
    |
    v
  PLANNER        Expands prompt -> spec -> parallel work units
    |
    v
  GENERATORS     N Pi RPC subprocesses, each with its own dkod session
  (parallel)     All writing code simultaneously via dk CLI
    |
    v
  dkod MERGE     AST-level semantic merge (zero conflicts)
    |
    v
  EVALUATOR      Starts app, tests via chrome-devtools, scores criteria
    |
    v
  PASS? -> PR    FAIL? -> re-dispatch fixes (max 3 rounds)
```

## Architecture

- **dk CLI** (`--json` mode) is the sole dkod interface — no HTTP client
- **Pi RPC subprocesses** give true OS-level parallelism for generators
- **Runtime tool guard** blocks Write/Edit/Bash-file-writes during generator sessions (enforced via Pi's `tool_call` event, not just prompts)
- **Agent prompts** adapted from the [harness](https://github.com/dkod-io/harness) for Pi + dk CLI syntax

## Prerequisites

- [Pi](https://github.com/badlogic/pi-mono) TUI
- [dk CLI](https://github.com/dkod-io/dkod-engine) v0.2.69+
- Chrome DevTools (for live UI testing during evaluation)

## License

MIT
