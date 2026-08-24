# OpenCode SuperNudge

OpenCode v1 plugin that persistently injects nudge text into LLM conversations to prevent drift.

## Install

```bash
npm install
```

## Test

```bash
node --import tsx --test src/test/supernudge.test.ts
```

## Config

Create `~/.config/opencode/opencode-supernudge/supernudge-configuration.jsonc`:

```jsonc
{
  "prompts": ["~/prompts/nudge.md"],
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

## Injection Points

| Hook | When | Scope |
|------|------|-------|
| `chat.message` | Every user message | Normal conversations |
| `experimental.chat.system.transform` | Subagent delegation | No `sessionID` = subagent |
| `experimental.session.compacting` | Context compaction | Counter reset + nudge |

## Multiple Prompts

Multiple files joined with `\n\n`:

```jsonc
{
  "prompts": ["~/prompts/style.md", "~/prompts/constraints.md"]
}
```

## License

MIT
