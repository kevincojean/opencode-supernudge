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
      (firstOut.parts[0] as TextPart).text.startsWith("NUDGE"),
      `1st message must start with NUDGE, got: ${(firstOut.parts[0] as TextPart).text}`,
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
      (thirdOut.parts[0] as TextPart).text.startsWith("NUDGE"),
      `3rd message must start with NUDGE, got: ${(thirdOut.parts[0] as TextPart).text}`,
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
      "user-text\n\nNUDGE",
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

    assert.strictEqual(output.system[0], "NUDGE")
    assert.strictEqual(output.system[1], "existing-system")
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

    assert.strictEqual(output.context[0], "NUDGE")
    assert.strictEqual(output.context[1], "existing-context")
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
      (firstOut.parts[0] as TextPart).text.startsWith("NUDGE"),
      `1st message must start with NUDGE, got: ${(firstOut.parts[0] as TextPart).text}`,
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
      (nextOut.parts[0] as TextPart).text.startsWith("NUDGE"),
      `next message after compaction reset must start with NUDGE, got: ${(nextOut.parts[0] as TextPart).text}`,
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
      (firstOut.parts[0] as TextPart).text.startsWith("NUDGE"),
      `1st message must start with NUDGE (default alwaysOnFirst=true), got: ${(firstOut.parts[0] as TextPart).text}`,
    )

    const secondOut = {
      message: emptyMessage(),
      parts: [emptyTextPart("hello-2")],
    }
    await hooksWithPrompt["chat.message"]!({ sessionID: "s1" }, secondOut)
    assert.ok(
      (secondOut.parts[0] as TextPart).text.startsWith("NUDGE"),
      `2nd message must start with NUDGE (default interval=1 means always inject), got: ${(secondOut.parts[0] as TextPart).text}`,
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
      "NUDGE1\n\nNUDGE2\n\nhello",
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
        "NUDGE\n\nhello",
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
      (firstOut.parts[0] as TextPart).text.startsWith("NUDGE"),
      `1st message must start with NUDGE, got: ${(firstOut.parts[0] as TextPart).text}`,
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
