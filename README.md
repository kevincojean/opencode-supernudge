# OpenCode SuperNudge
A plugin for when you really want to make sure your agents never forget about super important things.

## Use cases
Here are examples of `nudges` I use in my workflows which improve agent code-quality ; because I remind them of this ALL the time.

```jsonc
{
  "prompts": [
    "~/.config/opencode/snippet/tdd.md",
    "~/.config/opencode/snippet/no-mocking.md",
    "~/.config/opencode/snippet/givenwhenthen.md",
    "~/.config/opencode/snippet/test-pollution.md",
    "~/.config/opencode/snippet/docstring-pollution.md",
    "~/.config/opencode/snippet/disable-question-tool.md"
  ]
}
```

### Forcing TDD (red-green) development
```md
TDD: YOU MUST respect the RED / GREEN principle - you ALWAYS write a FAILING test case FIRST - this will ENSURE your changes actually fix the problem.
```

### Forcing e2e tests without mocking
```md 
Do NOT use MOCKING, EXCEPT when calling external vendors incurs a real life $$$ COST; otherwise we must stick with REAL e2e test cases at the outer-most user-facing SEAM.
```

### Forcing the GivenWhenThen forms for test cases
```md 
You MUST define acceptance criteria in the GivenWhenThen form UNLESS the current project's style guidelines DICTATE otherwise.
```

### Hedging against too many useless test case creations
```md 
Be very wary of creating too many test cases. Test the inputs and the outputs of what the user will do at the seams of the application. No more, no less. We don't want to test cases that are extreme outliers.
```

### Hedging against docstring and comment pollution
```md
Do NOT add test docstrings, or comments, or module docstrings unless ABSOLUTELY necessary.
```

### Soft-disabling the often-slow 'question' tool
```md
Do NOT use the question tool at you disposal, it is extremely slow.
```


## Install
```bash
git clone https://github.com/kevincojean/opencode-supernudge.git
cd opencode-supernudge
npm install
```

Add to `~/.config/opencode/opencode.jsonc` `plugin` array, replacing `<PATH_TO_SUPERNUDGE>` with the absolute path to your clone:

```jsonc
"plugin": [
  "<PATH_TO_SUPERNUDGE>"
]
```


## Config
Create `~/.config/opencode/opencode-supernudge/supernudge-configuration.jsonc`:

```jsonc
{
  "prompts": ["~/prompts/style.md", "~/prompts/constraints.md"],
  "injection.interval": 1,
  "injection.alwaysOnFirstMessage": true,
  "injection.resetCounterOnCompaction": true,
  "injection.subagentInterval": 1,
  "injection.subagentAlwaysOnFirst": true,
  "injection.subagentResetOnCompaction": true,
  "position.normalMessage": "start",
  "position.subagent": "start",
  "position.compaction": "start",
  "enabled.normalMessage": true,
  "enabled.subagentSystemPromptNudge": true,
  "enabled.subagentAutonomousWorkNudge": true,
  "enabled.compaction": true,
  "wrapper.prefix": "<opencode-supernudge>",
  "wrapper.suffix": "</opencode-supernudge>"
}
```

### Prompt path resolution

### Project-local config

A project-local config file can overlay the global config. Two global config keys control this:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `currentWorkingDirectory.configFilePath` | string | `"./.opencode/com.kevincojean.opencode-supernudge/supernudge-configuration.jsonc"` | Path to local config (relative to opencode cwd) |
| `currentWorkingDirectory.configEnabled` | boolean | `true` | Master switch for local config lookup |

When enabled, the plugin looks for a local config file at the resolved path. If found and valid, the local config's `prompts` array is **concatenated** with the global config's `prompts` array. All other keys in the local config are **ignored** - only `prompts` is locally overridable. Per-prompt overrides (e.g. `injection.interval`, `enabled.*`) work within local config's `prompts` entries via the [per-prompt override](#per-prompt-override) mechanism.

If the local config has parse errors, a toast notification (error level) is shown and the plugin falls back to the global config only.

Example local config:
```jsonc
{
  "prompts": [
    "./prompts/project-specific-nudge.md",
    {
      "path": "./prompts/tdd.md",
      "injection.interval": 3,
      "enabled.compaction": false
    }
  ]
}
```

Prompt file paths in the `prompts` array support 3 modes:

1. **Home directory** - paths starting with `~` or containing `$HOME`:
```jsonc
   { "prompts": ["~/prompts/tdd.md", "$HOME/prompts/no-mocking.md"] }
   ```

2. **Relative paths** - resolved against opencode's __working directory__:
   ```jsonc
   { "prompts": ["./prompts/tdd.md", "prompts/no-mocking.md", "../shared/constraints.md"] }
   ```

3. **Absolute paths** - paths starting with `/` are used as-is:
   ```jsonc
   { "prompts": ["/home/user/prompts/tdd.md"] }
   ```

### Subagent nudge paths

There are **two distinct paths** for injecting nudges into subagent contexts. They are gated separately and have independent defaults:

- **System prompt nudge** (`enabled.subagentSystemPromptNudge`, default `true`): injects the nudge into the subagent's **initial system prompt** via `experimental.chat.system.transform`. Fires **once** per subagent session, before the subagent starts working. This is the path that gives the subagent the nudge "at the system prompt level" you observe.
- **Autonomous work nudge** (`enabled.subagentAutonomousWorkNudge`, default `true`): injects the nudge **periodically** during subagent autonomous turns (via `experimental.text.complete` + `experimental.chat.messages.transform`). Does NOT fire on the primary agent's `chat.message` - the primary path uses `enabled.normalMessage` instead.

