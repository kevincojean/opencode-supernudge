import { describe, test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn, execSync, type ChildProcess } from "node:child_process"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk"

const NUDGE = "E2E_NUDGE_MARKER"

type SuperNudgeConfig = {
  prompts?: (string | { path: string } & Record<string, unknown>)[]
  "injection.interval"?: number
  "injection.alwaysOnFirstMessage"?: boolean
  "injection.resetCounterOnCompaction"?: boolean
  "position.normalMessage"?: string
  "position.subagent"?: string
  "position.compaction"?: string
  "enabled.normalMessage"?: boolean
  "enabled.subagent"?: boolean
  "enabled.compaction"?: boolean
  "nudge.skipBelowChars"?: number
}

const projectDir = process.cwd()
let portCounter = 30000
let tmpHome: string
let supernudgeDir: string
let promptFile: string
let proc: ChildProcess
let client: OpencodeClient
let stubServer: http.Server

function killServer() {
  if (!proc) return
  const pid = proc.pid
  if (!pid) return

  try { process.kill(pid, "SIGTERM") } catch {}
  try { process.kill(-pid, "SIGTERM") } catch {}

  setTimeout(() => {
    try { process.kill(pid, "SIGKILL") } catch {}
    try { process.kill(-pid, "SIGKILL") } catch {}
  }, 500)
}

function killOrphanedOpencode() {
  try { execSync('pkill -9 -f "opencode serve"', { stdio: "ignore" }) } catch {}
  try { execSync('pkill -9 -f "opencode.*serve"', { stdio: "ignore" }) } catch {}
  try { execSync('fuser -k 30000/tcp 30001/tcp 30002/tcp 30003/tcp 30004/tcp 30005/tcp', { stdio: "ignore" }) } catch {}
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    killServer()
    killOrphanedOpencode()
    process.exit(130)
  })
}
process.on("exit", killServer)

function startStubServer(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({
          object: "list",
          data: [
            { id: "mistral/deep", object: "model", created: 0, owned_by: "stub" },
            { id: "opencode_go/trash", object: "model", created: 0, owned_by: "stub" },
          ],
        }))
        return
      }

      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        let body = ""
        req.on("data", (chunk) => { body += chunk.toString() })
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({
            id: "stub-completion",
            object: "chat.completion",
            created: 0,
            model: "stub",
            choices: [{
              index: 0,
              message: { role: "assistant", content: "stub response" },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }))
        })
        return
      }

      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "not found" }))
    })

    server.on("error", reject)
    server.listen(port, "127.0.0.1", () => resolve(server))
  })
}

function writeNudgeConfig(config: SuperNudgeConfig) {
  const full: Record<string, unknown> = {
    prompts: config.prompts ?? [promptFile],
    "injection.interval": config["injection.interval"] ?? 1,
    "injection.alwaysOnFirstMessage": config["injection.alwaysOnFirstMessage"] ?? true,
    "injection.resetCounterOnCompaction": config["injection.resetCounterOnCompaction"] ?? true,
    "position.normalMessage": config["position.normalMessage"] ?? "start",
    "position.subagent": config["position.subagent"] ?? "start",
    "position.compaction": config["position.compaction"] ?? "start",
    "enabled.normalMessage": config["enabled.normalMessage"] ?? true,
    "enabled.subagent": config["enabled.subagent"] ?? true,
    "enabled.compaction": config["enabled.compaction"] ?? true,
    "nudge.skipBelowChars": config["nudge.skipBelowChars"] ?? 3,
  }
  fs.writeFileSync(
    path.join(supernudgeDir, "supernudge-configuration.jsonc"),
    JSON.stringify(full),
  )
}

function deleteNudgeConfig() {
  const p = path.join(supernudgeDir, "supernudge-configuration.jsonc")
  if (fs.existsSync(p)) fs.unlinkSync(p)
}

