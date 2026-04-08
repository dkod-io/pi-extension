/**
 * guard.ts — Pi extension guard that blocks tools bypassing dkod session isolation.
 *
 * During generator sessions, agents must use dk CLI tools (dk_file_write, dk_submit, etc.)
 * for all code changes. This guard intercepts tool_call events and blocks:
 *   - Write / Edit tools (must use dk --json agent file-write)
 *   - GitHub API tools (must use dk CLI)
 *   - Bash commands that write to the filesystem (must use dk --json agent file-write)
 *
 * Bash commands starting with "dk" are always allowed — they are the approved interface.
 */

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

let generatorSessionActive = false;

export function setGeneratorSession(active: boolean): void {
  generatorSessionActive = active;
}

export function isGeneratorSession(): boolean {
  return generatorSessionActive;
}

// ---------------------------------------------------------------------------
// Blocked tool names (lowercase for case-insensitive matching)
// ---------------------------------------------------------------------------

const BLOCKED_TOOLS: Set<string> = new Set(["write", "edit"]);

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** Matches any mcp__github__* tool name */
const GITHUB_API_PATTERN = /^mcp__github__/;

/** Matches dk CLI invocations — always allowed */
const DK_CLI_PATTERN = /^\s*dk\b/;

/**
 * Matches bash commands that perform file-write or git-mutating operations.
 * Each alternative is kept readable on its own line.
 */
const BASH_WRITE_PATTERNS: RegExp[] = [
  /(?:^|[;&|])\s*\S*\s*>{1,2}/,         // > or >> (output redirection)
  /\bcat\s+<<\b/,                        // cat << (heredoc)
  /\btee\b/,                             // tee
  /\bsed\s+.*-i\b/,                      // sed -i (in-place edit)
  /\bgit\s+add\b/,                       // git add
  /\bgit\s+commit\b/,                    // git commit
  /\bgit\s+push\b/,                      // git push
  /\bmv\b/,                              // mv
  /\bcp\b/,                              // cp
  /\brm\b/,                              // rm
  /\bmkdir\b/,                           // mkdir
];

// ---------------------------------------------------------------------------
// Guard registration
// ---------------------------------------------------------------------------

export function registerGuard(pi: any): void {
  pi.on("tool_call", (event: any) => {
    // Outside a generator session, allow everything.
    if (!generatorSessionActive) {
      return undefined;
    }

    const toolName: string = (event.tool ?? event.name ?? "").toLowerCase();

    // --- Block Write / Edit tools ---
    if (BLOCKED_TOOLS.has(toolName)) {
      return {
        blocked: true,
        message: `Tool "${toolName}" is blocked during generator sessions — use dk --json agent file-write instead.`,
      };
    }

    // --- Block GitHub API tools ---
    if (GITHUB_API_PATTERN.test(toolName)) {
      return {
        blocked: true,
        message: `Tool "${toolName}" is blocked during generator sessions — use dk CLI instead.`,
      };
    }

    // --- Block bash commands that write to the filesystem ---
    if (toolName === "bash") {
      const command: string = event.input?.command ?? event.params?.command ?? "";

      // Always allow dk CLI commands
      if (DK_CLI_PATTERN.test(command)) {
        return undefined;
      }

      for (const pattern of BASH_WRITE_PATTERNS) {
        if (pattern.test(command)) {
          return {
            blocked: true,
            message: `Bash write operation blocked during generator sessions — use dk --json agent file-write instead.`,
          };
        }
      }
    }

    // Everything else is allowed.
    return undefined;
  });
}
