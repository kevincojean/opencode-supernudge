import type { Plugin } from "@opencode-ai/plugin"
import { parse as parseJsonc } from "jsonc-parser"
import type { ParseError } from "jsonc-parser"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

type Position = "start" | "end"

type Config = {
  "prompts": string[]
  "injection.interval": number
  "injection.alwaysOnFirstMessage": boolean
  "injection.resetCounterOnCompaction": boolean
  "position.normalMessage": Position
  "position.subagent": Position
  "position.compaction": Position
  "enabled.normalMessage": boolean
  "enabled.subagent": boolean
  "enabled.compaction": boolean
}

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

function loadPrompts(prompts: readonly string[]): string {
  const loaded: string[] = []
  for (const p of prompts) {
    const resolved = resolvePath(p)
    if (!fs.existsSync(resolved)) continue
    const content = fs.readFileSync(resolved, "utf-8")
    if (content.trim()) {
      loaded.push(content)
    }
  }
  return loaded.join("\n\n")
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

  const config = loadConfig(configPath)
  const nudgeText = loadPrompts(config["prompts"])
  const counters = new Map<string, number>()

  return {
    "chat.message": async (input, output) => {
      if (!config["enabled.normalMessage"]) return
      if (!nudgeText) return
      const count = (counters.get(input.sessionID) ?? 0) + 1
      counters.set(input.sessionID, count)
      const interval = config["injection.interval"]
      const shouldInject =
        (count === 1 && config["injection.alwaysOnFirstMessage"]) ||
        interval <= 1 ||
        (count - 1) % interval === 0
      if (!shouldInject) return
      const existing = output.parts.find(p => p.type === "text" && "text" in p)
      if (!existing) return
      const target = existing as { text: string }
      if (config["position.normalMessage"] === "end") {
        target.text = target.text + "\n\n" + nudgeText
      } else {
        target.text = nudgeText + "\n\n" + target.text
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!config["enabled.subagent"]) return
      if (input.sessionID) return
      if (!nudgeText) return
      if (config["position.subagent"] === "end") {
        output.system.push(nudgeText)
      } else {
        output.system.unshift(nudgeText)
      }
    },
    "experimental.session.compacting": async (input, output) => {
      if (!config["enabled.compaction"]) return
      if (config["injection.resetCounterOnCompaction"]) {
        counters.delete(input.sessionID)
      }
      if (!nudgeText) return
      if (config["position.compaction"] === "end") {
        output.context.push(nudgeText)
      } else {
        output.context.unshift(nudgeText)
      }
    },
  }
}

export default plugin
