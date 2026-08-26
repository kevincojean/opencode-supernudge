import type { Hooks } from "@opencode-ai/plugin"
import type { TurnBoundMessageInjector, PromptContext, InjectResult } from "../turn-bound-injector.ts"

export class SubAgentMessageInjector implements TurnBoundMessageInjector {
  incrementTurnCount(_sessionID: string, _promptIndex: number): number {
    return 0
  }

  resetTurnCount(_sessionID: string): void {}

  inject(_sessionID: string, _promptIndex: number, _ctx: PromptContext, _target: unknown): InjectResult {
    return undefined
  }

  hooks(): Partial<Hooks> {
    return {
      "experimental.text.complete": async () => {},
      "experimental.chat.messages.transform": async () => {},
      "experimental.session.compacting": async () => {},
      event: async () => {},
    }
  }
}
