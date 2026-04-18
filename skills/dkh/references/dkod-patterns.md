# dkod Patterns: Session Lifecycle and Merge Strategies

Deep reference for all agents on dkod-specific patterns — session management, merge
sequencing, conflict resolution, and the landing pipeline.

## Session Lifecycle

### Connect Phase

Every agent (planner, generator, evaluator) creates its own session:

```
dk --json agent connect \
  --repo "org/repo" \
  --agent-name "generator-unit-3" \
  --intent "Implement task CRUD API"
→ session_id, changeset_id, codebase_summary
```

**Rules:**
- One session per agent. Never share sessions.
- Use descriptive `--agent-name` — it appears in conflict reports and event streams.
- Use descriptive `--intent` — it's recorded in the changeset for traceability.
- The session sees a consistent snapshot at connection time. Other agents' uncommitted
  work is invisible.
- Store `session_id` as `$SID` and pass it on every subsequent `dk --json agent` call.

### Read Phase

Use `dk --json agent context` for semantic understanding:
```
dk --json agent context --session $SID "createTask"
→ symbol source, callers, callees, dependencies
```

Use `dk --json agent file-read` for raw file content:
```
dk --json agent file-read --session $SID --path "src/api/tasks.ts"
→ file content (overlay version if modified, base version otherwise)
```

Use `dk --json agent file-list` for directory structure:
```
dk --json agent file-list --session $SID --path "src/"
→ all files under src/ with modification metadata
```

### Write Phase

```
dk --json agent file-write --session $SID --path "src/api/tasks.ts" <local-tmp-file>
→ new_hash, detected_changes, conflict_warnings
```

**Key behaviors:**
- Writes go to the session overlay only — invisible to other agents.
- Always write the COMPLETE file content, not patches (pass the whole file via the local temp file).
- The response includes `detected_changes` — which symbols dkod detected as added/modified.
- **Symbol locking:** Each symbol you write acquires a lock. If another agent already holds
  the lock on the same symbol, the write returns `status: "locked"` with details about
  the lock holder. Your write DID NOT happen — you must wait and retry.
- Different symbols in the same file do NOT contend — only same-symbol writes are blocked.

**If `status: "locked"` is returned:**
```
dk --json agent watch --session $SID \
  --filter "symbol.lock.released" --wait               # blocks until lock releases
dk --json agent file-read --session $SID --path <p>    # read their merged code
dk --json agent file-write --session $SID --path <p> <tmp-adapted>   # write alongside their code
```

**Lock lifecycle:** Acquired on `dk --json agent file-write`, held through submit/review/merge,
released on `dk --json agent merge` success, `dk --json agent close`, or session timeout
(30 min).

### Submit Phase

```
dk --json agent submit --session $SID --message "Implement task CRUD API"
→ status: ACCEPTED | CONFLICT, changeset_id
```

**What happens on submit:**
1. dkod diffs the overlay against the base snapshot
2. If the base has moved (another agent merged), dkod auto-rebases
3. If auto-rebase succeeds, changeset is accepted
4. If auto-rebase finds symbol-level conflicts, returns CONFLICT with details

**On CONFLICT:** The response includes `conflicting_symbols[]` with:
- `file_path` — which file
- `qualified_name` — which symbol (e.g., "src/api/tasks.ts::createTask")
- `conflicting_agent` — who else touched it
- `their_change` / `your_change` / `base_version` — three-way context

### Verify Phase

```
dk --json agent verify --session $SID --changeset $CSID
→ stream of VerifyStepResult (lint, type-check, test, semantic)
```

**Steps run in order:**
1. **Lint** — ESLint, Clippy, etc.
2. **Type-check** — TypeScript, Rust compiler, etc.
3. **Test** — Only tests affected by changed symbols
4. **Semantic** — API compatibility, safety analysis

Each step returns: status (pass/fail), output, findings[], suggestions[].

### Approve Phase

```
dk --json agent approve --session $SID --changeset $CSID
→ changeset transitions to "approved" state
```

Pre-condition: changeset must be in "submitted" state with no unresolved conflicts.

### Merge Phase

```
dk --json agent merge --session $SID --changeset $CSID -m "feat: implement task CRUD API"
→ MergeSuccess | MergeConflict | OverwriteWarning
```