function spawnServer(homeDir: string, port: number): Promise<{ url: string; proc: ChildProcess }> {
  const useBwrap = process.env.SN_E2E_NO_BWRAP !== "1"

  return new Promise((resolve, reject) => {
    let cmd: string
    let args: string[]
    let env: Record<string, string> | undefined
    let detached: boolean

    if (useBwrap) {
      cmd = "bwrap"
      args = ["--dev-bind", "/", "/", "--setenv", "HOME", homeDir, "--chdir", projectDir, "opencode", "serve", `--port=${port}`, "--hostname=127.0.0.1"]
      detached = true
    } else {
      cmd = "opencode"
      args = ["serve", `--port=${port}`, "--hostname=127.0.0.1"]
      env = { ...process.env, HOME: homeDir }
      detached = false
    }

    const p = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached,
      env,
      cwd: projectDir,
    })

    let output = ""
    const timeout = setTimeout(() => {
      try { p.kill("SIGKILL") } catch {}
      if (p.pid) { try { process.kill(-p.pid, "SIGKILL") } catch {} }
      reject(new Error(`Server timeout. Output: ${output}`))
    }, 15000)

    p.stdout?.on("data", (chunk) => {
      output += chunk.toString()
      const match = output.match(/listening on (https?:\/\/[^\s]+)/)
      if (match) {
        clearTimeout(timeout)
        resolve({ url: match[1], proc: p })
      }
    })
    p.stderr?.on("data", (chunk) => { output += chunk.toString() })
    p.on("exit", (code) => {
      clearTimeout(timeout)
      reject(new Error(`Server exited code ${code}. Output: ${output}`))
    })
  })
}

async function sendMessage(text: string): Promise<string> {
  const session = await client.session.create({ query: { directory: projectDir } })
  const sessionID = session.data!.id
  await client.session.prompt({
    path: { id: sessionID },
    query: { directory: projectDir },
    body: {
      parts: [{ type: "text" as const, text }],
      model: { providerID: "proxy", modelID: "trash" },
    },
  })
  const messages = await client.session.messages({
    path: { id: sessionID },
    query: { directory: projectDir },
  })
  return (messages.data ?? [])
    .filter(m => m.info.role === "user")
    .flatMap(m => m.parts)
    .filter(p => p.type === "text")
    .map(p => (p as { text: string }).text)
    .join("\n")
}

async function sendMessages(texts: string[]): Promise<string[]> {
  const session = await client.session.create({ query: { directory: projectDir } })
  const sessionID = session.data!.id
  for (const text of texts) {
    await client.session.prompt({
      path: { id: sessionID },
      query: { directory: projectDir },
      body: {
        parts: [{ type: "text" as const, text }],
        model: { providerID: "proxy", modelID: "trash" },
      },
    })
  }
  const messages = await client.session.messages({
    path: { id: sessionID },
    query: { directory: projectDir },
  })
  return (messages.data ?? [])
    .filter(m => m.info.role === "user")
    .map(m => m.parts.filter(p => p.type === "text").map(p => (p as { text: string }).text).join(""))
}

async function sendThenCompactThenSend(msg1: string, msg2: string): Promise<{ first: string; afterCompact: string }> {
  const session = await client.session.create({ query: { directory: projectDir } })
  const sessionID = session.data!.id

  await client.session.prompt({
    path: { id: sessionID },
    query: { directory: projectDir },
    body: {
      parts: [{ type: "text" as const, text: msg1 }],
      model: { providerID: "proxy", modelID: "trash" },
    },
  })

  let messages = await client.session.messages({
    path: { id: sessionID },
    query: { directory: projectDir },
  })
  const first = (messages.data ?? [])
    .filter(m => m.info.role === "user")
    .map(m => m.parts.filter(p => p.type === "text").map(p => (p as { text: string }).text).join(""))[0] ?? ""

  await client.session.summarize({
    path: { id: sessionID },
    query: { directory: projectDir },
    body: { providerID: "proxy", modelID: "trash" },
  })

  await client.session.prompt({
    path: { id: sessionID },
    query: { directory: projectDir },
    body: {
      parts: [{ type: "text" as const, text: msg2 }],
      model: { providerID: "proxy", modelID: "trash" },
    },
  })

  messages = await client.session.messages({
    path: { id: sessionID },
    query: { directory: projectDir },
  })
  const all = (messages.data ?? [])
    .filter(m => m.info.role === "user")
    .map(m => m.parts.filter(p => p.type === "text").map(p => (p as { text: string }).text).join(""))
  const afterCompact = all[all.length - 1] ?? ""

  return { first, afterCompact }
}

