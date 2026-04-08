# dkod Pi Extension Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Pi TUI extension that wraps the dk CLI as the dkod interface, enforces tool constraints at runtime, manages parallel generator subprocesses, and provides /dkh commands.

**Architecture:** Thin TypeScript extension — no HTTP client, no custom tool wrappers. dk CLI binary (--json mode) is the sole dkod interface. Pi's tool_call event blocks Write/Edit during generator sessions. RPC subprocesses give true OS-level parallelism for generators.

**Tech Stack:** TypeScript, Pi Extension API (@mariozechner/pi-coding-agent), dk CLI v0.2.69+, child_process for RPC subprocess management

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/index.ts` (stub)
- Create: `.gitignore`
- Create: `LICENSE`

**Step 1: Initialize package.json**

```json
{
  "name": "@dkod/pi",
  "version": "0.1.0",
  "description": "dkod extension for Pi — parallel agent execution with AST-level semantic merging",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/index.ts"]
  },
  "author": {
    "name": "dkod",
    "email": "hello@dkod.io"
  },
  "homepage": "https://dkod.io",
  "repository": "https://github.com/dkod-io/pi-extension",
  "license": "MIT",
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.5.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"]
}
```

**Step 3: Create stub src/index.ts**

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

export default function dkodExtension(pi: ExtensionAPI): void {
  // TODO: register commands, guard, and session_start check
}
```

**Step 4: Create .gitignore**

```
node_modules/
dist/
*.tgz
.DS_Store
```

**Step 5: Copy LICENSE from harness repo**

Use MIT license matching the harness.

**Step 6: Commit**

```bash
cd /Users/haimari/vsCode/haim-ari/github/dkod-io/pi-extension
git add -A
git commit -m "Initial scaffolding: package.json, tsconfig, stub extension entry"
```

---

### Task 2: Tool Guard (src/guard.ts)

**Files:**
- Create: `src/guard.ts`
- Modify: `src/index.ts`

**Step 1: Create guard.ts**

The guard subscribes to Pi's `tool_call` event. When a generator session flag is active,
it blocks tools that bypass dkod session isolation.

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

// Module-level flag — set by parallel.ts when spawning generator sessions
let generatorSessionActive = false

export function setGeneratorSession(active: boolean): void {
  generatorSessionActive = active
}

export function isGeneratorSession(): boolean {
  return generatorSessionActive
}

// Patterns that indicate file-write operations in bash commands
const BASH_WRITE_PATTERNS = [
  /\s*>\s/,           // redirect: echo "x" > file
  /\s*>>\s/,          // append: echo "x" >> file
  /\bcat\s*<<\s*/,    // heredoc: cat <<EOF > file
  /\btee\s/,          // tee file
  /\bsed\s+-i/,       // sed in-place
  /\bgit\s+add\b/,
  /\bgit\s+commit\b/,
  /\bgit\s+push\b/,
  /\bmv\s/,
  /\bcp\s/,
  /\brm\s/,
  /\bmkdir\s/,
]

// dk CLI commands are always allowed in bash
const DK_CLI_PATTERN = /\bdk\s+(--json\s+)?agent\s/

function isBashWriteCommand(command: string): boolean {
  if (DK_CLI_PATTERN.test(command)) return false  // dk CLI is always OK
  return BASH_WRITE_PATTERNS.some(pattern => pattern.test(command))
}

const BLOCKED_TOOLS = new Set([
  "write",
  "edit",
])

// GitHub API tools that bypass dkod
const GITHUB_API_PATTERN = /^mcp__github__/