**MergeSuccess:**
```
{ commit_hash, auto_rebased: true/false, auto_rebased_files: [...] }
```

**MergeConflict:**
```
{ conflicts: [{ file_path, symbols, your_agent, their_agent, conflict_type }] }
```

**OverwriteWarning:**
```
{ recently_merged_symbols: [{ symbol, merged_by, merged_at }] }
→ Can proceed with --force
```

### Push Phase

```
dk --json push [--branch <name>]
→ pr_url (when pushing to PR) OR branch_name (when --branch is passed)
```

**Modes:**
- `dk --json push --branch <name>` — push to a branch only (file-sync helper)
- `dk --json push` — push to branch + open GitHub PR (orchestrator-only, SHIP phase)

## Streaming Merge Pipeline

Each generator owns its full pipeline: write → submit → verify → review → approve → merge.
There is no batch phase — generators merge as soon as they pass review. Symbol locks
ensure safe concurrent access at the engine level.

### Generator Self-Merge Flow

```
# Each generator runs this autonomously:
dk --json agent connect ...
dk --json agent file-write --session $SID --path <p> <tmp>      # acquires symbol locks
dk --json agent submit --session $SID --message "<intent>"
dk --json agent verify --session $SID --changeset $CSID
# review-fix loop (max 10 rounds)
dk --json agent approve --session $SID --changeset $CSID
dk --json agent merge --session $SID --changeset $CSID -m "<msg>"   # releases symbol locks → unblocks other generators
dk --json agent close --session $SID
```

**Why streaming?** Symbol locks are held until merge. If generators submit-and-wait
for batch merge, locks block other generators indefinitely (deadlock). Streaming merge
releases locks as soon as each generator finishes, maximizing parallelism.

### Conflict Resolution (by generators)

**Auto-merge (no action needed):**
- Different functions in the same file → dkod auto-merges
- Different fields added to the same type → dkod auto-merges
- Same import added by both agents → dkod deduplicates

**MergeConflict:** Follow the recovery steps in the `dk --json agent merge` response.

**OverwriteWarning:** `dk --json agent merge --session $SID --changeset $CSID --force -m "<msg>"`

### Post-Landing Verification

After all changesets are merged, run one final `dk --json agent verify` on the complete
codebase:
```
dk --json agent connect --repo <repo> --agent-name "harness-verifier" --intent "Final verification"
dk --json agent verify --session $SID
```

This catches integration issues that per-changeset verification might miss:
- Missing imports between merged modules
- Type mismatches at integration boundaries
- Test failures from symbol interactions

## Event Monitoring

The orchestrator can monitor generator progress via `dk --json agent watch`:

```
dk --json agent watch --session $SID --filter "changeset.*"
→ stream of events:
  - changeset.submitted (agent-3 submitted)
  - changeset.verify_started (agent-3 verification running)
  - changeset.merged (agent-1 merged successfully)
```

Use this to:
- Track which generators have finished
- Detect conflicts early (before the landing phase)
- Monitor verification progress

## Common Patterns

### Greenfield Project Setup

Scaffolding runs in parallel with feature generators -- no need to scaffold first. dkod
merges the scaffolding output with all feature generator outputs at the AST level.

```
dk --json agent connect --repo <repo> --agent-name "generator-scaffolding" --intent "Project scaffolding"
dk --json agent file-write --session $SID --path "package.json" <tmp>
dk --json agent file-write --session $SID --path "tsconfig.json" <tmp>
dk --json agent file-write --session $SID --path "vite.config.ts" <tmp>
dk --json agent file-write --session $SID --path "src/main.tsx" <tmp>
dk --json agent file-write --session $SID --path "src/App.tsx" <tmp>
dk --json agent file-write --session $SID --path "index.html" <tmp>
dk --json agent submit --session $SID --message "Project scaffolding with Vite + React + TypeScript"
```

This runs concurrently with all other generators. During landing, dkod auto-merges the
scaffolding files with feature code regardless of merge order.

### Inline Types Pattern

Generators define their own types locally instead of sharing a central type file.
Type duplication is cheap; coordination between generators is expensive.

