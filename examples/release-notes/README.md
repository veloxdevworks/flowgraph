# release-notes

Demonstrates **human-in-the-loop (HITL) interrupt + durable resume** — the Phase 3 exit criterion. The graph drafts release notes, pauses for operator approval, then publishes only if approved.

```
START → draft-notes → approve (interrupt) → publish-notes → END
                              ↓ (not approved)
                             END
```

## Prerequisites

- Functions registered via `register.ts` (`draftNotes`, `requestApproval`, `publishNotes`)
- SQLite checkpoint enabled in the graph YAML

## Run locally (interactive)

```bash
cd examples/release-notes
pnpm test          # in-memory test harness
```

For a manual CLI run with registration, import `./register.ts` before compile (see `release-notes.test.ts` for the pattern).

### CLI with durable checkpoint

```bash
# Step 1 — run to the approval gate (interrupts)
flowgraph run release-notes.graph.yaml \
  --thread rel-1 \
  --on-interrupt fail \
  --input version=1.4.0

# Step 2 — resume with operator decision (even after process exit)
flowgraph resume release-notes.graph.yaml \
  --thread rel-1 \
  --resume '{"approved":true,"notes":"Custom release text"}'
```

Use `--on-interrupt prompt` locally to answer approval questions in the terminal.

## Key patterns

| Pattern | Where |
|---------|-------|
| `ctx.interrupt()` | `requestApproval` in `register.ts` — pauses until resume value arrives |
| `ctx.once()` | `publishNotes` — idempotent side effect across replay |
| Durable checkpoint | `runtime.checkpoint.backend: sqlite` at `.flowgraph/release-notes.db` |

## Inspect pending interrupts

```bash
flowgraph resume release-notes.graph.yaml --thread rel-1 --list
flowgraph resume release-notes.graph.yaml --thread rel-1 --list --json
```

## CI vs desktop

Same graph file; use `--on-interrupt fail` in CI and `--on-interrupt prompt` locally. See [09 — CLI](../docs/09-cli.md).

See also [hitl](../hitl/) for `hitl` node patterns and [14 — Programmatic API](../docs/14-programmatic-api.md).
