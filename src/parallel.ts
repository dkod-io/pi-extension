import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

// ── Interfaces ──────────────────────────────────────────────────────────

export interface WorkUnit {
  id: string;
  title: string;
  owns: string[];
  creates: string[];
  criteria: string[];
  complexity: "low" | "medium" | "high";
}

export interface GeneratorResult {
  unitId: string;
  status: "submitted" | "failed" | "timeout";
  changesetId?: string;
  reviewScore?: number;
  error?: string;
}

// ── Constants ───────────────────────────────────────────────────────────

const GENERATOR_TIMEOUT_MS = 45 * 60 * 1000; // 45 minutes

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Dispatch one generator subprocess per work unit and wait for all to
 * settle. Each subprocess talks to `pi --mode rpc` over JSONL stdio.
 */
export async function dispatchGenerators(
  units: WorkUnit[],
  generatorPrompt: string,
  spec: string,
  repo: string,
): Promise<GeneratorResult[]> {
  const promises = units.map((unit) =>
    spawnGeneratorSubprocess(unit, generatorPrompt, spec, repo),
  );
  return Promise.all(promises);
}

// ── Internal ────────────────────────────────────────────────────────────

/**
 * Build the full prompt that a generator subprocess receives.
 * Joins the base prompt, work-unit details, target repo, and spec,
 * then appends a critical tool-use reminder.
 */
function buildGeneratorPrompt(
  unit: WorkUnit,
  basePrompt: string,
  spec: string,
  repo: string,
): string {
  const sections: string[] = [
    basePrompt,
    "",
    "## Work Unit",
    `**Title:** ${unit.title}`,
    `**ID:** ${unit.id}`,
    `**Complexity:** ${unit.complexity}`,
    `**Owns:** ${unit.owns.join(", ")}`,
    `**Creates:** ${unit.creates.join(", ")}`,
    "",
    "### Acceptance Criteria",
    ...unit.criteria.map((c) => `- ${c}`),
    "",
    `## Target Repository: ${repo}`,
    "",
    "## Specification",
    spec,
    "",
    "---",
    "CRITICAL: You MUST use `dk --json agent file-write` for ALL file creation and modification.",
    "NEVER use Write, Edit, or Bash tools to create or modify code files.",
  ];

  return sections.join("\n");
}

/**
 * Spawn a single `pi --mode rpc --no-session` child process,
 * feed it the generator prompt over stdin as JSONL, and watch
 * stdout for a changeset submission or process termination.
 */
function spawnGeneratorSubprocess(
  unit: WorkUnit,
  generatorPrompt: string,
  spec: string,
  repo: string,
): Promise<GeneratorResult> {
  return new Promise<GeneratorResult>((resolve) => {
    let settled = false;

    const settle = (result: GeneratorResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    // Spawn the RPC subprocess
    const child: ChildProcess = spawn("pi", ["--mode", "rpc", "--no-session"], {
      stdio: ["pipe", "pipe", "ignore"],
    });

    // 45-minute hard timeout
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ unitId: unit.id, status: "timeout" });
    }, GENERATOR_TIMEOUT_MS);

    // Read JSONL lines from stdout
    const rl = createInterface({ input: child.stdout! });

    rl.on("line", (line: string) => {
      try {
        const msg = JSON.parse(line);
        if (msg.changesetId) {
          settle({
            unitId: unit.id,
            status: "submitted",
            changesetId: msg.changesetId,
            reviewScore: msg.reviewScore,
          });
        }
      } catch {
        // Non-JSON lines are ignored
      }
    });

    // Process exit without having found a changeset
    child.on("exit", () => {
      settle({ unitId: unit.id, status: "failed" });
    });

    // Spawn error (e.g. binary not found)
    child.on("error", (err: Error) => {
      settle({
        unitId: unit.id,
        status: "failed",
        error: err.message,
      });
    });

    // Send the initial prompt as JSONL to stdin
    const prompt = buildGeneratorPrompt(unit, generatorPrompt, spec, repo);
    const payload = JSON.stringify({ type: "send", message: prompt });
    child.stdin!.write(payload + "\n");
    child.stdin!.end();
  });
}
