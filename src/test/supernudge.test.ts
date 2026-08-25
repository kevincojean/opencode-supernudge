import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import type { PluginInput } from "@opencode-ai/plugin"
import type { Model, Project, UserMessage, Part, TextPart } from "@opencode-ai/sdk"

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "supernudge-"))
}

function writePrompt(dir: string, name: string, content: string): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, content, "utf-8")
  return p
}

function writeJsonc(filePath: string, jsonc: string): void {
  fs.writeFileSync(filePath, jsonc, "utf-8")
}

function createTempConfig(jsonc: string): string {
  const dir = mkTmp()
  const p = path.join(dir, "supernudge-configuration.jsonc")
  writeJsonc(p, jsonc)
  return p
}

function createTempPrompts(content: string): string {
  const dir = mkTmp()
  return writePrompt(dir, "nudge.txt", content)
}

function writeConfigFile(obj: Record<string, unknown>, comments = true): string {
  const json = JSON.stringify(obj, null, 2)
  if (!comments) return createTempConfig(json)
  const jsonc = "// SuperNudge test config\n" + json.replace(/,(\s*[}\]])/g, "$1")
  return createTempConfig(jsonc)
}

function stubInput(): PluginInput {
  return {
    client: {} as unknown as PluginInput["client"],
    project: {} as Project,
    directory: "/tmp",
    worktree: "/tmp",
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://localhost:0"),
    $: {} as unknown as PluginInput["$"],
  }
}

function emptyMessage(): UserMessage {
  return {
    id: "m1",
    sessionID: "s1",
    role: "user",
    time: { created: 0 },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
  }
}

function emptyTextPart(text: string): TextPart {
  return { type: "text", text } as TextPart
}

function stubModel(): Model {
  return {} as unknown as Model
}

async function loadPlugin(): Promise<(input: PluginInput, options?: { configPath?: string }) => Promise<{ "chat.message"?: (input: { sessionID: string }, output: { message: UserMessage; parts: Part[] }) => Promise<void>; "experimental.chat.system.transform"?: (input: { sessionID?: string; model: Model }, output: { system: string[] }) => Promise<void>; "experimental.session.compacting"?: (input: { sessionID: string }, output: { context: string[]; prompt?: string }) => Promise<void> }>> {
  const mod = await import("../main/index.ts")
  return mod.default
}

