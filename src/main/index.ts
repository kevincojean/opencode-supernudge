import type { Plugin } from "@opencode-ai/plugin"
import { parse as parseJsonc } from "jsonc-parser"
import type { ParseError } from "jsonc-parser"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

type Position = "start" | "end"

type PromptConfig = {
  "injection.interval": number
  "injection.alwaysOnFirstMessage": boolean
  "injection.resetCounterOnCompaction": boolean
  "position.normalMessage": Position
  "position.subagent": Position
  "position.compaction": Position
  "enabled.normalMessage": boolean
  "enabled.subagent": boolean
  "enabled.compaction": boolean
  "wrapper.prefix": string
  "wrapper.suffix": string
  "nudge.separator": string
}

type PromptEntry = string | ({ path: string } & Partial<PromptConfig>)

type Config = PromptConfig & {
  "prompts": PromptEntry[]
}

type ResolvedPrompt = PromptConfig & { content: string }

const DEFAULTS: Config = {
  "prompts": [],
  "injection.interval": 1,
  "injection.alwaysOnFirstMessage": true,
  "injection.resetCounterOnCompaction": true,
  "position.normalMessage": "start",
  "position.subagent": "start",
  "position.compaction": "start",
  "enabled.normalMessage": true,
  "enabled.subagent": true,
  "enabled.compaction": true,
  "wrapper.prefix": "<opencode-supernudge>",
  "wrapper.suffix": "</opencode-supernudge>",
  "nudge.separator": "\n\n",
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

function resolvePath(p: string): string {
  const home = process.env.HOME
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1))
  }
  return home ? p.split("$HOME").join(home) : p
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
): ResolvedPrompt[] {
  const result: ResolvedPrompt[] = []
  for (const entry of prompts) {
    const obj = typeof entry === "string" ? { path: entry } : entry
    const resolved: PromptConfig = { ...defaults, ...obj } as PromptConfig
    const filePath = resolvePath(obj.path)
    if (!fs.existsSync(filePath)) continue
    const content = fs.readFileSync(filePath, "utf-8")
    if (content.trim()) {
      result.push({ ...resolved, content })
    }
  }
  return result
}

function getNudge(configPath: string): { prompts: ResolvedPrompt[]; prefix: string; suffix: string; separator: string } {
  const config = loadConfig(configPath)
  const { prompts, ...defaults } = config
  return {
    prompts: resolvePrompts(prompts, defaults),
    prefix: defaults["wrapper.prefix"],
    suffix: defaults["wrapper.suffix"],
    separator: defaults["nudge.separator"],
  }
}

const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  ".config/opencode/opencode-supernudge/supernudge-configuration.jsonc",
)

const plugin: Plugin = async (_input, options) => {
  const optConfigPath = options?.configPath
  const configPath = typeof optConfigPath === "string"
    ? optConfigPath
    : DEFAULT_CONFIG_PATH

  const counters = new Map<string, number[]>()

  return {
    "chat.message": async (input, output) => {
      const { prompts: resolvedPrompts, prefix, suffix, separator } = getNudge(configPath)
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

        if (prompt["position.normalMessage"] === "end") {
          endTexts.push(prompt.content)
        } else {
          startTexts.push(prompt.content)
        }
      }

      if (startTexts.length === 0 && endTexts.length === 0) return

      const existing = output.parts.find(p => p.type === "text" && "text" in p)
      if (!existing) return
      const target = existing as { text: string }

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
      const { prompts: resolvedPrompts, prefix, suffix } = getNudge(configPath)
      if (resolvedPrompts.length === 0) return

      const startPrompts: string[] = []
      const endPrompts: string[] = []

      for (const prompt of resolvedPrompts) {
        if (!prompt["enabled.subagent"]) continue
        if (prompt["position.subagent"] === "end") {
          endPrompts.push(prompt.content)
        } else {
          startPrompts.push(prompt.content)
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
      const { prompts: resolvedPrompts, prefix, suffix } = getNudge(configPath)

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
          endPrompts.push(prompt.content)
        } else {
          startPrompts.push(prompt.content)
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
  }
}

export default plugin
