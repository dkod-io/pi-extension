import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export function registerConfigCommand(pi: any): void {
  pi.registerCommand({
    name: "dkod:config",
    label: "Configure dkod extension",
    action: async () => {
      // Check dk binary
      try {
        const { stdout } = await execFileAsync("dk", ["--version"])
        pi.notify(`dk CLI found: ${stdout.trim()}`)
      } catch {
        pi.notify(
          "dk CLI not found. Install: curl -fsSL https://dkod.io/install.sh | sh",
          "error"
        )
        return
      }

      // Check auth via preflight connect
      try {
        await execFileAsync(
          "dk",
          ["--json", "agent", "connect", "--repo", "test", "--intent", "preflight"],
          { timeout: 10_000 }
        )
        pi.notify("dkod authenticated and connected")
      } catch {
        pi.notify(
          "Not authenticated. Run `dk login` to authenticate with dkod.",
          "error"
        )
      }
    },
  })
}