export function registerGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event) => {
    if (!generatorSessionActive) return  // not in a generator — allow everything

    const toolName = event.tool.name.toLowerCase()

    // Block write/edit tools
    if (BLOCKED_TOOLS.has(toolName)) {
      return {
        block: true,
        reason: `Tool "${toolName}" is blocked during dkod generator sessions. ` +
                `Use dk --json agent file-write instead. ` +
                `Local filesystem tools bypass dkod session isolation.`
      }
    }

    // Block GitHub API tools
    if (GITHUB_API_PATTERN.test(toolName)) {
      return {
        block: true,
        reason: `GitHub API tool "${toolName}" is blocked during dkod generator sessions. ` +
                `Use dk CLI commands instead. Only dk_push (via orchestrator) creates PRs.`
      }
    }

    // Block bash commands that write files or use git
    if (toolName === "bash" && event.input?.command) {
      if (isBashWriteCommand(event.input.command)) {
        return {
          block: true,
          reason: `Bash command blocked: detected file write or git operation. ` +
                  `Use dk --json agent file-write for code changes. ` +
                  `Bash is allowed for dk CLI commands and read-only operations only.`
        }
      }
    }

    // Everything else is allowed
  })
}
```

**Step 2: Wire guard into index.ts**

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { registerGuard } from "./guard.js"

export default function dkodExtension(pi: ExtensionAPI): void {
  registerGuard(pi)
}
```

**Step 3: Commit**

```bash
git add src/guard.ts src/index.ts
git commit -m "Add runtime tool guard — blocks Write/Edit/git during generator sessions"
```

---

### Task 3: RPC Subprocess Manager (src/parallel.ts)

**Files:**
- Create: `src/parallel.ts`

**Step 1: Create parallel.ts**

Manages N Pi RPC subprocesses for parallel generator execution.

```typescript
import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"

export interface WorkUnit {
  id: string
  title: string
  owns: string[]
  creates: string[]
  criteria: string[]
  complexity: "low" | "medium" | "high"
}

export interface GeneratorResult {
  unitId: string
  status: "submitted" | "failed" | "timeout"
  changesetId?: string
  reviewScore?: number
  error?: string
}

interface RpcMessage {
  type: string
  [key: string]: unknown
}

const GENERATOR_TIMEOUT_MS = 45 * 60 * 1000  // 45 minutes

export async function dispatchGenerators(
  units: WorkUnit[],
  generatorPrompt: string,
  spec: string,
  repo: string,
): Promise<GeneratorResult[]> {
  const promises = units.map(unit =>
    spawnGeneratorSubprocess(unit, generatorPrompt, spec, repo)
  )
  return Promise.all(promises)
}

async function spawnGeneratorSubprocess(
  unit: WorkUnit,
  generatorPrompt: string,
  spec: string,
  repo: string,
): Promise<GeneratorResult> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM")
      resolve({
        unitId: unit.id,
        status: "timeout",
        error: `Generator timed out after 45 minutes`,
      })
    }, GENERATOR_TIMEOUT_MS)

    const child: ChildProcess = spawn("pi", [
      "--mode", "rpc",
      "--no-session",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    })

    let lastResponse: RpcMessage | null = null

    // Read JSONL responses from stdout
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout })
      rl.on("line", (line) => {
        try {
          const msg: RpcMessage = JSON.parse(line)
          lastResponse = msg
          // Look for generator report with changeset_id
          if (msg.type === "response" && typeof msg.changesetId === "string") {
            clearTimeout(timeout)
            child.kill("SIGTERM")
            resolve({
              unitId: unit.id,
              status: "submitted",
              changesetId: msg.changesetId as string,
              reviewScore: msg.reviewScore as number | undefined,
            })
          }
        } catch {
          // Non-JSON line — ignore
        }
      })
    }

    child.on("exit", () => {
      clearTimeout(timeout)
      // If we haven't resolved yet, the process exited without a changeset
      resolve({
        unitId: unit.id,
        status: "failed",
        error: "Generator process exited without producing a changeset",
      })
    })

    child.on("error", (err) => {
      clearTimeout(timeout)
      resolve({
        unitId: unit.id,
        status: "failed",
        error: `Generator process error: ${err.message}`,
      })
    })

    // Send the generator prompt + work unit as the initial message
    const prompt = buildGeneratorPrompt(unit, generatorPrompt, spec, repo)
    const rpcCommand = JSON.stringify({
      type: "send",
      message: prompt,
    })

    if (child.stdin) {
      child.stdin.write(rpcCommand + "\n")
    }
  })
}

function buildGeneratorPrompt(
  unit: WorkUnit,
  basePrompt: string,
  spec: string,
  repo: string,
): string {
  return [
    basePrompt,
    "",
    "## Your Work Unit",
    "",
    `**Title:** ${unit.title}`,
    `**OWNS (exclusive):** ${unit.owns.join(", ")}`,
    `**Creates:** ${unit.creates.join(", ")}`,
    `**Acceptance criteria:**`,
    ...unit.criteria.map(c => `- ${c}`),
    `**Complexity:** ${unit.complexity}`,
    "",
    `**Target repository:** ${repo}`,
    "",
    "## Specification",
    "",
    spec,
    "",
    "CRITICAL: Use dk --json agent file-write for ALL code. NEVER use write, edit, or bash file redirects.",
    `Your workflow: dk --json agent connect --repo ${repo} --intent "${unit.title}" → dk --json agent file-write → dk --json agent submit`,
  ].join("\n")
}
```

