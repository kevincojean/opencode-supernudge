import type { Plugin } from "@opencode-ai/plugin"
import { parse as parseJsonc } from "jsonc-parser"
import type { ParseError } from "jsonc-parser"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SubAgentMessageInjector } from "./injectors/sub-agent-message-injector.ts"

type Position = "start" | "end"

type PromptConfig = {
  "injection.interval": number
  "injection.alwaysOnFirstMessage": boolean
  "injection.resetCounterOnCompaction": boolean
  "position.normalMessage": Position
  "position.subagent": Position
  "position.compaction": Position
  "enabled.normalMessage": boolean
  "enabled.subagentSystemPromptNudge": boolean
  "enabled.subagentAutonomousWorkNudge": boolean
  "enabled.compaction": boolean
  "wrapper.prefix": string
  "wrapper.suffix": string
  "nudge.separator": string
  "nudge.enableTitlePrefix": boolean
  "nudge.trim": boolean
  "injection.skipFirstMessageBelowChars": number
  "injection.subagentInterval": number
  "injection.subagentAlwaysOnFirst": boolean
  "injection.subagentResetOnCompaction": boolean
}

type PromptEntry = string | ({ path: string } & Partial<PromptConfig>)

type Config = PromptConfig & {
  "prompts": PromptEntry[]
}

type ResolvedPrompt = PromptConfig & { content: string; title: string }

const DEFAULTS: Config = {
  "prompts": [],
  "injection.interval": 1,
  "injection.alwaysOnFirstMessage": true,
  "injection.resetCounterOnCompaction": true,
  "position.normalMessage": "start",
  "position.subagent": "start",
  "position.compaction": "start",
  "enabled.normalMessage": true,
  "enabled.subagentSystemPromptNudge": true,
  "enabled.compaction": true,
  "wrapper.prefix": "<opencode-supernudge>",
  "wrapper.suffix": "</opencode-supernudge>",
  "nudge.separator": "\n\n",
  "nudge.enableTitlePrefix": true,
  "nudge.trim": true,
  "injection.skipFirstMessageBelowChars": 3,
  "enabled.subagentAutonomousWorkNudge": true,
  "injection.subagentInterval": 1,
  "injection.subagentAlwaysOnFirst": true,
  "injection.subagentResetOnCompaction": true,
}

function withTitle(prompt: ResolvedPrompt): string {
  if (!prompt["nudge.enableTitlePrefix"]) return prompt.content
  return `[${prompt.title}] ${prompt.content}`
}

function wrapString(content: string, prefix: string, suffix: string): string {
  const parts: string[] = []
  if (prefix) parts.push(prefix)
  parts.push(content)
  if (suffix) parts.push(suffix)
  return parts.join("\n")
}

function wrapArray(items: string[], prefix: string, suffix: string): string[] {
  const result: string[] = []
  if (prefix) result.push(prefix)
  result.push(...items)
  if (suffix) result.push(suffix)
  return result
}

function resolvePath(p: string, baseDir: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1))
  }
  const home = process.env.HOME
  const withHome = home ? p.split("$HOME").join(home) : p
  if (!path.isAbsolute(withHome)) {
    return path.resolve(baseDir, withHome)
  }
  return withHome
}

function loadConfig(configPath: string): Config {
  if (!fs.existsSync(configPath)) return DEFAULTS
  const text = fs.readFileSync(configPath, "utf-8")
  const errors: ParseError[] = []
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true })
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return DEFAULTS
  }
  return { ...DEFAULTS, ...(parsed as Record<string, unknown>) } as Config
}

function resolvePrompts(
  prompts: readonly PromptEntry[],
  defaults: PromptConfig,
  baseDir: string,
): ResolvedPrompt[] {
  const result: ResolvedPrompt[] = []
  for (const entry of prompts) {
    const obj = typeof entry === "string" ? { path: entry } : entry
    const resolved: PromptConfig = { ...defaults, ...obj } as PromptConfig
    const filePath = resolvePath(obj.path, baseDir)
    if (!fs.existsSync(filePath)) continue
    const rawContent = fs.readFileSync(filePath, "utf-8")
    const content = resolved["nudge.trim"] ? rawContent.trim() : rawContent
    if (content) {
      const title = path.basename(filePath, path.extname(filePath)).toLowerCase()
      result.push({ ...resolved, content, title })
    }
  }
  return result
}

function getNudge(configPath: string, baseDir: string): { prompts: ResolvedPrompt[]; prefix: string; suffix: string; separator: string } {
  const config = loadConfig(configPath)
  const { prompts, ...defaults } = config
  return {
    prompts: resolvePrompts(prompts, defaults, baseDir),
    prefix: defaults["wrapper.prefix"],
    suffix: defaults["wrapper.suffix"],
    separator: defaults["nudge.separator"],
  }
}

