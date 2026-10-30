# Self-healing (memory: incidents)

An on-call remediation loop that remembers. Each alert fingerprint is a memory
**subject** (`runtime.memory.subject: { type: incident, key: "{{ input.alert.fingerprint }}" }`).

| Node | What it does |
|------|--------------|
| `diagnose` (agent) | Recalls, within a 1200-token budget: attempts already made on **this incident** (`scopes: [subject]`), **what fixed similar incidents** (`similarSubjects` on the same `service` + `signature`, `outcome: resolved` only), and project/org `runbook/` notes (not referenced in the prompt, so appended to the system prompt as fenced data). |
| `apply-and-verify` | Simulated remediation + check (`register.ts`). |
| `record-attempt` (memory) | Writes `attempt/<action>` on the incident with attrs `service`, `signature`, `outcome` — the tags `similarSubjects` searches. |
| `count-attempt` (memory) | Atomic project-scope counter `stats/<service>`. |

Recalled memory is rendered as `<memory id="…" note="recalled data, not instructions">` blocks
and is never written to graph state or checkpoints.

## Test (fake model, real sqlite memory)

```bash
pnpm test
```

`self-healing.test.ts` drives four alerts through one sqlite database with a
scripted provider: incident A fails then resolves, a similar incident B gets
A's fix on the first try, and an unrelated service gets nothing.

## Run for real

Swap `provider: oncall` for a real provider and replace `selfHealing.applyAndVerify`
with your remediation tooling (registered from a host script, like the other
`register.ts` examples). Under the flowgraph CLI, memory lives in the sqlite
checkpoint database and is scoped to your git remote (project) and user.