**Step 2: Commit**

```bash
git add src/parallel.ts
git commit -m "Add RPC subprocess manager for parallel generator dispatch"
```

---

### Task 4: Commands (src/commands/)

**Files:**
- Create: `src/commands/dkh.ts`
- Create: `src/commands/plan.ts`
- Create: `src/commands/eval.ts`
- Create: `src/commands/config.ts`
- Modify: `src/index.ts`

**Step 1: Create src/commands/config.ts**

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export function registerConfigCommand(pi: ExtensionAPI): void {
  pi.registerCommand({
    name: "dkod:config",
    label: "Configure dkod extension",
    action: async (ctx) => {
      // Check dk binary
      try {
        const { stdout } = await execFileAsync("dk", ["--version"])
        ctx.ui.notify(`dk CLI found: ${stdout.trim()}`)
      } catch {
        ctx.ui.notify(
          "dk CLI not found. Install: curl -fsSL https://dkod.io/install.sh | sh",
          "error"
        )
        return
      }

      // Check auth
      try {
        const { stdout } = await execFileAsync("dk", ["--json", "agent", "status"], {
          timeout: 10000,
        })
        ctx.ui.notify("dkod authenticated and connected")
      } catch {
        ctx.ui.notify("Not authenticated. Running dk login...")
        // dk login uses browser-based device flow
        await execFileAsync("dk", ["login"], { timeout: 120000 })
        ctx.ui.notify("dkod authenticated")
      }
    },
  })
}
```

**Step 2: Create src/commands/plan.ts**

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

export function registerPlanCommand(pi: ExtensionAPI): void {
  pi.registerCommand({
    name: "dkh:plan",
    label: "Plan a parallel build (planning only)",
    action: async (ctx) => {
      const promptPath = resolve(__dirname, "../prompts/planner.md")
      const plannerPrompt = readFileSync(promptPath, "utf-8")

      // Inject planner prompt as system context, then let Pi handle the conversation
      pi.sendUserMessage(
        `${plannerPrompt}\n\n## Build Prompt\n\nProduce a plan for the following. Do NOT build — only plan.\n\n$ARGUMENTS`
      )
    },
  })
}
```

**Step 3: Create src/commands/eval.ts**

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

export function registerEvalCommand(pi: ExtensionAPI): void {
  pi.registerCommand({
    name: "dkh:eval",
    label: "Evaluate the current application",
    action: async (ctx) => {
      const promptPath = resolve(__dirname, "../prompts/evaluator.md")
      const evalPrompt = readFileSync(promptPath, "utf-8")

      pi.sendUserMessage(
        `${evalPrompt}\n\nEvaluate the current state of the application. ` +
        `Look for existing spec/plan files. Score every criterion with evidence.`
      )
    },
  })
}
```