```
// generator-tasks defines its own types
dk --json agent file-write --session $SID --path "src/api/tasks.ts" <tmp-with>
  interface Task { id: string; title: string; userId: string; status: TaskStatus; }
  type TaskStatus = 'todo' | 'in_progress' | 'done';
  // ... implementation using these types

// generator-users defines its own types independently
dk --json agent file-write --session $SID --path "src/api/users.ts" <tmp-with>
  interface User { id: string; email: string; name: string; }
  // ... implementation using these types
```

Each generator is self-contained. If types need to be shared later, the evaluator or a
post-landing cleanup pass can consolidate them.

### Config File Merging

dkod handles config file merging automatically. Multiple generators can add to the same
files simultaneously -- no special handling needed.

- **Code files** (router.ts, etc.) -- merged at the AST level
- **JSON files** (package.json) -- merged at the key level
- **Env files** (.env) -- merged line by line

Multiple generators can add to `package.json`, `router.ts`, and `.env` at the same time.
Different keys/routes/variables auto-merge; only true conflicts (same key, different value)
require resolution.

### Test Alongside Implementation

A generator can write tests as part of its unit:
```
dk --json agent file-write --session $SID --path "src/api/tasks.ts" <tmp-impl>
dk --json agent file-write --session $SID --path "src/api/__tests__/tasks.test.ts" <tmp-tests>
dk --json agent submit --session $SID --message "Task API with tests"
```

Then `dk --json agent verify` runs those tests as part of verification.

## Code Review

Code review runs automatically after every `dk --json agent submit`. Two tiers:

**Local review** (synchronous, included in submit response):
- Pattern-based checks: security issues, test gaps, convention violations
- Score returned inline: `review_summary.score` (1-5)
- Full findings via `dk --json agent review --session $SID --changeset $CSID`

**Deep review** (asynchronous, requires LLM API key):
- Multi-pass LLM analysis: security, logic, architecture, conventions
- Notification via `dk --json agent watch`: `changeset.review.completed` event
- Full findings via `dk --json agent review --session $SID --changeset $CSID`

**Score guide:**

| Score | Meaning | Generator action |
|-------|---------|------------------|
| 5 | No issues | Exit — changeset is clean |
| 4 | Minor warnings | Exit — unless `severity:"error"` finding present, then fix + re-submit |
| 3 | Test gaps or conventions | Fix + re-submit |
| 2 | Errors found | Fix + re-submit |
| 1 | Security issues | Fix + re-submit |

### Generator Review-Fix Loop

**Generators own the review-fix lifecycle.** After `dk --json agent submit`, each generator
stays alive to receive both local and deep review feedback and fix issues before exiting.

```
round = 1
dk --json agent submit --session $SID --message "<intent>"
  → response includes local review (score + findings)

LOOP while round <= 10:

  # 1. Check LOCAL review (inline with the submit that just ran)
  if local review has severity:"error" findings:
    fix files based on local findings
    round += 1
    if round > 10 → break
    dk --json agent submit --session $SID --message "<intent>"   # new local review
    continue                                                      # re-check local on the new submission

  # 2. Local is clean — wait for DEEP review
  dk --json agent watch --session $SID \
    --filter "changeset.review.completed" --wait               # blocks, zero LLM cost
  dk --json agent review --session $SID --changeset $CSID      # deep findings + score

  # 3. Check deep review
  if score >= 4 AND no severity:"error" findings:
    break  → changeset is clean

  # 4. Deep found issues — fix and re-submit
  fix files based on deep findings
  round += 1
  if round > 10 → break
  dk --json agent submit --session $SID --message "<intent>"   # new local review
  # loop continues — re-check local before waiting for deep again

EXIT: return { changeset_id, final_score, rounds_used }
```

**Round counting:** every `dk --json agent submit` (including the initial one) is a round. A
local-error re-submit consumes a round. This prevents local↔deep ping-pong from exceeding
the configured total (10 submissions in the streaming pipeline, or 3 for the orchestrator's
LAND fix-round cap).

**Key behaviors:**
- After every submit, local review is re-checked before proceeding to `dk --json agent watch` —
  no silent carrying of unfixed local errors into the deep-review wait
- `dk --json agent watch` blocks at tool level — zero LLM inference while waiting for deep review
- Max rounds, then exit regardless of score (review is advisory)
- The orchestrator collects changeset_ids + scores from generator exits — no dk status
  parsing or session-to-changeset mapping needed in LAND phase
- All generators run their review-fix loops in parallel (isolated sessions)
