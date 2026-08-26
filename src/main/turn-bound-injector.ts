import type { Hooks } from "@opencode-ai/plugin"

export type InjectResult = string | undefined

export type PromptContext = {
  promptIndex: number
  interval: number
  alwaysOnFirst: boolean
  resetOnCompaction: boolean
  enabled: boolean
  position: "start" | "end"
  content: string
  title: string
}

export type ResolvedAutonomousPrompt = {
  "enabled.subagentAutonomousWorkNudge": boolean
  "injection.subagentInterval": number
  "injection.subagentAlwaysOnFirst": boolean
  "injection.subagentResetOnCompaction": boolean
  "position.subagent": "start" | "end"
  content: string
  title: string
}

export interface TurnBoundMessageInjector {
  incrementTurnCount(sessionID: string, promptIndex: number): number
  resetTurnCount(sessionID: string): void
  resetOnCompaction(sessionID: string, prompts: ResolvedAutonomousPrompt[]): void
  inject(sessionID: string, promptIndex: number, ctx: PromptContext, target: unknown): InjectResult
  hooks(): Partial<Hooks>
}
