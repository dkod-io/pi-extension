import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export function registerDkhCommand(pi: any): void {
  pi.registerCommand({
    name: "dkh",
    label: "Autonomous parallel build (full pipeline)",
    action: async (args: string) => {
      const promptPath = path.resolve(__dirname, "../../prompts/orchestrator.md")
      const orchestratorPrompt = readFileSync(promptPath, "utf-8")

      pi.sendUserMessage(
        `${orchestratorPrompt}\n\n## Build Prompt\n\n${args}`
      )
    },
  })
}
