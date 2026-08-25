# E2E Testing

## 2026-08-25

### Orphaned opencode serve processes blocking e2e tests
e2e tests spawn opencode inside bwrap with `detached: true`. The `after` hook uses `process.kill(-proc.pid, "SIGKILL")` to kill the process group. But if the test runner crashes or is interrupted, the opencode process stays alive on the port. Next run: `spawnBwrap` fails with `Server exited code 1` because the port is already in use. Fix: kill orphaned `opencode serve` processes before running e2e tests: `pkill -9 -f "opencode serve"`.

### LLM proxy stub server replaces external dependency
e2e tests were hanging/timing out because they relied on a real LLM proxy at `localhost:8000`. Replaced with a lightweight Node `http.createServer` stub that returns canned OpenAI-compatible responses for `/v1/models` and `/v1/chat/completions`. Stub runs on `127.0.0.1:31000` on the host. bwrap with `--dev-bind / /` has network access, so opencode inside the sandbox can reach the stub. Tests went from 2+ minutes (or hanging) to ~57s. No external dependencies needed.

### alwaysOnFirstMessage was a no-op (pre-existing bug)
The shouldInject logic used OR: `(count === 1 && alwaysOnFirst) || interval <= 1 || (count - 1) % interval === 0`. The modulo condition `(count-1) % interval === 0` is always true for count=1 (0 % anything = 0), making `alwaysOnFirstMessage=false` ineffective. Fixed by restructuring: `interval <= 1 || (count === 1 ? alwaysOnFirst : (count - 1) % interval === 0)`.
