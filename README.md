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
git clone https://github.com/kevincojean/opencode-supernudge.git ~/Documents/Development/com.kevincojean.opencode-supernudge
cd ~/Documents/Development/com.kevincojean.opencode-supernudge
npm install
```

Add to `~/.config/opencode/opencode.jsonc` `plugin` array:

```jsonc
"plugin": [
  "/home/dehi/Documents/Development/com.kevincojean.opencode-supernudge"
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
