# Self-improvement automation loop

Internal flowgraph graph that plans, implements, tests, reviews, and opens a **pull request** with one small improvement per cycle. It dogfoods the flowgraph Cursor provider twice: a Sonnet-class model for planning/review judgment, Composer for editing — both through the same `CURSOR_API_KEY`, no separate LLM vendor key needed.

> **Not a user-facing example.** This lives under `automation/` (not `examples/`) and is **not** documented on the public docs site.

## What it does

1. Checks `PAUSED` kill switch and open `automation`-labeled PRs
2. Loads repo context (`IMPLEMENTATION_STATUS`, recent commits, `STATE.md`, `GUARDRAILS.md`)
3. **Plans** one scoped improvement (or no-ops)
4. **Implements** via Cursor provider (`Read` / `Edit` / `Bash`)
5. Runs **quality gates** (`pnpm build/typecheck/test/lint`, or `format:check` for docs-only)
6. **Reviews** the diff; loops up to 3 attempts on failure
7. Opens a PR labeled `automation` (never pushes to `main` directly)
8. Appends a row to `STATE.md`

## Manual run (one cycle)

From the monorepo root (after `pnpm install && pnpm build`):

```bash
# Dry run — no git/gh/pnpm side effects, no STATE.md append
SELF_IMPROVE_DRY_RUN=1 pnpm --filter self-improve-automation run:dry

# Live run (requires CURSOR_API_KEY; GITHUB_TOKEN/GH_TOKEN or gh auth for PR create)
flowgraph run automation/self-improve/self-improve.graph.yaml \
  --thread self-improve-manual \
  --on-interrupt fail \
  --stream \
  --cwd automation/self-improve
```

Import `./register.ts` is wired via `imports: [{ reducers: ./register.ts }]` in the graph YAML (module load registers code functions).

## Pause / resume

Create `automation/self-improve/PAUSED` (any content) to skip cycles without disabling the Cursor Automation. Delete the file to resume.

## Tune cost and cadence

- **Per-run budget:** `runtime.budget.maxUSD` in `self-improve.graph.yaml` (default `3`)
- **Schedule:** set in the Cursor Automation cron trigger (see `AUTOMATION_SETUP.md`)
- **Attempt cap:** `increment-attempts` + branch on `state.attempts < 3` in the graph

## Tests

```bash
pnpm --filter self-improve-automation test
```

Uses scripted `planner` / `coder` providers and `SELF_IMPROVE_DRY_RUN=1` — no API keys.

## Guardrails

See [GUARDRAILS.md](./GUARDRAILS.md). Highlights:

- Improve published docs, but **never** mention this automation under `docs/`
- Do not edit `automation/self-improve/**`, CI workflows, LICENSE, or release config
- Wrap LangGraph; stay small and reversible

## Cursor Automation

See [AUTOMATION_SETUP.md](./AUTOMATION_SETUP.md) for the full checklist:

- **`CURSOR_API_KEY`** — required Secret (nested SDK does not inherit the Automation agent's auth)
- **`GITHUB_TOKEN`/`GH_TOKEN`** — recommended for `gh pr create` / REST fallback (GitHub App alone covers `git push`, not necessarily `gh`)
- **`.cursor/environment.json`** — `pnpm install` + `pnpm build` on cloud agent boot