test(
  "given config with interval=2 and alwaysOnFirstMessage=true and prompt containing NUDGE, when user sends 3 messages, then 1st has NUDGE prepended, 2nd has no nudge, 3rd has NUDGE prepended",
  async () => {
    const promptPath = createTempPrompts("NUDGE")
    const configPath = writeConfigFile({
      prompts: [promptPath],
      "injection.interval": 2,
      "injection.alwaysOnFirstMessage": true,
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const firstOut = {
      message: emptyMessage(),
      parts: [emptyTextPart("hello-1")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, firstOut)
    assert.ok(
      (firstOut.parts[0] as TextPart).text.includes("NUDGE"),
      `1st message must include NUDGE, got: ${(firstOut.parts[0] as TextPart).text}`,
    )

    const secondOut = {
      message: emptyMessage(),
      parts: [emptyTextPart("hello-2")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, secondOut)
    assert.ok(
      !secondOut.parts.some((p) => p.type === "text" && (p as TextPart).text.includes("NUDGE")),
      "2nd message must NOT contain NUDGE",
    )

    const thirdOut = {
      message: emptyMessage(),
      parts: [emptyTextPart("hello-3")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, thirdOut)
    assert.ok(
      (thirdOut.parts[0] as TextPart).text.includes("NUDGE"),
      `3rd message must include NUDGE, got: ${(thirdOut.parts[0] as TextPart).text}`,
    )
  },
)

test(
  "given config with position.normalMessage=end and prompt containing NUDGE, when message triggers injection, then NUDGE appears after user text",
  async () => {
    const promptPath = createTempPrompts("NUDGE")
    const configPath = writeConfigFile({
      prompts: [promptPath],
      "position.normalMessage": "end",
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = {
      message: emptyMessage(),
      parts: [emptyTextPart("user-text")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, output)

    assert.strictEqual(output.parts.length, 1)
    assert.strictEqual(
      (output.parts[0] as TextPart).text,
      "user-text\n\n<opencode-supernudge>\n[nudge] NUDGE\n</opencode-supernudge>",
    )
  },
)

test(
  "given config with enabled.subagent=true and prompt containing NUDGE, when system.transform fires without sessionID, then NUDGE at start of system array",
  async () => {
    const promptPath = createTempPrompts("NUDGE")
    const configPath = writeConfigFile({
      prompts: [promptPath],
      "enabled.subagent": true,
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = { system: ["existing-system"] }
    await hooks["experimental.chat.system.transform"]!(
      { model: stubModel() },
      output,
    )

    assert.strictEqual(output.system[0], "<opencode-supernudge>")
    assert.strictEqual(output.system[1], "[nudge] NUDGE")
    assert.strictEqual(output.system[2], "</opencode-supernudge>")
    assert.strictEqual(output.system[3], "existing-system")
  },
)

test(
  "given config with enabled.subagent=true, when system.transform fires with sessionID, then system array does NOT contain NUDGE",
  async () => {
    const promptPath = createTempPrompts("NUDGE")
    const configPath = writeConfigFile({
      prompts: [promptPath],
      "enabled.subagent": true,
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = { system: ["existing-system"] }
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: "s1", model: stubModel() },
      output,
    )

    assert.deepStrictEqual(output.system, ["existing-system"])
  },
)

test(
  "given config with enabled.compaction=true and prompt containing NUDGE, when session.compacting fires, then NUDGE at start of context array",
  async () => {
    const promptPath = createTempPrompts("NUDGE")
    const configPath = writeConfigFile({
      prompts: [promptPath],
      "enabled.compaction": true,
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = { context: ["existing-context"] }
    await hooks["experimental.session.compacting"]!(
      { sessionID: "s1" },
      output,
    )

    assert.strictEqual(output.context[0], "<opencode-supernudge>")
    assert.strictEqual(output.context[1], "[nudge] NUDGE")
    assert.strictEqual(output.context[2], "</opencode-supernudge>")
    assert.strictEqual(output.context[3], "existing-context")
  },
)

test(
  "given config with enabled.normalMessage=false and prompt containing NUDGE, when chat.message fires, then message does NOT contain NUDGE",
  async () => {
    const promptPath = createTempPrompts("NUDGE")
    const configPath = writeConfigFile({
      prompts: [promptPath],
      "enabled.normalMessage": false,
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = {
      message: emptyMessage(),
      parts: [emptyTextPart("hello")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, output)

    assert.strictEqual(output.parts.length, 1)
    assert.strictEqual(
      (output.parts[0] as TextPart).text,
      "hello",
    )
  },
)

test(
  "given config with interval=10 and resetCounterOnCompaction=true and prompt containing NUDGE, when 1st message injects then compaction fires then next message fires, then next message has NUDGE injected",
  async () => {
    const promptPath = createTempPrompts("NUDGE")
    const configPath = writeConfigFile({
      prompts: [promptPath],
      "injection.interval": 10,
      "injection.alwaysOnFirstMessage": true,
      "injection.resetCounterOnCompaction": true,
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const firstOut = {
      message: emptyMessage(),
      parts: [emptyTextPart("hello-1")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, firstOut)
    assert.ok(
      (firstOut.parts[0] as TextPart).text.includes("NUDGE"),
      `1st message must include NUDGE, got: ${(firstOut.parts[0] as TextPart).text}`,
    )

    await hooks["experimental.session.compacting"]!(
      { sessionID: "s1" },
      { context: [] },
    )

    const nextOut = {
      message: emptyMessage(),
      parts: [emptyTextPart("hello-2")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, nextOut)
    assert.ok(
      (nextOut.parts[0] as TextPart).text.includes("NUDGE"),
      `next message after compaction reset must include NUDGE, got: ${(nextOut.parts[0] as TextPart).text}`,
    )
  },
)

test(
  "given no config file exists, when plugin function is called, then hooks registered and chat.message injects with defaults (interval=1, alwaysOnFirst=true)",
  async () => {
    const nonexistent = path.join(mkTmp(), "does-not-exist.jsonc")
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath: nonexistent })

    assert.ok(hooks["chat.message"], "chat.message hook must be registered")
    assert.ok(
      hooks["experimental.chat.system.transform"],
      "system.transform hook must be registered",
    )
    assert.ok(
      hooks["experimental.session.compacting"],
      "session.compacting hook must be registered",
    )

    const promptPath = createTempPrompts("NUDGE")
    const configWithPrompt = writeConfigFile({
      prompts: [promptPath],
    })
    const pluginWithPrompt = await loadPlugin()
    const hooksWithPrompt = await pluginWithPrompt(stubInput(), {
      configPath: configWithPrompt,
    })

    const firstOut = {
      message: emptyMessage(),
      parts: [emptyTextPart("hello-1")],
    }
    await hooksWithPrompt["chat.message"]!({ sessionID: "s1" }, firstOut)
    assert.ok(
      (firstOut.parts[0] as TextPart).text.includes("NUDGE"),
      `1st message must include NUDGE (default alwaysOnFirst=true), got: ${(firstOut.parts[0] as TextPart).text}`,
    )

    const secondOut = {
      message: emptyMessage(),
      parts: [emptyTextPart("hello-2")],
    }
    await hooksWithPrompt["chat.message"]!({ sessionID: "s1" }, secondOut)
    assert.ok(
      (secondOut.parts[0] as TextPart).text.includes("NUDGE"),
      `2nd message must include NUDGE (default interval=1 means always inject), got: ${(secondOut.parts[0] as TextPart).text}`,
    )
  },
)

test(
  "given config with prompt path to nonexistent file, when chat.message fires, then no nudge injected and no crash",
  async () => {
    const dir = mkTmp()
    const missingPath = path.join(dir, "missing.txt")
    const configPath = writeConfigFile({
      prompts: [missingPath],
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = {
      message: emptyMessage(),
      parts: [emptyTextPart("hello")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, output)

    assert.strictEqual(output.parts.length, 1)
    assert.strictEqual(
      (output.parts[0] as TextPart).text,
      "hello",
    )
  },
)

test(
  "given config with two prompt files containing NUDGE1 and NUDGE2, when chat.message fires and injection triggers, then injected text is NUDGE1 newline newline NUDGE2",
  async () => {
    const dir = mkTmp()
    const p1 = writePrompt(dir, "nudge1.txt", "NUDGE1")
    const p2 = writePrompt(dir, "nudge2.txt", "NUDGE2")
    const configPath = writeConfigFile({
      prompts: [p1, p2],
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = {
      message: emptyMessage(),
      parts: [emptyTextPart("hello")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, output)

    assert.strictEqual(output.parts.length, 1)
    assert.strictEqual(
      (output.parts[0] as TextPart).text,
      "<opencode-supernudge>\n[nudge1] NUDGE1\n\n[nudge2] NUDGE2\n</opencode-supernudge>\n\nhello",
    )
  },
)

test(
  "given config with prompt path using tilde and file at $HOME/prompts/nudge.txt containing NUDGE, when plugin loads and chat.message fires, then NUDGE is injected",
  async () => {
    const dir = mkTmp()
    const promptsDir = path.join(dir, "prompts")
    fs.mkdirSync(promptsDir, { recursive: true })
    fs.writeFileSync(path.join(promptsDir, "nudge.txt"), "NUDGE", "utf-8")

    const originalHome = process.env.HOME
    process.env.HOME = dir
    try {
      const configPath = writeConfigFile({
        prompts: ["~/prompts/nudge.txt"],
      })
      const plugin = await loadPlugin()
      const hooks = await plugin(stubInput(), { configPath })

      const output = {
        message: emptyMessage(),
        parts: [emptyTextPart("hello")],
      }
      await hooks["chat.message"]!({ sessionID: "s1" }, output)

      assert.strictEqual(output.parts.length, 1)
      assert.strictEqual(
        (output.parts[0] as TextPart).text,
        "<opencode-supernudge>\n[nudge] NUDGE\n</opencode-supernudge>\n\nhello",
      )
    } finally {
      process.env.HOME = originalHome
    }
  },
)

test(
  "given config file with JSONC comments and trailing commas, when plugin loads config, then values parsed correctly and injection works",
  async () => {
    const promptPath = createTempPrompts("NUDGE")
    const jsonc = `// SuperNudge configuration
{
  "prompts": ["${promptPath}",],
  "injection.interval": 2,
  "injection.alwaysOnFirstMessage": true,
  /* position default start */
  "enabled.normalMessage": true,
}`
    const configPath = createTempConfig(jsonc)
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const firstOut = {
      message: emptyMessage(),
      parts: [emptyTextPart("hello-1")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, firstOut)
    assert.ok(
      (firstOut.parts[0] as TextPart).text.includes("NUDGE"),
      `1st message must include NUDGE, got: ${(firstOut.parts[0] as TextPart).text}`,
    )

    const secondOut = {
      message: emptyMessage(),
      parts: [emptyTextPart("hello-2")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, secondOut)
    assert.ok(
      !secondOut.parts.some((p) => p.type === "text" && (p as TextPart).text.includes("NUDGE")),
      "2nd message must NOT contain NUDGE (interval=2, alwaysOnFirst only)",
    )
  },
)

test(
  "given config with enabled.compaction=false, when session.compacting fires, then context does NOT contain nudge text",
  async () => {
    const promptPath = createTempPrompts("NUDGE")
    const configPath = writeConfigFile({
      prompts: [promptPath],
      "enabled.compaction": false,
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = { context: ["existing-context"] }
    await hooks["experimental.session.compacting"]!(
      { sessionID: "s1" },
      output,
    )

    assert.deepStrictEqual(output.context, ["existing-context"])
  },
)

test(
  "given config with two prompts having interval=1 and interval=2, when 3 messages sent, then prompt A injected on all 3, prompt B injected on 1st and 3rd only",
  async () => {
    const dir = mkTmp()
    const pA = writePrompt(dir, "nudge_a.txt", "NUDGE_A")
    const pB = writePrompt(dir, "nudge_b.txt", "NUDGE_B")
    const configPath = writeConfigFile({
      prompts: [
        { path: pA, "injection.interval": 1 },
        { path: pB, "injection.interval": 2 },
      ],
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const out1 = { message: emptyMessage(), parts: [emptyTextPart("msg-1")] }
    await hooks["chat.message"]!({ sessionID: "s1" }, out1)
    assert.ok((out1.parts[0] as TextPart).text.includes("NUDGE_A"), "1st: NUDGE_A present")
    assert.ok((out1.parts[0] as TextPart).text.includes("NUDGE_B"), "1st: NUDGE_B present")

    const out2 = { message: emptyMessage(), parts: [emptyTextPart("msg-2")] }
    await hooks["chat.message"]!({ sessionID: "s1" }, out2)
    assert.ok((out2.parts[0] as TextPart).text.includes("NUDGE_A"), "2nd: NUDGE_A present")
    assert.ok(!(out2.parts[0] as TextPart).text.includes("NUDGE_B"), "2nd: NUDGE_B absent")

    const out3 = { message: emptyMessage(), parts: [emptyTextPart("msg-3")] }
    await hooks["chat.message"]!({ sessionID: "s1" }, out3)
    assert.ok((out3.parts[0] as TextPart).text.includes("NUDGE_A"), "3rd: NUDGE_A present")
    assert.ok((out3.parts[0] as TextPart).text.includes("NUDGE_B"), "3rd: NUDGE_B present")
  },
)

test(
  "given config with mixed string and object prompts and global interval=3, when 3 messages sent, then string prompt injects on 1st and 3rd, object prompt with interval=1 injects on all 3",
  async () => {
    const dir = mkTmp()
    const pA = writePrompt(dir, "nudge_a.txt", "NUDGE_A")
    const pB = writePrompt(dir, "nudge_b.txt", "NUDGE_B")
    const configPath = writeConfigFile({
      prompts: [pA, { path: pB, "injection.interval": 1 }],
      "injection.interval": 3,
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const out1 = { message: emptyMessage(), parts: [emptyTextPart("msg-1")] }
    await hooks["chat.message"]!({ sessionID: "s1" }, out1)
    assert.ok((out1.parts[0] as TextPart).text.includes("NUDGE_A"), "1st: NUDGE_A present")
    assert.ok((out1.parts[0] as TextPart).text.includes("NUDGE_B"), "1st: NUDGE_B present")

    const out2 = { message: emptyMessage(), parts: [emptyTextPart("msg-2")] }
    await hooks["chat.message"]!({ sessionID: "s1" }, out2)
    assert.ok(!(out2.parts[0] as TextPart).text.includes("NUDGE_A"), "2nd: NUDGE_A absent (interval=3)")
    assert.ok((out2.parts[0] as TextPart).text.includes("NUDGE_B"), "2nd: NUDGE_B present (interval=1)")

    const out3 = { message: emptyMessage(), parts: [emptyTextPart("msg-3")] }
    await hooks["chat.message"]!({ sessionID: "s1" }, out3)
    assert.ok(!(out3.parts[0] as TextPart).text.includes("NUDGE_A"), "3rd: NUDGE_A absent (interval=3, next at 4th)")
    assert.ok((out3.parts[0] as TextPart).text.includes("NUDGE_B"), "3rd: NUDGE_B present (interval=1)")
  },
)

test(
  "given config with per-prompt alwaysOnFirstMessage=false and interval=5, when 1st message sent, then that prompt NOT injected",
  async () => {
    const promptPath = createTempPrompts("NUDGE_A")
    const configPath = writeConfigFile({
      prompts: [{ path: promptPath, "injection.interval": 5, "injection.alwaysOnFirstMessage": false }],
      "injection.alwaysOnFirstMessage": true,
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const out = { message: emptyMessage(), parts: [emptyTextPart("hello")] }
    await hooks["chat.message"]!({ sessionID: "s1" }, out)
    assert.ok(!(out.parts[0] as TextPart).text.includes("NUDGE_A"), "1st: NUDGE_A absent (alwaysOnFirst=false)")
  },
)

test(
  "given config with per-prompt enabled.normalMessage=false, when chat.message fires, then that prompt NOT injected but other prompts still inject",
  async () => {
    const dir = mkTmp()
    const pA = writePrompt(dir, "nudge_a.txt", "NUDGE_A")
    const pB = writePrompt(dir, "nudge_b.txt", "NUDGE_B")
    const configPath = writeConfigFile({
      prompts: [pA, { path: pB, "enabled.normalMessage": false }],
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const out = { message: emptyMessage(), parts: [emptyTextPart("hello")] }
    await hooks["chat.message"]!({ sessionID: "s1" }, out)
    assert.ok((out.parts[0] as TextPart).text.includes("NUDGE_A"), "NUDGE_A present (default enabled)")
    assert.ok(!(out.parts[0] as TextPart).text.includes("NUDGE_B"), "NUDGE_B absent (enabled.normalMessage=false)")
  },
)

test(
  "given config with per-prompt position.normalMessage=end, when chat.message fires, then that prompt appended at end while others at start",
  async () => {
    const dir = mkTmp()
    const pA = writePrompt(dir, "nudge_a.txt", "NUDGE_A")
    const pB = writePrompt(dir, "nudge_b.txt", "NUDGE_B")
    const configPath = writeConfigFile({
      prompts: [pA, { path: pB, "position.normalMessage": "end" }],
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const out = { message: emptyMessage(), parts: [emptyTextPart("hello")] }
    await hooks["chat.message"]!({ sessionID: "s1" }, out)
    const text = (out.parts[0] as TextPart).text
    assert.ok(text.indexOf("NUDGE_A") < text.indexOf("hello"), "NUDGE_A before user text (start)")
    assert.ok(text.indexOf("hello") < text.indexOf("NUDGE_B"), "NUDGE_B after user text (end)")
  },
)

test(
  "given config with per-prompt enabled.subagent=false, when system.transform fires, then that prompt NOT in system array but others still injected",
  async () => {
    const dir = mkTmp()
    const pA = writePrompt(dir, "nudge_a.txt", "NUDGE_A")
    const pB = writePrompt(dir, "nudge_b.txt", "NUDGE_B")
    const configPath = writeConfigFile({
      prompts: [pA, { path: pB, "enabled.subagent": false }],
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = { system: ["existing"] }
    await hooks["experimental.chat.system.transform"]!(
      { model: stubModel() },
      output,
    )
    assert.ok(output.system.some(s => s.includes("NUDGE_A")), "NUDGE_A in system (default enabled)")
    assert.ok(!output.system.some(s => s.includes("NUDGE_B")), "NUDGE_B NOT in system (enabled.subagent=false)")
  },
)

test(
  "given config with per-prompt enabled.compaction=false, when session.compacting fires, then that prompt NOT in context array but others still injected",
  async () => {
    const dir = mkTmp()
    const pA = writePrompt(dir, "nudge_a.txt", "NUDGE_A")
    const pB = writePrompt(dir, "nudge_b.txt", "NUDGE_B")
    const configPath = writeConfigFile({
      prompts: [pA, { path: pB, "enabled.compaction": false }],
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = { context: ["existing"] }
    await hooks["experimental.session.compacting"]!(
      { sessionID: "s1" },
      output,
    )
    assert.ok(output.context.some(c => c.includes("NUDGE_A")), "NUDGE_A in context (default enabled)")
    assert.ok(!output.context.some(c => c.includes("NUDGE_B")), "NUDGE_B NOT in context (enabled.compaction=false)")
  },
)

test(
  "given config with per-prompt resetCounterOnCompaction=false and interval=3, when 1st message injects then compaction fires then 2nd message sent, then that prompt does NOT inject on 2nd message",
  async () => {
    const promptPath = createTempPrompts("NUDGE_A")
    const configPath = writeConfigFile({
      prompts: [{ path: promptPath, "injection.interval": 3, "injection.resetCounterOnCompaction": false }],
      "injection.alwaysOnFirstMessage": true,
      "injection.resetCounterOnCompaction": true,
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const out1 = { message: emptyMessage(), parts: [emptyTextPart("msg-1")] }
    await hooks["chat.message"]!({ sessionID: "s1" }, out1)
    assert.ok((out1.parts[0] as TextPart).text.includes("NUDGE_A"), "1st: NUDGE_A present (alwaysOnFirst)")

    await hooks["experimental.session.compacting"]!(
      { sessionID: "s1" },
      { context: [] },
    )

    const out2 = { message: emptyMessage(), parts: [emptyTextPart("msg-2")] }
    await hooks["chat.message"]!({ sessionID: "s1" }, out2)
    assert.ok(!(out2.parts[0] as TextPart).text.includes("NUDGE_A"), "2nd: NUDGE_A absent (counter not reset, count=2, interval=3)")
  },
)

test(
  "given default config with one prompt containing NUDGE, when chat.message fires, then injected nudge is wrapped in <opencode-supernudge> prefix and </opencode-supernudge> suffix",
  async () => {
    const promptPath = createTempPrompts("NUDGE")
    const configPath = writeConfigFile({ prompts: [promptPath] })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = {
      message: emptyMessage(),
      parts: [emptyTextPart("hello")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, output)

    const text = (output.parts[0] as TextPart).text
    assert.ok(
      text.startsWith("<opencode-supernudge>\n[nudge] NUDGE\n</opencode-supernudge>"),
      `nudge block must be wrapped with default markers. Got: ${text}`,
    )
    assert.ok(
      text.endsWith("hello"),
      `user text must follow after wrapper. Got: ${text}`,
    )
  },
)

test(
  "given config with wrapper.prefix='[START]' and wrapper.suffix='[END]' and one prompt containing NUDGE, when chat.message fires, then injected nudge wrapped with custom markers",
  async () => {
    const promptPath = createTempPrompts("NUDGE")
    const configPath = writeConfigFile({
      prompts: [promptPath],
      "wrapper.prefix": "[START]",
      "wrapper.suffix": "[END]",
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = {
      message: emptyMessage(),
      parts: [emptyTextPart("hello")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, output)

    const text = (output.parts[0] as TextPart).text
    assert.ok(
      text.startsWith("[START]\n[nudge] NUDGE\n[END]"),
      `nudge block must be wrapped with custom markers. Got: ${text}`,
    )
    assert.ok(!text.includes("<opencode-supernudge>"), "default markers must NOT appear when custom set")
  },
)

test(
  "given config with two prompts and position.normalMessage=start, when chat.message fires, then both nudges inside single wrapper block at start",
  async () => {
    const dir = mkTmp()
    const p1 = writePrompt(dir, "nudge1.txt", "NUDGE1")
    const p2 = writePrompt(dir, "nudge2.txt", "NUDGE2")
    const configPath = writeConfigFile({ prompts: [p1, p2] })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = {
      message: emptyMessage(),
      parts: [emptyTextPart("hello")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, output)

    const text = (output.parts[0] as TextPart).text
    const startIdx = text.indexOf("<opencode-supernudge>")
    const endIdx = text.indexOf("</opencode-supernudge>")
    assert.ok(startIdx === 0, `prefix must be at position 0. Got idx: ${startIdx}`)
    assert.ok(endIdx > startIdx, `suffix must come after prefix`)
    assert.ok(
      text.indexOf("NUDGE1") > startIdx && text.indexOf("NUDGE2") > startIdx,
      "both nudges must be inside wrapper",
    )
    assert.ok(
      text.indexOf("NUDGE1") < endIdx && text.indexOf("NUDGE2") < endIdx,
      "both nudges must be before suffix",
    )
    assert.strictEqual(text.split("<opencode-supernudge>").length - 1, 1, "exactly one prefix")
    assert.strictEqual(text.split("</opencode-supernudge>").length - 1, 1, "exactly one suffix")
  },
)

test(
  "given config with position.normalMessage=end, when chat.message fires, then nudge at end wrapped in markers after user text",
  async () => {
    const promptPath = createTempPrompts("NUDGE")
    const configPath = writeConfigFile({
      prompts: [promptPath],
      "position.normalMessage": "end",
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = {
      message: emptyMessage(),
      parts: [emptyTextPart("user-text")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, output)

    const text = (output.parts[0] as TextPart).text
    assert.ok(
      text.startsWith("user-text"),
      `user text must come first. Got: ${text}`,
    )
    assert.ok(
      text.endsWith("<opencode-supernudge>\n[nudge] NUDGE\n</opencode-supernudge>"),
      `nudge at end must be wrapped. Got: ${text}`,
    )
  },
)

test(
  "given config with two prompts one at start one at end, when chat.message fires, then each nudge block wrapped separately",
  async () => {
    const dir = mkTmp()
    const pA = writePrompt(dir, "nudge_a.txt", "NUDGE_A")
    const pB = writePrompt(dir, "nudge_b.txt", "NUDGE_B")
    const configPath = writeConfigFile({
      prompts: [pA, { path: pB, "position.normalMessage": "end" }],
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = {
      message: emptyMessage(),
      parts: [emptyTextPart("hello")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, output)

    const text = (output.parts[0] as TextPart).text
    assert.ok(text.startsWith("<opencode-supernudge>\n[nudge_a] NUDGE_A\n</opencode-supernudge>"), `start nudge wrapped. Got: ${text}`)
    assert.ok(text.endsWith("<opencode-supernudge>\n[nudge_b] NUDGE_B\n</opencode-supernudge>"), `end nudge wrapped. Got: ${text}`)
    assert.strictEqual(text.split("<opencode-supernudge>").length - 1, 2, "two prefix markers (start + end blocks)")
    assert.strictEqual(text.split("</opencode-supernudge>").length - 1, 2, "two suffix markers (start + end blocks)")
  },
)

test(
  "given default config with one prompt, when system.transform fires, then system array has prefix and suffix around nudge at start",
  async () => {
    const promptPath = createTempPrompts("NUDGE")
    const configPath = writeConfigFile({ prompts: [promptPath] })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = { system: ["existing-system"] }
    await hooks["experimental.chat.system.transform"]!(
      { model: stubModel() },
      output,
    )

    assert.strictEqual(output.system[0], "<opencode-supernudge>", "first element must be prefix marker")
    assert.strictEqual(output.system[1], "[nudge] NUDGE", "nudge content after prefix")
    assert.strictEqual(output.system[2], "</opencode-supernudge>", "suffix marker after nudge")
    assert.strictEqual(output.system[3], "existing-system", "existing system after wrapper")
  },
)

test(
  "given config with position.subagent=end, when system.transform fires, then system array has prefix and suffix around nudge at end",
  async () => {
    const promptPath = createTempPrompts("NUDGE")
    const configPath = writeConfigFile({
      prompts: [promptPath],
      "position.subagent": "end",
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = { system: ["existing-system"] }
    await hooks["experimental.chat.system.transform"]!(
      { model: stubModel() },
      output,
    )

    assert.strictEqual(output.system[0], "existing-system", "existing system first")
    assert.strictEqual(output.system[1], "<opencode-supernudge>", "prefix marker before end nudge")
    assert.strictEqual(output.system[2], "[nudge] NUDGE", "nudge content")
    assert.strictEqual(output.system[3], "</opencode-supernudge>", "suffix marker after nudge")
  },
)

test(
  "given default config with one prompt, when session.compacting fires, then context array has prefix and suffix around nudge at start",
  async () => {
    const promptPath = createTempPrompts("NUDGE")
    const configPath = writeConfigFile({ prompts: [promptPath] })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = { context: ["existing-context"] }
    await hooks["experimental.session.compacting"]!(
      { sessionID: "s1" },
      output,
    )

    assert.strictEqual(output.context[0], "<opencode-supernudge>", "first element must be prefix marker")
    assert.strictEqual(output.context[1], "[nudge] NUDGE", "nudge content after prefix")
    assert.strictEqual(output.context[2], "</opencode-supernudge>", "suffix marker after nudge")
    assert.strictEqual(output.context[3], "existing-context", "existing context after wrapper")
  },
)

test(
  "given config with wrapper.prefix='' and wrapper.suffix='', when chat.message fires, then no markers injected around nudge",
  async () => {
    const promptPath = createTempPrompts("NUDGE")
    const configPath = writeConfigFile({
      prompts: [promptPath],
      "wrapper.prefix": "",
      "wrapper.suffix": "",
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = {
      message: emptyMessage(),
      parts: [emptyTextPart("hello")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, output)

    const text = (output.parts[0] as TextPart).text
    assert.strictEqual(text, "[nudge] NUDGE\n\nhello", `empty markers = no wrapper. Got: ${text}`)
    assert.ok(!text.includes("<opencode-supernudge>"), "default markers must NOT appear")
  },
)

test(
  "given config with nudge.separator='---' and two prompts at start, when chat.message fires, then nudges joined by custom separator inside wrapper",
  async () => {
    const dir = mkTmp()
    const p1 = writePrompt(dir, "nudge1.txt", "NUDGE1")
    const p2 = writePrompt(dir, "nudge2.txt", "NUDGE2")
    const configPath = writeConfigFile({
      prompts: [p1, p2],
      "nudge.separator": "---",
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = {
      message: emptyMessage(),
      parts: [emptyTextPart("hello")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, output)

    const text = (output.parts[0] as TextPart).text
    assert.strictEqual(
      text,
      "<opencode-supernudge>\n[nudge1] NUDGE1---[nudge2] NUDGE2\n</opencode-supernudge>\n\nhello",
      `nudges must be joined by custom separator. Got: ${text}`,
    )
  },
)

test(
  "given default config with prompt file named tdd.md containing NUDGE_CONTENT, when chat.message fires, then nudge content prefixed with [tdd]",
  async () => {
    const dir = mkTmp()
    const p = writePrompt(dir, "tdd.md", "NUDGE_CONTENT")
    const configPath = writeConfigFile({ prompts: [p] })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = {
      message: emptyMessage(),
      parts: [emptyTextPart("hello")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, output)

    const text = (output.parts[0] as TextPart).text
    assert.strictEqual(
      text,
      "<opencode-supernudge>\n[tdd] NUDGE_CONTENT\n</opencode-supernudge>\n\nhello",
      `nudge must be prefixed with [tdd] (filename without ext, lowercased). Got: ${text}`,
    )
  },
)

test(
  "given config with nudge.enableTitlePrefix=false and prompt file named tdd.md containing NUDGE, when chat.message fires, then nudge content has NO title prefix",
  async () => {
    const dir = mkTmp()
    const p = writePrompt(dir, "tdd.md", "NUDGE")
    const configPath = writeConfigFile({
      prompts: [p],
      "nudge.enableTitlePrefix": false,
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = {
      message: emptyMessage(),
      parts: [emptyTextPart("hello")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, output)

    const text = (output.parts[0] as TextPart).text
    assert.ok(!text.includes("[tdd]"), `title prefix must NOT appear when nudge.enableTitlePrefix=false. Got: ${text}`)
    assert.strictEqual(
      text,
      "<opencode-supernudge>\nNUDGE\n</opencode-supernudge>\n\nhello",
      `nudge content without title prefix. Got: ${text}`,
    )
  },
)

test(
  "given default config and prompt file with leading/trailing newlines and spaces around NUDGE, when chat.message fires, then nudge content trimmed of leading/trailing whitespace",
  async () => {
    const promptPath = createTempPrompts("\n\n  NUDGE  \n\n")
    const configPath = writeConfigFile({ prompts: [promptPath] })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = {
      message: emptyMessage(),
      parts: [emptyTextPart("hello")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, output)

    const text = (output.parts[0] as TextPart).text
    assert.strictEqual(
      text,
      "<opencode-supernudge>\n[nudge] NUDGE\n</opencode-supernudge>\n\nhello",
      `nudge content must be trimmed (default nudge.trim=true). Got: ${text}`,
    )
  },
)

test(
  "given config with nudge.trim=false and prompt file with leading/trailing newlines around NUDGE, when chat.message fires, then nudge content NOT trimmed",
  async () => {
    const promptPath = createTempPrompts("\n\nNUDGE\n\n")
    const configPath = writeConfigFile({
      prompts: [promptPath],
      "nudge.trim": false,
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = {
      message: emptyMessage(),
      parts: [emptyTextPart("hello")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, output)

    const text = (output.parts[0] as TextPart).text
    assert.strictEqual(
      text,
      "<opencode-supernudge>\n[nudge] \n\nNUDGE\n\n\n</opencode-supernudge>\n\nhello",
      `nudge content must NOT be trimmed (nudge.trim=false). Got: ${text}`,
    )
  },
)

test(
  "given config with per-prompt nudge.trim=false and global nudge.trim=true, when chat.message fires, then that prompt NOT trimmed but others trimmed",
  async () => {
    const dir = mkTmp()
    const pA = writePrompt(dir, "nudge_a.txt", "\n\nNUDGE_A\n\n")
    const pB = writePrompt(dir, "nudge_b.txt", "\n\nNUDGE_B\n\n")
    const configPath = writeConfigFile({
      prompts: [pA, { path: pB, "nudge.trim": false }],
      "nudge.trim": true,
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = {
      message: emptyMessage(),
      parts: [emptyTextPart("hello")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, output)

    const text = (output.parts[0] as TextPart).text
    assert.ok(
      text.includes("[nudge_a] NUDGE_A"),
      `NUDGE_A must be trimmed. Got: ${text}`,
    )
    assert.ok(
      text.includes("[nudge_b] \n\nNUDGE_B\n\n"),
      `NUDGE_B must NOT be trimmed (per-prompt nudge.trim=false). Got: ${text}`,
    )
  },
)

test(
  "given default config and prompt file with leading/trailing newlines, when system.transform fires, then nudge content trimmed",
  async () => {
    const promptPath = createTempPrompts("\n\n  NUDGE  \n\n")
    const configPath = writeConfigFile({ prompts: [promptPath] })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = { system: ["existing-system"] }
    await hooks["experimental.chat.system.transform"]!(
      { model: stubModel() },
      output,
    )

    assert.strictEqual(output.system[1], "[nudge] NUDGE", `system nudge must be trimmed. Got: ${output.system[1]}`)
  },
)

test(
  "given default config and prompt file with leading/trailing newlines, when session.compacting fires, then nudge content trimmed",
  async () => {
    const promptPath = createTempPrompts("\n\n  NUDGE  \n\n")
    const configPath = writeConfigFile({ prompts: [promptPath] })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = { context: ["existing-context"] }
    await hooks["experimental.session.compacting"]!(
      { sessionID: "s1" },
      output,
    )

    assert.strictEqual(output.context[1], "[nudge] NUDGE", `compaction nudge must be trimmed. Got: ${output.context[1]}`)
  },
)

test(
  "given injection.skipFirstMessageBelowChars=5 and prompt containing NUDGE, when user sends short message (<= 5 chars), then message does NOT contain NUDGE",
  async () => {
    const promptPath = createTempPrompts("NUDGE")
    const configPath = writeConfigFile({
      prompts: [promptPath],
      "injection.skipFirstMessageBelowChars": 5,
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = {
      message: emptyMessage(),
      parts: [emptyTextPart("hi")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, output)

    assert.ok(
      !(output.parts[0] as TextPart).text.includes("NUDGE"),
      `short message must skip nudge. Got: ${(output.parts[0] as TextPart).text}`,
    )
  },
)

test(
  "given injection.skipFirstMessageBelowChars=5 and prompt containing NUDGE, when user sends long message (> 5 chars), then message contains NUDGE",
  async () => {
    const promptPath = createTempPrompts("NUDGE")
    const configPath = writeConfigFile({
      prompts: [promptPath],
      "injection.skipFirstMessageBelowChars": 5,
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = {
      message: emptyMessage(),
      parts: [emptyTextPart("hello world")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, output)

    assert.ok(
      (output.parts[0] as TextPart).text.includes("NUDGE"),
      `long message must contain NUDGE. Got: ${(output.parts[0] as TextPart).text}`,
    )
  },
)

test(
  "given two prompts with per-prompt injection.skipFirstMessageBelowChars overrides (0 and 20), when user sends short message, then low-threshold prompt injected and high-threshold prompt skipped",
  async () => {
    const promptA = createTempPrompts("NUDGE_A")
    const promptB = createTempPrompts("NUDGE_B")
    const configPath = writeConfigFile({
      prompts: [
        { path: promptA, "injection.skipFirstMessageBelowChars": 0 },
        { path: promptB, "injection.skipFirstMessageBelowChars": 20 },
      ],
      "injection.skipFirstMessageBelowChars": 5,
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = {
      message: emptyMessage(),
      parts: [emptyTextPart("hi")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, output)

    const text = (output.parts[0] as TextPart).text
    assert.ok(
      text.includes("NUDGE_A"),
      `low-threshold prompt must inject on short message. Got: ${text}`,
    )
    assert.ok(
      !text.includes("NUDGE_B"),
      `high-threshold prompt must skip on short message. Got: ${text}`,
    )
  },
)

test(
  "given two prompts with per-prompt injection.skipFirstMessageBelowChars overrides (0 and 20), when user sends long message, then both prompts injected",
  async () => {
    const promptA = createTempPrompts("NUDGE_A")
    const promptB = createTempPrompts("NUDGE_B")
    const configPath = writeConfigFile({
      prompts: [
        { path: promptA, "injection.skipFirstMessageBelowChars": 0 },
        { path: promptB, "injection.skipFirstMessageBelowChars": 20 },
      ],
      "injection.skipFirstMessageBelowChars": 5,
    })
    const plugin = await loadPlugin()
    const hooks = await plugin(stubInput(), { configPath })

    const output = {
      message: emptyMessage(),
      parts: [emptyTextPart("hello world this is long enough")],
    }
    await hooks["chat.message"]!({ sessionID: "s1" }, output)

    const text = (output.parts[0] as TextPart).text
    assert.ok(
      text.includes("NUDGE_A"),
      `low-threshold prompt must inject. Got: ${text}`,
    )
    assert.ok(
      text.includes("NUDGE_B"),
      `high-threshold prompt must inject on long message. Got: ${text}`,
    )
  },
)

