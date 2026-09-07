# E2E Testing

## 2026-08-25

### Orphaned opencode serve processes blocking e2e tests
e2e tests spawn opencode inside bwrap with `detached: true`. The `after` hook uses `process.kill(-proc.pid, "SIGKILL")` to kill the process group. But if the test runner crashes or is interrupted, the opencode process stays alive on the port. Next run: `spawnBwrap` fails with `Server exited code 1` because the port is already in use. Fix: kill orphaned `opencode serve` processes before running e2e tests: `pkill -9 -f "opencode serve"`.

### LLM proxy stub server replaces external dependency
e2e tests were hanging/timing out because they relied on a real LLM proxy at `localhost:8000`. Replaced with a lightweight Node `http.createServer` stub that returns canned OpenAI-compatible responses for `/v1/models` and `/v1/chat/completions`. Stub runs on `127.0.0.1:31000` on the host. bwrap with `--dev-bind / /` has network access, so opencode inside the sandbox can reach the stub. Tests went from 2+ minutes (or hanging) to ~57s. No external dependencies needed.

### alwaysOnFirstMessage was a no-op (pre-existing bug)
The shouldInject logic used OR: `(count === 1 && alwaysOnFirst) || interval <= 1 || (count - 1) % interval === 0`. The modulo condition `(count-1) % interval === 0` is always true for count=1 (0 % anything = 0), making `alwaysOnFirstMessage=false` ineffective. Fixed by restructuring: `interval <= 1 || (count === 1 ? alwaysOnFirst : (count - 1) % interval === 0)`.

### bwrap detached process unkillable - switched to direct spawn
E2E tests spawned `opencode serve` inside `bwrap` with `detached: true`. The `process.kill(-pid, "SIGKILL")` (process group kill) could not reach the opencode process inside the bwrap PID namespace. Tests would hang indefinitely because the server never died. Fix: `SN_E2E_NO_BWRAP=1` env var (now default in package.json) spawns `opencode serve` directly (no bwrap) with `detached: false`, `HOME` env var set to temp dir. Direct child process is killable with `proc.kill("SIGKILL")`. Added `process.exit(0)` in `after` hook with 1s delay to force exit even if child processes (LSP servers) keep pipes open. Added `--test-timeout=60000` to prevent infinite hangs.

### AC1 timeout at 30s - increased to 60s
AC1 sends 3 sequential prompts in one session via `sendMessages`. Each `client.session.prompt` is a full round-trip through opencode serve + stub LLM. 30s timeout was too tight for 3 round trips. Increased `--test-timeout` to 60000ms.

### AC10 deleted: contradicted T-001 bug fix part 2
AC10 expected autonomous nudge on PRIMARY agent messages, but T-001 bug fix part 2 explicitly blocks autonomous injection on primary sessions via `primarySessions` set. Test could never pass against current code. Deleted. Unit tests for subagent autonomous path (where `primarySessions` does NOT contain the session) remain valid and pass.

### AC12: relative path resolution verified in e2e
T-012 added AC12: creates `projectDir/prompts/nudge.txt`, config uses `./prompts/nudge.txt`, verifies nudge injected via `chat.message`. PASSES. Confirms `PluginInput.directory` is correctly threaded as `baseDir` through the real opencode runtime. Cleanup removes the created file and directory after assertion.

## 2026-09-04

### killOrphanedOpencode() killed user's running opencode serve process
The `killOrphanedOpencode()` function used `pkill -9 -f "opencode serve"` which matches ANY process with "opencode serve" in its command line - including the user's long-running `opencode serve` process. This caused the user's systemd-managed serve to die, requiring manual restart.

**Root cause**: `pkill -f` matches by full command line, not by PID or process group. The blanket kill was added in 2026-08-25 to clean up orphaned processes from crashed test runs, but it was too aggressive.

**Fix**: Removed `killOrphanedOpencode()` entirely. The scoped `killServer()` (kills by captured `proc.pid` + process group) already handles the test-spawned server correctly. For port conflicts, switched stub server to use port 0 (OS-assigned free port) and test server to use random high ports (40000-50000 range) to avoid conflicts with user's processes and orphaned test processes.

**Key insight**: Never use `pkill -f` with broad patterns in test cleanup - it will kill unintended processes. Prefer scoped cleanup by PID/process group, or use OS-assigned ports to avoid conflicts entirely.

