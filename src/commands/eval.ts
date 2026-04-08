import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export function registerEvalCommand(pi: any): void {
  pi.registerCommand({
    name: "dkh:eval",
    label: "Evaluate the current application",
    action: async () => {
      const promptPath = path.resolve(__dirname, "../../prompts/evaluator.md")
      const evalPrompt = readFileSync(promptPath, "utf-8")

      pi.sendUserMessage(
        `${evalPrompt}\n\nEvaluate the current state of the application. ` +
        `Look for existing spec/plan files. Score every criterion with evidence.`
      )
    },
  })
}
