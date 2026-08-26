import type { Hooks } from "@opencode-ai/plugin"
import type { ResolvedAutonomousPrompt, TurnBoundMessageInjector, PromptContext, InjectResult } from "../turn-bound-injector.ts"

type TextPartTarget = { type: "text"; text: string }

function shouldInject(count: number, interval: number, alwaysOnFirst: boolean): boolean {
  if (interval <= 1) return true
  if (count === 1) return alwaysOnFirst
  return (count - 1) % interval === 0
}

export class SubAgentMessageInjector implements TurnBoundMessageInjector {
  private counters = new Map<string, number[]>()
  private resolvePrompts: () => ResolvedAutonomousPrompt[]

  constructor(resolvePrompts: () => ResolvedAutonomousPrompt[]) {
    this.resolvePrompts = resolvePrompts
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
  ): InjectResult {
    if (!ctx.enabled) return undefined
    const count = this.counters.get(sessionID)?.[promptIndex] ?? 0
    if (count === 0) return undefined
    if (!shouldInject(count, ctx.interval, ctx.alwaysOnFirst)) return undefined
    const part = target as TextPartTarget
    if (!part || part.type !== "text") return undefined
    const titlePrefix = ctx.title ? `[${ctx.title}] ` : ""
    const block = titlePrefix + ctx.content
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
        for (let i = 0; i < prompts.length; i++) {
          const prompt = prompts[i]
          if (!prompt["enabled.subagentAutonomousWorkNudge"]) continue
          this.inject(sessionID, i, this.ctxFor(prompt, i), lastPart)
        }
      },
      event: async (input) => {
        const e = input.event as { type?: string; properties?: { info?: { id?: string } }; syncEvent?: { type?: string; data?: { sessionID?: string } } }
        if (e.type === "session.deleted") {
          const id = e.properties?.info?.id
          if (id) this.resetTurnCount(id)
        } else if (e.type === "sync" && e.syncEvent?.type === "session.deleted.1" && e.syncEvent.data?.sessionID) {
          this.resetTurnCount(e.syncEvent.data.sessionID)
        }
      },
    }
  }
}