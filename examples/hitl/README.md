# HITL demo

Demonstrates human-in-the-loop gates and agent clarifying questions.

## Setup

```bash
pnpm install
export OPENAI_API_KEY=...
```

## Local (interactive)

Prompts on the terminal for each interrupt (`--on-interrupt prompt`):

```bash
pnpm run run:local
```

Flow:

1. **`hitl` approve gate** — yes/no before the agent runs
2. **`ask_human` tool** — agent may ask a clarifying question (free text)
3. **Summary node** — writes final result to `state.result`

## CI / GUI (no terminal prompts)

Run until the first interrupt, then exit:

```bash
pnpm run run:ci   # exits with status interrupted (code 3)
```

Poll pending interrupts (for a GUI or automation):

```bash
pnpm run list
```

Resume programmatically (repeat until completed):

```bash
pnpm run resume:approve
pnpm run resume:answer   # if the agent asked a question
```

Or pass any JSON resume value matching the interrupt kind:

| Kind | `--resume` example |
|---|---|
| `approval` | `'{"approved":true}'` |
| `question` | `'{"answer":"Focus on Q3 revenue"}'` |
| `choice` | `'{"choice":"retry"}'` |

## Graph highlights

- `hitl` node with `mode: approve` — deterministic approval gate in the graph
- `ask_human` tool on an `intelligent` node — agent-driven clarification
- SQLite checkpoint — survives process restarts between resume calls