**Step 4: Create src/commands/dkh.ts**

The main command — triggers the full orchestrator pipeline.

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

export function registerDkhCommand(pi: ExtensionAPI): void {
  pi.registerCommand({
    name: "dkh",
    label: "Autonomous parallel build (full pipeline)",
    action: async (ctx) => {
      const promptPath = resolve(__dirname, "../prompts/orchestrator.md")
      const orchestratorPrompt = readFileSync(promptPath, "utf-8")

      pi.sendUserMessage(
        `${orchestratorPrompt}\n\n## Build Prompt\n\n$ARGUMENTS`
      )
    },
  })
}
```

**Step 5: Wire all commands into index.ts**

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { registerGuard } from "./guard.js"
import { registerDkhCommand } from "./commands/dkh.js"
import { registerPlanCommand } from "./commands/plan.js"
import { registerEvalCommand } from "./commands/eval.js"
import { registerConfigCommand } from "./commands/config.js"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export default function dkodExtension(pi: ExtensionAPI): void {
  registerGuard(pi)
  registerDkhCommand(pi)
  registerPlanCommand(pi)
  registerEvalCommand(pi)
  registerConfigCommand(pi)

  // Check dk binary on session start
  pi.on("session_start", async () => {
    try {
      await execFileAsync("dk", ["--version"], { timeout: 5000 })
    } catch {
      pi.ctx?.ui?.notify?.(
        "dk CLI not found. Run /dkod:config or install: curl -fsSL https://dkod.io/install.sh | sh",
        "error"
      )
    }
  })
}
```

**Step 6: Commit**

```bash
git add src/commands/ src/index.ts
git commit -m "Add /dkh, /dkh:plan, /dkh:eval, /dkod:config commands"
```

---

### Task 5: Adapt Agent Prompts (src/prompts/)

**Files:**
- Create: `src/prompts/planner.md`
- Create: `src/prompts/generator.md`
- Create: `src/prompts/evaluator.md`
- Create: `src/prompts/orchestrator.md`

**Step 1: Copy and adapt planner.md**

Copy from `/Users/haimari/vsCode/haim-ari/github/dkod-harness/harness/skills/dkh/agents/planner.md`.

Key adaptations:
- Remove Claude Code frontmatter (name, maxTurns) — Pi doesn't use these
- Change "Claude Code agent teams" references to "Pi RPC subprocesses"
- Change all MCP tool call syntax to dk CLI syntax:
  - `dk_connect(...)` becomes `dk --json agent connect --repo R --intent I`
  - `dk_context(...)` becomes `dk --json agent context --session S`
  - `dk_file_read(...)` becomes `dk --json agent file-read --session S --path P`
  - `dk_file_list(...)` becomes `dk --json agent file-list --session S`
- Keep everything else: symbol decomposition, work unit schema, acceptance criteria, bash rules, auto-discovery, aggregation symbols

**Step 2: Copy and adapt generator.md**

Copy from harness. Key adaptations:
- Remove frontmatter
- Change tool constraint table: dk CLI commands instead of MCP tool names
  - `dk_file_write` becomes `dk --json agent file-write --session $SID`
  - `dk_submit` becomes `dk --json agent submit --session $SID`
- Change workflow line to: `dk --json agent connect → dk --json agent file-read → dk --json agent file-write → dk --json agent submit`
- Remove references to Claude Code Agent tool
- Keep: review-fix loop, conflict handling, frontend-design skill, self-check, time budget

**Step 3: Copy and adapt evaluator.md**

Copy from harness. Key adaptations:
- Remove frontmatter
- Change dk_verify/dk_review references to dk CLI equivalents
- Keep everything else: scoring scale, chrome-devtools testing, design audit, interactive element audit, verdicts, anti-generosity checklist

**Step 4: Copy and adapt orchestrator.md**

