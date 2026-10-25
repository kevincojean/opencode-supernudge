import type { Hooks } from "@opencode-ai/plugin"

export type InjectResult = string | undefined

export type NormalMessageDelivery = {
  position: "start" | "end"
  text: string
}

export type PrimaryInvisibleProvider = (
  sessionID: string,
  messageText: string,
) => NormalMessageDelivery[]

export type PromptContext = {
  promptIndex: number
  interval: number
  alwaysOnFirst: boolean
  resetOnCompaction: boolean
  enabled: boolean
  position: "start" | "end"
  content: string
  title: string
  visible: boolean
  markerEnabled: boolean
  prefix: string
  suffix: string
}

export type ResolvedAutonomousPrompt = {
  "enabled.subagentAutonomousWorkNudge": boolean
  "injection.subagentInterval": number
  "injection.subagentAlwaysOnFirst": boolean
  "injection.subagentResetOnCompaction": boolean
  "position.subagent": "start" | "end"
  "injection.skipOnRegexMatch": string[]
  "nudge.visible": boolean
  "nudge.visibleMarker": boolean
  "wrapper.prefix": string
  "wrapper.suffix": string
  content: string
  title: string
  explicitVisibleMarker: boolean
}

export interface TurnBoundMessageInjector {
  incrementTurnCount(sessionID: string, promptIndex: number): number
  resetTurnCount(sessionID: string): void
  resetOnCompaction(sessionID: string, prompts: ResolvedAutonomousPrompt[]): void
  inject(sessionID: string, promptIndex: number, ctx: PromptContext, target: unknown, parts?: unknown[]): InjectResult
  hooks(): Partial<Hooks>
}
