import type { PluginInput } from "@opencode-ai/plugin"

export function shouldSkipOnRegex(
  text: string,
  patterns: string[],
  client?: PluginInput["client"],
): boolean {
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern).test(text)) {
        return true
      }
    } catch {
      client?.tui.showToast({
        body: {
          title: "SuperNudge",
          message: `Invalid regex pattern in injection.skipOnRegexMatch: ${pattern}`,
          variant: "error",
        },
      })
    }
  }
  return false
}