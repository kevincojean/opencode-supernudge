import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type {
  ResolvedAutonomousPrompt,
  TurnBoundMessageInjector,
  PromptContext,
  InjectResult,
  PrimaryInvisibleProvider,
} from "../turn-bound-injector.ts"
import { shouldSkipOnRegex } from "./regex-skip.ts"
import { createSyntheticTextPart, insertSyntheticPart } from "./synthetic-part.ts"

type TextPartTarget = { type: "text"; text: string; messageID?: string }

function shouldInject(count: number, interval: number, alwaysOnFirst: boolean): boolean {
  if (interval <= 1) return true
  if (count === 1) return alwaysOnFirst
  return (count - 1) % interval === 0
}

function wrapString(content: string, prefix: string, suffix: string): string {
  const parts: string[] = []
  if (prefix) parts.push(prefix)
  parts.push(content)
  if (suffix) parts.push(suffix)
  return parts.join("\n")
}

export class SubAgentMessageInjector implements TurnBoundMessageInjector {
  private counters = new Map<string, number[]>()
  private primarySessions = new Set<string>()
  private resolvePrompts: () => ResolvedAutonomousPrompt[]
  private client: PluginInput["client"] | undefined
  private primaryInvisibleProvider: PrimaryInvisibleProvider | undefined

  constructor(
    resolvePrompts: () => ResolvedAutonomousPrompt[],
    client?: PluginInput["client"],
  ) {
    this.resolvePrompts = resolvePrompts
    this.client = client
  }

  setPrimaryInvisibleProvider(fn: PrimaryInvisibleProvider): void {
    this.primaryInvisibleProvider = fn
  }

  incrementTurnCount(sessionID: string, promptIndex: number): number {
    const current = this.counters.get(sessionID) ?? []
    const next = (current[promptIndex] ?? 0) + 1
    current[promptIndex] = next
    this.counters.set(sessionID, current)
    return next
  }

  resetTurnCount(sessionID: string): void {
    this.counters.delete(sessionID)
    this.primarySessions.delete(sessionID)
  }

  resetOnCompaction(sessionID: string, prompts: ResolvedAutonomousPrompt[]): void {
    const current = this.counters.get(sessionID)
    if (!current) return
    for (let i = 0; i < prompts.length && i < current.length; i++) {
      if (prompts[i]["injection.subagentResetOnCompaction"]) {
        current[i] = 0
      }
    }
  }

  inject(
    sessionID: string,
    promptIndex: number,
    ctx: PromptContext,
    target: unknown,
    parts: unknown[] = [],
  ): InjectResult {
    if (!ctx.enabled) return undefined
    const count = this.counters.get(sessionID)?.[promptIndex] ?? 0
    if (count === 0) return undefined
    if (!shouldInject(count, ctx.interval, ctx.alwaysOnFirst)) return undefined
    const part = target as TextPartTarget
    if (!part || part.type !== "text") return undefined
    let block = ctx.title ? `[${ctx.title}] ${ctx.content}` : ctx.content
    if (ctx.markerEnabled) block = wrapString(block, ctx.prefix, ctx.suffix)
    if (!ctx.visible) {
      insertSyntheticPart(
        parts as Array<{ type: string }>,
        createSyntheticTextPart({
          sessionID,
          messageID: part.messageID ?? "",
          partKey: `prompt-${promptIndex}`,
          text: block,
        }),
        ctx.position,
      )
      return block
    }
    if (ctx.position === "end") {
      part.text = part.text + "\n\n" + block
    } else {
      part.text = block + "\n\n" + part.text
    }
    return block
  }

  private ctxFor(prompt: ResolvedAutonomousPrompt, promptIndex: number): PromptContext {
    return {
      promptIndex,
      interval: prompt["injection.subagentInterval"],
      alwaysOnFirst: prompt["injection.subagentAlwaysOnFirst"],
      resetOnCompaction: prompt["injection.subagentResetOnCompaction"],
      enabled: true,
      position: prompt["position.subagent"],
      content: prompt.content,
      title: prompt.title,
      visible: prompt["nudge.visible"],
      markerEnabled: prompt.explicitVisibleMarker,
      prefix: prompt["wrapper.prefix"],
      suffix: prompt["wrapper.suffix"],
    }
  }

  private trackSession(info: { id?: string; parentID?: string }): void {
    if (!info.id) return
    if (info.parentID) {
      this.primarySessions.delete(info.id)
    } else {
      this.primarySessions.add(info.id)
    }
  }

  hooks(): Partial<Hooks> {
    return {
      "experimental.text.complete": async (input) => {
        const prompts = this.resolvePrompts()
        for (let i = 0; i < prompts.length; i++) {
          if (!prompts[i]["enabled.subagentAutonomousWorkNudge"]) continue
          this.incrementTurnCount(input.sessionID, i)
        }
      },
      "experimental.chat.messages.transform": async (_input, output) => {
        const prompts = this.resolvePrompts()
        if (prompts.length === 0) return
        if (output.messages.length === 0) return
        const lastMessage = output.messages[output.messages.length - 1]
        if (lastMessage.parts.length === 0) return
        const lastPart = lastMessage.parts[lastMessage.parts.length - 1]
        if (!lastPart || lastPart.type !== "text") return
        const sessionID = (lastMessage.info as { sessionID?: string }).sessionID
        if (!sessionID) return
        const lastPartText = (lastPart as { text: string }).text
        const messageID = (lastMessage.info as { id?: string }).id ?? ""

        const deliveries = this.primaryInvisibleProvider?.(sessionID, lastPartText) ?? []
        if (deliveries.length > 0) {
          const startParts: ReturnType<typeof createSyntheticTextPart>[] = []
          const endParts: ReturnType<typeof createSyntheticTextPart>[] = []
          for (let i = 0; i < deliveries.length; i++) {
            const delivery = deliveries[i]
            const part = createSyntheticTextPart({
              sessionID,
              messageID,
              partKey: `normal-${i}`,
              text: delivery.text,
            })
            if (delivery.position === "start") {
              startParts.push(part)
            } else {
              endParts.push(part)
            }
          }
          lastMessage.parts = [...startParts, ...lastMessage.parts, ...endParts]
        }

        if (this.primarySessions.has(sessionID)) return
        for (let i = 0; i < prompts.length; i++) {
          const prompt = prompts[i]
          if (!prompt["enabled.subagentAutonomousWorkNudge"]) continue

          if (shouldSkipOnRegex(lastPartText, prompt["injection.skipOnRegexMatch"], this.client)) continue

          this.inject(sessionID, i, this.ctxFor(prompt, i), lastPart, lastMessage.parts)
        }
      },
      event: async (input) => {
        const e = input.event as {
          type?: string
          properties?: { info?: { id?: string; parentID?: string } }
          syncEvent?: { type?: string; data?: { sessionID?: string } }
        }
        if (e.type === "session.created" || e.type === "session.updated") {
          if (e.properties?.info) this.trackSession(e.properties.info)
        } else if (e.type === "session.deleted") {
          const id = e.properties?.info?.id
          if (id) this.resetTurnCount(id)
        } else if (
          e.type === "sync" &&
          e.syncEvent?.type === "session.deleted.1" &&
          e.syncEvent.data?.sessionID
        ) {
          this.resetTurnCount(e.syncEvent.data.sessionID)
        }
      },
    }
  }
}