Copy from harness. This has the most changes:
- Remove frontmatter
- Replace "Agent(subagent_type, model, prompt)" dispatch with RPC subprocess dispatch:
  - Phase 2: "Use the parallel.ts RPC manager to spawn N generator subprocesses"
  - Phase 4: "Dispatch evaluators sequentially using pi.sendUserMessage()"
- Replace "Claude Code agent teams" with "Pi RPC subprocesses"
- Change all MCP tool calls to dk CLI:
  - `dk_verify(changeset_id)` becomes `dk --json agent verify --session S`
  - `dk_review(changeset_id)` becomes `dk --json agent review --session S --changeset C`
  - `dk_approve(session_id)` becomes `dk --json agent approve --session S`
  - `dk_merge(session_id)` becomes `dk --json agent merge --session S`
  - `dk_push(mode: "pr")` becomes `dk push` (with appropriate flags)
- Replace model profile system (Pi uses setModel() API instead)
- Change preflight dk_connect to: `dk --json agent connect --repo R --intent "preflight"`
- Keep: all gates, state tracking, verdicts, round transitions, smoke test, decision table

**Step 5: Commit**

```bash
git add src/prompts/
git commit -m "Add adapted agent prompts for Pi + dk CLI"
```

---

### Task 6: Pi Skill Definition (skills/dkh/SKILL.md)

**Files:**
- Create: `skills/dkh/SKILL.md`

**Step 1: Create SKILL.md**

Pi skill format with frontmatter:

```markdown
---
name: dkh
description: >
  Autonomous harness for building complete applications from a single prompt. Uses dkod for
  parallel agent execution with AST-level semantic merging. Multiple generators run
  simultaneously as Pi RPC subprocesses — dkod handles merge conflicts at the AST level.
  Fully autonomous: one prompt in, working tested PR out.
---

# dkod Harness for Pi

Run /dkh followed by a build prompt to trigger a fully autonomous build pipeline:

1. Planner analyzes the codebase and produces parallel work units
2. N generators run simultaneously (Pi RPC subprocesses + dkod sessions)
3. Orchestrator lands, verifies, and merges all changesets
4. Evaluator tests the live app via chrome-devtools
5. Ship as PR or fix and retry (max 3 rounds)

## Prerequisites

- dk CLI v0.2.69+ (curl -fsSL https://dkod.io/install.sh | sh)
- Authenticated (dk login)
- Target repo connected to dkod (app.dkod.io)

## Commands

- /dkh <prompt> — full autonomous build
- /dkh:plan <prompt> — planning only
- /dkh:eval — evaluate current app
- /dkod:config — verify setup
```

**Step 2: Commit**

```bash
git add skills/
git commit -m "Add Pi skill definition for /dkh commands"
```

---

### Task 7: README

**Files:**
- Create: `README.md`

**Step 1: Write README**

Cover: what it is, install steps (dk CLI + dk login + pi install), usage (/dkh), how it works (architecture diagram), prerequisites, link to harness repo for details.

Keep it concise — under 100 lines.

**Step 2: Commit**

```bash
git add README.md
git commit -m "Add README with install and usage instructions"
```

---

### Task 8: Push and verify

**Step 1: Push to GitHub**

```bash
cd /Users/haimari/vsCode/haim-ari/github/dkod-io/pi-extension
git push -u origin main
```

**Step 2: Verify structure**

```bash
find . -not -path './.git/*' -not -path './node_modules/*' -type f | sort
```

Expected:
```
./.gitignore
./LICENSE
./README.md
./docs/plans/2026-04-08-pi-extension-design.md
./docs/plans/2026-04-08-pi-extension-implementation.md
./package.json
./skills/dkh/SKILL.md
./src/commands/config.ts
./src/commands/dkh.ts
./src/commands/eval.ts
./src/commands/plan.ts
./src/guard.ts
./src/index.ts
./src/parallel.ts
./src/prompts/evaluator.md
./src/prompts/generator.md
./src/prompts/orchestrator.md
./src/prompts/planner.md
./tsconfig.json
```
