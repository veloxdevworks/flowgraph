# triage-issue

The **north-star deterministic example** from the roadmap: classify an inbound issue, route it, and create a ticket via a skill — no LLM required.

```
START → classify (code) → route (router) → create-ticket (skill) → END
```

## Run it

This example uses a **`code` node**, which requires registering functions before compile. Use the provided runner:

```bash
cd examples/triage-issue
node run.js
```

Or with the CLI after registering functions in your own script (see `run.js`).

## How it works

| Node | Type | Role |
|------|------|------|
| `classify` | `code` | Pure function `classifyIssue` → `bug` \| `feature` \| `question` |
| `route` | `router` | Rules-based routing (all paths lead to ticket creation in this demo) |
| `create-ticket` | `skill` | Calls `skills/mock-create-ticket` with project, type, title, description |

### Hybrid authoring pattern

- **`code` node** — Logic lives in `run.js` via `registerFunction("classifyIssue", …)`. Required because `code` nodes reference registered functions by name.
- **`skill` node** — Handler on disk at `skills/mock-create-ticket/handler.js`. No registration needed.

Compare with [quickstart](../quickstart/) where **both** steps are skills and run with zero TypeScript.

## Inspect

```bash
flowgraph validate triage.graph.yaml
flowgraph graph triage.graph.yaml --format ascii
flowgraph skills doctor skills/mock-create-ticket
```

## Extend

- Swap `classify` for an `intelligent` node (Phase 4 exit criterion).
- Replace `mock-create-ticket` with a real Jira/Linear skill.
- Enable checkpointing in `runtime.checkpoint` for durable runs.

See [13 — Getting started](../docs/13-getting-started.md) and [IMPLEMENTATION_STATUS.md](../docs/IMPLEMENTATION_STATUS.md).
