# Software factory

End-to-end **software development lifecycle** demo: route a feature onto a **prototype** or **production** track, mock Jira + chat sync, pause for human design/release gates on production, and run deterministic quality steps (i18n, a11y, unit, e2e, o11y).

## Tracks

Track is chosen at the **`choose-track` HITL** gate (`prototype` or `production`) — not from seed input.

| Track | Path | Emphasizes |
|-------|------|------------|
| **prototype** | intake → Jira → **choose track** → build → staging → **promote HITL** → (decline) Jira Done → chat → record | Tight feedback loop; optional promote into production |
| **production** | … → **design HITL** → **parallel critiques** (design / performance / security) → aggregate → follow-up plan → build → i18n → a11y → unit → e2e → o11y → **release HITL** → deploy → … | Full SDLC with fan-out reviews + human gates |
| **promote** | After staging, approve promote → joins production at design review | Prototype → production without restarting |

## Parallel reviews (fan-out / join)

After design approval, `kickoff-reviews` fans out to three critique nodes that append into `state.reviews` (`reducer: append`). `aggregate-reviews` synthesizes themes; `follow-up-plan` turns them into prioritized actions that feed `production-build`.

## Mock integrations

| Node | Effect |
|------|--------|
| `update-jira` / `jira-*` | Writes `state.jira` (`In Progress` → `Done`) |
| `chat-owner` / `chat-*` | Appends to `state.notifications` (design review, release review, shipped) |

No real HTTP — swap later for `http` nodes if desired.

## Run

```bash
# From monorepo root
pnpm --filter software-factory-example test
pnpm --filter software-factory-example validate

# Interactive (HITL pauses — use flowgraph resume or --on-interrupt fail in CI)
pnpm --filter software-factory-example start
```

## Docs demo

Synced into the flowgraph docs site interactive simulator as **Software factory**.
