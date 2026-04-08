import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export function registerPlanCommand(pi: any): void {
  pi.registerCommand({
    name: "dkh:plan",
    label: "Plan a parallel build (planning only)",
    action: async (args: string) => {
      const promptPath = path.resolve(__dirname, "../../prompts/planner.md")
      const plannerPrompt = readFileSync(promptPath, "utf-8")

      pi.sendUserMessage(
        `${plannerPrompt}\n\n## Build Prompt\n\nProduce a plan for the following. Do NOT build — only plan.\n\n${args}`
      )
    },
  })
}
