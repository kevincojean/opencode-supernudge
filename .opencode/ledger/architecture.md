# Architecture / Design Decisions

## 2026-08-26

### T-001: Two-flag split for subagent context nudges
T-001 (periodic autonomous nudge) initially proposed `enabled.autonomous` as a new master switch separate from `enabled.subagent`. Review surfaced that this collided semantically: `enabled.subagent` already gates the existing `experimental.chat.system.transform` injection (first-turn nudge into subagent's system prompt). Reviewer resolved: keep the existing behavior intact under `enabled.subagentSystemPromptNudge` (default `true`), add a NEW master switch `enabled.subagentAutonomousWorkNudge` (default `false`) for the periodic behavior. No compat shim - `enabled.subagent` removed entirely. The single `SubAgentMessageInjector` class handles both primary-agent (`chat.message`) and subagent (`experimental.text.complete` + `experimental.chat.messages.transform`) periodic paths, gated by `enabled.subagentAutonomousWorkNudge`.

### T-001: Position reuse for autonomous placement
The initial design added `position.autonomous` as a new key. Reviewer collapsed it onto the existing `position.subagent` - one position controls all subagent-context nudges (system.transform first turn + autonomous per turn). Reduces key count by 1 without losing expressiveness.

### Outside-in TDD: chat.message early-return trap
Step 2 (GREEN) hit a structural trap: the existing chat.message handler early-returns when both `startTexts` and `endTexts` are empty (i.e. no user-message injection). With `enabled.normalMessage=false` and only the autonomous path active, the early-return prevented the autonomous code from running. Fix: replace the early-return with a `let target = ...` + `if (!target) return` guard that always locates the target text part before any injection logic runs. Both user-message and autonomous paths then share the same target and mutate it independently.

### `incrementTurnCount` semantics: pre-increment + read
Design choice for `SubAgentMessageInjector`: `incrementTurnCount(sessionID, promptIndex)` is called BEFORE `inject(...)`. `inject` reads the post-increment value from internal state and decides whether to fire. This keeps the increment and the gating as separate atomic calls the plugin entry can order, and avoids passing the count value around.

### V1 vs V2 SDK `EventSessionDeleted` shape mismatch
The `@opencode-ai/plugin` package re-exports `Event` from `@opencode-ai/sdk` (V1). V1's `EventSessionDeleted.properties` only has `info: Session` (no top-level `sessionID`). V2 SDK adds `properties.sessionID: string`. To extract sessionID at the plugin seam, use `event.properties.info.id`. The plugin handles both shapes defensively (V1 path AND V2 sync variant `sync` + `session.deleted.1` + `data.sessionID`). Initial design assumed V2 - corrected when typecheck flagged the missing property on V1.

### Hook spread order matters when composing injector hooks
When `SubAgentMessageInjector.hooks()` returns `Partial<Hooks>`, spreading it into the returned `Hooks` object overwrites any same-named hook from the existing plugin entry. For step 7-10 the injector defined `experimental.text.complete` + `experimental.chat.messages.transform` (new keys, no collision). For step 11+ it must NOT define `experimental.session.compacting` because that handler already exists in the entry - the entry calls `subAgentInjector.resetOnCompaction(...)` directly. Same for `event` (step 13+14): injector defines it because nothing else does. Lesson: only put new hooks in `hooks()`. Modify existing hook behavior via dedicated methods called from the existing handler.

### `loadPlugin()` return-type typing: prefer `typeof mod.default`
The test helper's typed signature was `{ "chat.message"?: ...; "experimental.chat.system.transform"?: ...; "experimental.session.compacting"?: ... }`. As new hooks were added (text.complete, messages.transform, event), the type had to widen. Cleanest replacement: `Promise<typeof import("../main/index.ts")["default"]>` - lets the test directly reflect whatever the plugin entry returns, no manual type upkeep. Side effect: tests use `const hooks = await plugin(...)` then `hooks["new.hook"]!` - the type narrows correctly because `Hooks` is the actual returned type from the plugin.

### Step 3 (per-prompt isolation) passed without RED-first
The per-prompt counter array design inherently isolates counters - the test for two prompts with different intervals passed on first run. No additional fix needed. Same for step 5 (counter independence) - test passed immediately. This is the correct TDD outcome when the design is right: AC is satisfied and the test confirms it without revealing implementation gaps.

### E2E AC10: subagent multi-turn verification deferred - test env limitation
First AC10 attempt used `agent: "quick"` subagent prompt via `session.prompt`. Diagnostic showed `messages=0` - the subagent never actually ran. Root cause: the e2e stub LLM server returns a canned "stub response" with no tool use, and `agent: "quick"` likely doesn't exist or doesn't execute in the test opencode runtime. Existing AC3 (which uses the same setup) passes vacuously because it only asserts `messages.data !== undefined` - true even for empty array. The e2e suite has a pre-existing gap: no test actually verifies a subagent executes.

Fix path: rewrote AC10 to verify PRIMARY-agent periodic nudge via `sendMessages(["hello-one", "hello-two", "hello-three"])` in same session with `injection.subagentInterval=2`. Mirrors the unit test at step 1 (which already passes). The primary-agent path uses `chat.message` which fires per prompt and calls `subAgentInjector.incrementTurnCount` + `inject`. This validates the wiring through real opencode runtime, just for primary context.

Subagent-context autonomous nudge e2e validation deferred until either (a) a working stub LLM drives multi-turn subagent output, or (b) a real LLM is wired in ($$$ cost). Unit tests at step 7-10 still validate the hook wiring at the seam for subagent path.