const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  ".config/opencode/opencode-supernudge/supernudge-configuration.jsonc",
)

const plugin: Plugin = async (input, options) => {
  const baseDir = input.directory
  const optConfigPath = options?.configPath
  const configPath = typeof optConfigPath === "string"
    ? optConfigPath
    : DEFAULT_CONFIG_PATH

  const counters = new Map<string, number[]>()

  const subAgentInjector = new SubAgentMessageInjector(() => getNudge(configPath, baseDir).prompts)

  return {
    ...subAgentInjector.hooks(),
    "chat.message": async (input, output) => {
      const { prompts: resolvedPrompts, prefix, suffix, separator } = getNudge(configPath, baseDir)
      if (resolvedPrompts.length === 0) return

      let promptCounts = counters.get(input.sessionID)
      if (!promptCounts || promptCounts.length !== resolvedPrompts.length) {
        promptCounts = new Array(resolvedPrompts.length).fill(0)
      }
      for (let i = 0; i < promptCounts.length; i++) {
        promptCounts[i]++
      }
      counters.set(input.sessionID, promptCounts)

      const startTexts: string[] = []
      const endTexts: string[] = []

      const messageText = output.parts.find(p => p.type === "text" && "text" in p)
        ? ((output.parts.find(p => p.type === "text" && "text" in p) as { text: string }).text)
        : ""
      const skipThreshold = (p: ResolvedPrompt) => p["injection.skipFirstMessageBelowChars"]

      for (let i = 0; i < resolvedPrompts.length; i++) {
        const prompt = resolvedPrompts[i]
        if (!prompt["enabled.normalMessage"]) continue
        const count = promptCounts[i]
        const interval = prompt["injection.interval"]
        const shouldInject =
          interval <= 1 ||
          (count === 1
            ? prompt["injection.alwaysOnFirstMessage"]
            : (count - 1) % interval === 0)
        if (!shouldInject) continue
        if (messageText.length <= skipThreshold(prompt)) continue

        if (prompt["position.normalMessage"] === "end") {
          endTexts.push(withTitle(prompt))
        } else {
          startTexts.push(withTitle(prompt))
        }
      }

      let target = output.parts.find(p => p.type === "text" && "text" in p) as { text: string } | undefined
      if (!target) return

      if (startTexts.length > 0) {
        const block = startTexts.join(separator)
        const wrapped = wrapString(block, prefix, suffix)
        target.text = wrapped + "\n\n" + target.text
      }
      if (endTexts.length > 0) {
        const block = endTexts.join(separator)
        const wrapped = wrapString(block, prefix, suffix)
        target.text = target.text + "\n\n" + wrapped
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (input.sessionID) return
      const { prompts: resolvedPrompts, prefix, suffix } = getNudge(configPath, baseDir)
      if (resolvedPrompts.length === 0) return

      const startPrompts: string[] = []
      const endPrompts: string[] = []

      for (const prompt of resolvedPrompts) {
        if (!prompt["enabled.subagentSystemPromptNudge"]) continue
        if (prompt["position.subagent"] === "end") {
          endPrompts.push(withTitle(prompt))
        } else {
          startPrompts.push(withTitle(prompt))
        }
      }

      if (startPrompts.length > 0) {
        const block = wrapArray(startPrompts, prefix, suffix)
        output.system.unshift(...block)
      }
      if (endPrompts.length > 0) {
        const block = wrapArray(endPrompts, prefix, suffix)
        output.system.push(...block)
      }
    },
    "experimental.session.compacting": async (input, output) => {
      const { prompts: resolvedPrompts, prefix, suffix } = getNudge(configPath, baseDir)

      subAgentInjector.resetOnCompaction(input.sessionID, resolvedPrompts)

      const promptCounts = counters.get(input.sessionID)
      if (promptCounts) {
        for (let i = 0; i < resolvedPrompts.length && i < promptCounts.length; i++) {
          if (resolvedPrompts[i]["injection.resetCounterOnCompaction"]) {
            promptCounts[i] = 0
          }
        }
      }

      const startPrompts: string[] = []
      const endPrompts: string[] = []

      for (const prompt of resolvedPrompts) {
        if (!prompt["enabled.compaction"]) continue
        if (prompt["position.compaction"] === "end") {
          endPrompts.push(withTitle(prompt))
        } else {
          startPrompts.push(withTitle(prompt))
        }
      }

      if (startPrompts.length > 0) {
        const block = wrapArray(startPrompts, prefix, suffix)
        output.context.unshift(...block)
      }
      if (endPrompts.length > 0) {
        const block = wrapArray(endPrompts, prefix, suffix)
        output.context.push(...block)
      }
    },
    ...subAgentInjector.hooks(),
  }
}

export default plugin