To disable periodic nudges, set:
```jsonc
{
  "enabled.subagentAutonomousWorkNudge": false
}
```

> The legacy key `enabled.subagent` is no longer recognized. If your config still has it, replace it with the two `enabled.subagent*` keys above.

### Per-prompt override
Any prompt entry can be an object that overrides specific global settings for that prompt only. String entries use all global defaults.

```jsonc
{
  "prompts": [
    // String: global defaults apply
    "~/prompts/tdd.md",

    // Object with partial overrides: only listed keys override globals
    {
      "path": "~/prompts/givenwhenthen.md",
      "injection.interval": 3,
      "injection.skipFirstMessageBelowChars": 10
    },

    // Object with all overrides: every global setting overridden
    {
      "path": "~/prompts/no-mocking.md",
      "enabled.compaction": false,
      "enabled.normalMessage": true,
      "enabled.subagentSystemPromptNudge": false,
      "enabled.subagentAutonomousWorkNudge": false,
      "injection.alwaysOnFirstMessage": false,
      "injection.interval": 1,
      "injection.resetCounterOnCompaction": false,
      "injection.skipFirstMessageBelowChars": 10,
      "injection.subagentInterval": 1,
      "injection.subagentAlwaysOnFirst": false,
      "injection.subagentResetOnCompaction": false,
      "position.compaction": "end",
      "position.normalMessage": "end",
      "position.subagent": "end"
    }
  ],
  "injection.interval": 1,
  "injection.alwaysOnFirstMessage": true
}
```

- `tdd.md` - string, all global defaults
- `givenwhenthen.md` - partial override, injects every 3rd message only
- `no-mocking.md` - full override, all globals ignored, uses its own settings exclusively

### Parameters
| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `prompts` | `(string \| object)[]` | `[]` | Prompt file paths. String or `{ path: string, ...overrides }`. Supports `~`, `$HOME` interpolation, and relative paths (resolved against opencode's working directory). |
| `injection.interval` | `number` | `1` | Inject every Nth *user* message. `1` = every message. `2` = 1st, skip 2nd, inject 3rd. |
| `injection.alwaysOnFirstMessage` | `boolean` | `true` | Force inject on first user message regardless of interval. |
| `injection.resetCounterOnCompaction` | `boolean` | `true` | Reset per-session counter to 0 when compaction fires. |
| `position.normalMessage` | `"start"` \| `"end"` | `"start"` | Nudge placement in user message. `start` = before user text. `end` = after. |
| `position.subagent` | `"start"` \| `"end"` | `"start"` | Nudge placement in subagent workflows.|
| `position.compaction` | `"start"` \| `"end"` | `"start"` | Nudge placement in compaction context. |
| `enabled.normalMessage` | `boolean` | `true` | Inject nudge on user messages. |
| `enabled.subagentSystemPromptNudge` | `boolean` | `true` | Inject nudge into subagent's **initial system prompt** (via `experimental.chat.system.transform`). Fires once per subagent session. |
| `enabled.subagentAutonomousWorkNudge` | `boolean` | `true` | Inject nudge **periodically** during subagent autonomous turns (via `experimental.text.complete` + `experimental.chat.messages.transform`). Does NOT fire on the primary agent's `chat.message`. |
| `enabled.subagentAutonomousWorkNudge` | `boolean` | `true` | Inject nudge **periodically** during subagent autonomous turns (via `experimental.text.complete` + `experimental.chat.messages.transform`). Does NOT fire on the primary agent's `chat.message`. |
| `enabled.compaction` | `boolean` | `true` | Inject nudge into context on compaction. |
| `wrapper.prefix` | `string` | `"<opencode-supernudge>"` | Marker inserted above each nudge block. Empty string disables. |
| `wrapper.suffix` | `string` | `"</opencode-supernudge>"` | Marker inserted below each nudge block. Empty string disables. |
| `nudge.separator` | `string` | `"\n\n"` | Separator between multiple nudges within the same block. |
| `nudge.enableTitlePrefix` | `boolean` | `true` | Prefix each nudge with `[filename]` (lowercase, no extension). |
| `injection.skipFirstMessageBelowChars` | `number` | `3` | Skip injection when user message length `<=` this threshold. |
| `injection.subagentInterval` | `number` | `1` | Inject every Nth autonomous turn. `1` = every turn. `2` = 1st, skip 2nd, inject 3rd. |
| `injection.subagentAlwaysOnFirst` | `boolean` | `true` | Force inject on first autonomous turn regardless of interval. |
| `injection.subagentResetOnCompaction` | `boolean` | `true` | Reset autonomous counter to 0 when compaction fires. |

All parameters except `prompts` can be overridden per-prompt by including them in the prompt object.

## Test
```bash
# Unit tests
node --import tsx --test src/test/supernudge.test.ts

# E2E tests (spins up opencode serve with an internal stub LLM server)
# SN_E2E_NO_BWRAP=1 is set by default in package.json to avoid bwrap process kill issues
# Remove it from package.json to use bwrap sandboxing instead
npm run test:e2e
```

## Roadmap
You can see what I have in mind for next features by reading my humble [kanban board](.opencode/kanban/board.md).

## License
MIT Kévin Cojean
