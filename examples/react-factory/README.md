# React factory (memory: project conventions + user preferences)

A front-end feature factory that stops re-learning the repo on every run.

| Node | What it does |
|------|--------------|
| `detect-conventions` | Simulated repo scan (`register.ts`): CSS approach, test runner, router. |
| `learn-conventions` (memory) | `patch` at **project** scope, key `conventions/frontend` — shared by every graph in the repo. |
| `build-feature` (agent) | Recalls `conventions/` (project + org, referenced as `{{ memory.conventions }}` in the prompt) and the requester's `prefs/` (user scope, unreferenced, so appended to the system prompt as fenced data) within an 800-token budget. `agentWrites: { scopes: [user] }` gives it a `remember` tool limited to the requester's own scope, 3 writes per run, keys under `prefs/`. |

## Test (fake model, real sqlite memory)

```bash
pnpm test
```

Alice asks for named exports once; the agent remembers it and her next build
follows it. Bob's builds share the project conventions but not Alice's preference.
A dependency change is patched into the conventions and the next build follows it.