### AC1 timing out at 60s - the real cause was a throwaway HOME, not ports
After removing `killOrphanedOpencode()` the suite kept timing out on AC1.
Two rounds of port fixes (scoped `fuser -k`, then random/OS-assigned ports) did not help.
Ports were never the problem.

**Evidence**: leftover `/tmp/sn-e2e-*` dirs from failed runs each contained a fully populated
`.config/opencode/node_modules` weighing **62MB**, plus a generated `package.json`
(`{"dependencies": {"@opencode-ai/plugin": "1.18.27"}}`) and a `package-lock.json`.
The `.cache/opencode/node_modules` dir was empty - opencode installs plugin deps into the
**config** dir, not the cache dir.

**Root cause**: `before` created a brand new `fs.mkdtempSync` HOME every run.
opencode then had to install 62MB of plugin dependencies from scratch on first boot.
npm's own cache lives at `$HOME/.npm`, which was also cold, so it was a full network download.
That cost landed on the first `session.prompt` call, i.e. inside AC1's 60s budget.
Network variance explains the flakiness: one run burned ~7 minutes and timed out
AC1/AC2/AC5/AC6/AC7/AC8/AC9 before warming up, later runs only blew AC1.

**Fix**:
1. Stable HOME at `/tmp/sn-e2e-home`, reused across runs (`resetE2eHome()`).
   It wipes only what a test can dirty - `opencode.jsonc`, `opencode-supernudge/`,
   `.local/share/opencode`, `.local/state/opencode`, `prompts/`, `nudge.txt`, `nonexistent.txt` -
   and preserves `node_modules`, `package.json`, `package-lock.json`.
2. Warm-up `sendMessage("warm-up")` at the end of `before`, so plugin load and provider
   init are paid outside any test's budget. Counters are keyed by `sessionID`, and every
   test opens its own session, so the warm-up session cannot pollute assertions.
3. `before` hook given `{ timeout: 300000 }` so a genuinely cold first-ever run can finish.
4. AC1 given `{ timeout: 120000 }` - it is the only test doing 3 sequential round trips.
5. `spawnServer` boot timeout raised 15s -> 30s for cold-install runs.

**Key insight**: an isolated HOME is not free. Anything opencode installs per-HOME
(plugin deps, npm cache, provider packages) gets re-downloaded on every run and the bill
arrives inside the first test. Isolate config and session state, share the install.

### THE actual cause: non-streaming stub made opencode's agent loop spin forever
Stable HOME did not fix the timeouts, but it preserved `$HOME/.local/share/opencode/log/opencode.log`
across runs - which finally showed the real failure.

**Evidence**: 422 consecutive `message=loop session.id=... step=N` lines, N counting 1 -> 421,
each preceded by a fresh `message=process messageID=<new>` and `message=stream`.
One user prompt, ~0.8s per step, running until the suite was killed.
Zero `level=ERROR` and zero `level=WARN` lines - the failure is completely silent.

**Root cause**: opencode calls the model through ai-sdk `streamText`, so the request body
carries `stream: true` and the provider expects `text/event-stream`.
The stub answered every request with a plain `application/json` chat-completion object.
The SSE parser found no events, so the assistant turn produced no text, no tool calls and
no finish reason. opencode saw an unfinished turn and stepped the loop again. Forever.
`client.session.prompt` only resolves when the loop ends, so the first prompt never returned.

**Why the suite looked like it "mostly passed" before**: every AC asserts on **user**
messages only. The nudge is written by `chat.message` before any LLM call. So whenever
`session.prompt` returned early for any reason, the assertion still passed - the assistant
never had to say anything. Only the tests that genuinely waited (AC1 first, then whichever
ran while the loop was hogging the server) surfaced as timeouts. This masked the bug for a
long time and sent three rounds of debugging at ports and npm installs instead.

**Fix**: the stub now parses the request body and branches on `stream === true`.
Streaming requests get real SSE - a content delta chunk, a `finish_reason: "stop"` chunk
with usage, then `data: [DONE]`. Non-streaming requests keep the old JSON shape.

**Key insight**: a stub for a streaming API must actually stream. If it does not, the
client does not error - it silently never finishes, and the symptom shows up as a test
timeout somewhere unrelated. Check the server log for a runaway `step=` counter before
blaming the test harness.
