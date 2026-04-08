import { registerGuard } from "./guard.js"
import { registerDkhCommand } from "./commands/dkh.js"
import { registerPlanCommand } from "./commands/plan.js"
import { registerEvalCommand } from "./commands/eval.js"
import { registerConfigCommand } from "./commands/config.js"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export default function dkodExtension(pi: any): void {
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
      pi.notify(
        "dk CLI not found. Run /dkod:config or install: curl -fsSL https://dkod.io/install.sh | sh",
        "error"
      )
    }
  })
}