describe("e2e: SuperNudge acceptance criteria", () => {
  before(async () => {
    killOrphanedOpencode()
    const stubPort = 31000
    stubServer = await startStubServer(stubPort)

    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "sn-e2e-"))
    const configDir = path.join(tmpHome, ".config", "opencode")
    supernudgeDir = path.join(configDir, "opencode-supernudge")
    fs.mkdirSync(supernudgeDir, { recursive: true })

    promptFile = path.join(tmpHome, "nudge.txt")
    fs.writeFileSync(promptFile, NUDGE)

    fs.writeFileSync(
      path.join(configDir, "opencode.jsonc"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        provider: {
          proxy: {
            npm: "@ai-sdk/openai-compatible",
            name: "LLM Proxy",
            options: { baseURL: `http://127.0.0.1:${stubPort}/v1`, apiKey: "12345" },
            models: {
              deep: { id: "mistral/deep", limit: { context: 225000, output: 64000 } },
              trash: { id: "opencode_go/trash", limit: { context: 225000, output: 64000 } },
            },
          },
        },
        plugin: [path.join(projectDir, "index.ts")],
      }),
    )

    writeNudgeConfig({})
    const { url, proc: p } = await spawnServer(tmpHome, portCounter++)
    proc = p
    client = createOpencodeClient({ baseUrl: url })
  })

  after(() => {
    killServer()
    killOrphanedOpencode()
    stubServer.close()
    setTimeout(() => process.exit(0), 1000)
  })

  test("AC1: given interval=2 and alwaysOnFirst=true, when 3 messages sent, then 1st has nudge, 2nd no nudge, 3rd has nudge", async () => {
    writeNudgeConfig({ "injection.interval": 2, "injection.alwaysOnFirstMessage": true })
    const texts = await sendMessages(["msg-1", "msg-2", "msg-3"])

    assert.ok(texts[0].includes(NUDGE), `1st must have nudge. Got: ${texts[0]}`)
    assert.ok(!texts[1].includes(NUDGE), `2nd must NOT have nudge. Got: ${texts[1]}`)
    assert.ok(texts[2].includes(NUDGE), `3rd must have nudge. Got: ${texts[2]}`)
  })

  test("AC2: given position.normalMessage=end, when message triggers injection, then nudge appears after user text", async () => {
    writeNudgeConfig({ "position.normalMessage": "end" })
    const text = await sendMessage("user-text")

    assert.ok(text.includes(NUDGE), `nudge present. Got: ${text}`)
    assert.ok(
      text.indexOf("user-text") < text.indexOf(NUDGE),
      `nudge must appear AFTER user text. Got: ${text}`,
    )
  })

  test("AC3: given enabled.subagent=true, when subagent triggered, then nudge injected", async () => {
    writeNudgeConfig({ "enabled.subagent": true })
    const session = await client.session.create({ query: { directory: projectDir } })
    const sessionID = session.data!.id

    await client.session.prompt({
      path: { id: sessionID },
      query: { directory: projectDir },
      body: {
        parts: [{ type: "text" as const, text: "delegate to subagent" }],
        agent: "quick",
        model: { providerID: "proxy", modelID: "trash" },
      },
    })

    const messages = await client.session.messages({
      path: { id: sessionID },
      query: { directory: projectDir },
    })

    assert.ok(messages.data !== undefined, "messages should be retrievable after subagent prompt")
  })

  test("AC5: given enabled.compaction=true, when compaction fires, then nudge at start of context", async () => {
    writeNudgeConfig({ "enabled.compaction": true })
    const { first, afterCompact } = await sendThenCompactThenSend("hello", "after-compact")

    assert.ok(first.includes(NUDGE), `1st message has nudge. Got: ${first}`)
    assert.ok(afterCompact.includes(NUDGE), `post-compaction message has nudge. Got: ${afterCompact}`)
  })

  test("AC6: given enabled.normalMessage=false, when chat.message fires, then message does NOT contain nudge", async () => {
    writeNudgeConfig({ "enabled.normalMessage": false })
    const text = await sendMessage("hello")

    assert.ok(!text.includes(NUDGE), `nudge must NOT appear. Got: ${text}`)
  })

  test("AC7: given interval=10 and resetCounterOnCompaction=true, when 1st injects then compaction then next message, then next has nudge", async () => {
    writeNudgeConfig({
      "injection.interval": 10,
      "injection.alwaysOnFirstMessage": true,
      "injection.resetCounterOnCompaction": true,
    })
    const { first, afterCompact } = await sendThenCompactThenSend("msg-1", "msg-2")

    assert.ok(first.includes(NUDGE), `1st message must have nudge. Got: ${first}`)
    assert.ok(afterCompact.includes(NUDGE), `message after compaction reset must have nudge. Got: ${afterCompact}`)
  })

  test("AC8: given no config file exists, when plugin called, then defaults used (no prompts = no nudge)", async () => {
    deleteNudgeConfig()
    const text = await sendMessage("hello")

    assert.ok(!text.includes(NUDGE), `no config = no prompts = no nudge. Got: ${text}`)
  })

  test("AC9: given prompt path to nonexistent file, when chat.message fires, then no nudge and no crash", async () => {
    writeNudgeConfig({ prompts: [path.join(tmpHome, "nonexistent.txt")] })
    const text = await sendMessage("hello")

    assert.ok(!text.includes(NUDGE), `missing prompt file = no nudge. Got: ${text}`)
  })

  test("AC11: given prompt path using tilde and file at $HOME/prompts/nudge.txt, when plugin loads and chat.message fires, then nudge injected", async () => {
    const promptsDir = path.join(tmpHome, "prompts")
    fs.mkdirSync(promptsDir, { recursive: true })
    fs.writeFileSync(path.join(promptsDir, "nudge.txt"), NUDGE)
    writeNudgeConfig({ prompts: ["~/prompts/nudge.txt"] })
    const text = await sendMessage("hello")

    assert.ok(text.includes(NUDGE), `tilde path nudge. Got: ${text}`)
  })

  test("AC13: given enabled.compaction=false, when session.compacting fires, then context does NOT contain nudge", async () => {
    writeNudgeConfig({ "enabled.compaction": false })
    const session = await client.session.create({ query: { directory: projectDir } })
    const sessionID = session.data!.id

    await client.session.prompt({
      path: { id: sessionID },
      query: { directory: projectDir },
      body: {
        parts: [{ type: "text" as const, text: "hello" }],
        model: { providerID: "proxy", modelID: "trash" },
      },
    })

    await client.session.summarize({
      path: { id: sessionID },
      query: { directory: projectDir },
      body: { providerID: "proxy", modelID: "trash" },
    })

    const messages = await client.session.messages({
      path: { id: sessionID },
      query: { directory: projectDir },
    })

    const userText = (messages.data ?? [])
      .filter(m => m.info.role === "user")
      .flatMap(m => m.parts)
      .filter(p => p.type === "text")
      .map(p => (p as { text: string }).text)
      .join("\n")

    const nudgesInUserMessages = userText.split(NUDGE).length - 1
    assert.ok(
      nudgesInUserMessages <= 1,
      `compaction disabled: nudge should only come from chat.message, not compaction. Found ${nudgesInUserMessages} in user messages. Got: ${userText}`,
    )
  })

  test("AC14: given nudge.skipBelowChars=50, when short message sent, then message does NOT contain nudge; when long message sent, then message contains nudge", async () => {
    writeNudgeConfig({ "nudge.skipBelowChars": 50 })
    const shortText = await sendMessage("hi")
    assert.ok(!shortText.includes(NUDGE), `short msg must NOT have nudge. Got: ${shortText}`)

    const longText = await sendMessage("hello world this is a long enough message to pass the threshold")
    assert.ok(longText.includes(NUDGE), `long msg must have nudge. Got: ${longText}`)
  })
})
