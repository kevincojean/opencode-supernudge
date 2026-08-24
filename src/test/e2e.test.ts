import { describe, test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk"

const NUDGE_TEXT = "E2E_NUDGE_MARKER_12345"

function setupSandboxHome(projectDir: string): string {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "supernudge-e2e-"))
  const configDir = path.join(tmpHome, ".config", "opencode")
  const supernudgeDir = path.join(configDir, "opencode-supernudge")
  fs.mkdirSync(supernudgeDir, { recursive: true })

  const promptFile = path.join(tmpHome, "nudge.txt")
  fs.writeFileSync(promptFile, NUDGE_TEXT)

  fs.writeFileSync(
    path.join(configDir, "opencode.jsonc"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      provider: {
        proxy: {
          npm: "@ai-sdk/openai-compatible",
          name: "LLM Proxy",
          options: { baseURL: "http://localhost:8000/v1", apiKey: "12345" },
          models: { deep: { id: "mistral/deep", limit: { context: 225000, output: 64000 } } },
        },
      },
      plugin: [path.join(projectDir, "index.ts")],
    }),
  )

  fs.writeFileSync(
    path.join(supernudgeDir, "supernudge-configuration.jsonc"),
    JSON.stringify({
      prompts: [promptFile],
      "injection.interval": 1,
      "injection.alwaysOnFirstMessage": true,
      "injection.resetCounterOnCompaction": true,
      "position.normalMessage": "start",
      "position.subagent": "start",
      "position.compaction": "start",
      "enabled.normalMessage": true,
      "enabled.subagent": true,
      "enabled.compaction": true,
    }),
  )

  return tmpHome
}

function spawnBwrapServer(projectDir: string, homeDir: string, port: number): Promise<{ url: string; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bwrap", [
      "--dev-bind", "/", "/",
      "--setenv", "HOME", homeDir,
      "--chdir", projectDir,
      "opencode", "serve", `--port=${port}`, "--hostname=127.0.0.1",
    ], { stdio: ["ignore", "pipe", "pipe"] })

    let output = ""
    const timeout = setTimeout(() => {
      proc.kill()
      reject(new Error(`Server timeout after 15s. Output: ${output}`))
    }, 15000)

    proc.stdout?.on("data", (chunk) => {
      output += chunk.toString()
      const match = output.match(/listening on (https?:\/\/[^\s]+)/)
      if (match) {
        clearTimeout(timeout)
        resolve({ url: match[1], proc })
      }
    })
    proc.stderr?.on("data", (chunk) => { output += chunk.toString() })
    proc.on("exit", (code) => {
      clearTimeout(timeout)
      reject(new Error(`Server exited with code ${code}. Output: ${output}`))
    })
  })
}

describe("e2e: SuperNudge plugin via bubblewrap", () => {
  let proc: ChildProcess
  let client: OpencodeClient
  let tmpHome: string

  before(async () => {
    tmpHome = setupSandboxHome(process.cwd())
    const port = 30000 + Math.floor(Math.random() * 10000)
    const { url, proc: p } = await spawnBwrapServer(process.cwd(), tmpHome, port)
    proc = p
    client = createOpencodeClient({ baseUrl: url })
  })

  after(() => {
    proc?.kill("SIGTERM")
  })

  test("given plugin loaded with nudge config, when user sends message, then nudge text prepended to user message", async () => {
    const session = await client.session.create({
      query: { directory: process.cwd() },
    })
    const sessionID = session.data?.id
    assert.ok(sessionID, "session should have an id")

    await client.session.prompt({
      path: { id: sessionID! },
      query: { directory: process.cwd() },
      body: { parts: [{ type: "text" as const, text: "hello world" }] },
    })

    const messages = await client.session.messages({
      path: { id: sessionID! },
      query: { directory: process.cwd() },
    })

    const userMsgs = (messages.data ?? []).filter(m => m.info.role === "user")
    assert.ok(userMsgs.length > 0, "should have at least one user message")

    const allText = userMsgs
      .flatMap(m => m.parts)
      .filter(p => p.type === "text")
      .map(p => (p as { text: string }).text)
      .join("\n")

    assert.ok(
      allText.includes(NUDGE_TEXT),
      `nudge text "${NUDGE_TEXT}" should appear in user message. Got: ${allText}`,
    )
  })
})
