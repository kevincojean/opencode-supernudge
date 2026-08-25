# OpenCode SuperNudge

OpenCode v1 plugin that persistently injects nudge text into LLM conversations to prevent drift.

## Install

```bash
npm install
```


## Config

Create `~/.config/opencode/opencode-supernudge/supernudge-configuration.jsonc`:

```jsonc
{
  "prompts": ["~/prompts/style.md", "~/prompts/constraints.md"],
  "injection.interval": 1,
  "injection.alwaysOnFirstMessage": true,
  "injection.resetCounterOnCompaction": true,
  "position.normalMessage": "start",
  "position.subagent": "start",
  "position.compaction": "start",
  "enabled.normalMessage": true,
  "enabled.subagent": true,
  "enabled.compaction": true
}
```

### Parameters

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `prompts` | `string[]` | `[]` | File paths to inject (nudge), supports $HOME and ~ interpolation. |
| `injection.interval` | `number` | `1` | Inject every Nth *user* message. `1` = every message. `2` = 1st, skip 2nd, inject 3rd. |
| `injection.alwaysOnFirstMessage` | `boolean` | `true` | Force inject on first user message regardless of interval. |
| `injection.resetCounterOnCompaction` | `boolean` | `true` | Reset per-session counter to 0 when compaction fires. |
| `position.normalMessage` | `"start"` \| `"end"` | `"start"` | Nudge placement in user message. `start` = before user text. `end` = after. |
| `position.subagent` | `"start"` \| `"end"` | `"start"` | Nudge placement in subagent system prompt. |
| `position.compaction` | `"start"` \| `"end"` | `"start"` | Nudge placement in compaction context. |
| `enabled.normalMessage` | `boolean` | `true` | Inject nudge on user messages. |
| `enabled.subagent` | `boolean` | `true` | Inject nudge into system prompt. |
| `enabled.compaction` | `boolean` | `true` | Inject nudge into context on compaction. |

## Test

```bash
# Unit tests
node --import tsx --test src/test/supernudge.test.ts

# E2E tests (requires opencode and an LLM proxy at localhost:8000)
# Set SN_E2E_NO_BWRAP=1 if bwrap user namespaces are unavailable
SN_E2E_NO_BWRAP=1 node --import tsx --test src/test/e2e.test.ts
```

## License

MIT Kévin Cojean
