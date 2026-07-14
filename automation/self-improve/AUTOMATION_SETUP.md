# Cursor Automation setup

Create this automation in the **Cursor Automations** editor after merging `automation/self-improve/` and [`.cursor/environment.json`](../../.cursor/environment.json) to `main`.

## What runs where

| Layer | What it does | Auth / deps |
|-------|----------------|-------------|
| **Cursor Automation** (driver) | Checks out repo, runs `flowgraph run …` | Cursor cloud agent + GitHub App (clone/push) |
| **flowgraph graph** (`self-improve.graph.yaml`) | Plan → implement → test → review → open PR | Nested `@cursor/sdk` calls need **`CURSOR_API_KEY`** in the subprocess env |
| **GitHub** | `git push` branch + open PR | GitHub App write access (push) + **`GITHUB_TOKEN`/`GH_TOKEN`** or `gh` (PR create) |

The Automation agent's own Cursor auth **does not** propagate into the nested `flowgraph run` process. Treat `CURSOR_API_KEY` as a required explicit Secret.

## One-time repo setup

1. **GitHub App** — Install Cursor's GitHub integration on `veloxdevworks/flowgraph` with **read/write** (clone + push branches). This is the "connection" in Cursor settings; it does **not** automatically install or log in `gh` in the shell.
2. **Cloud environment** — Commit [`.cursor/environment.json`](../../.cursor/environment.json). Cursor runs its `install` script on each agent boot (`corepack` + `pnpm install` + `pnpm build`). Optionally create a **snapshot** in the Cloud Agents dashboard after a successful boot and pin the snapshot id in `environment.json` for faster starts.
3. **`automation` label** — Create this label on the GitHub repo (or the first `gh pr create --label automation` will fail until it exists).

## Automation editor

### Trigger

- **Type:** Schedule (cron)
- **Suggested start:** once per day — `0 9 * * *` (09:00 UTC; adjust in the editor)

### Secrets (Automation → Environment → Secrets)

Add these as **Environment Variable** or **Runtime Secret** entries (Dashboard → Cloud Agents → Environments, or per-Automation secrets):

| Secret | Required? | Why |
|--------|-----------|-----|
| `CURSOR_API_KEY` | **Yes** | `provider-cursor` reads `process.env.CURSOR_API_KEY` inside the `flowgraph run` subprocess. User API key or team service-account key from [Cursor Dashboard → Integrations](https://cursor.com/dashboard/integrations). |
| `GITHUB_TOKEN` or `GH_TOKEN` | **Recommended** | `openPr` uses `gh pr create` when available; falls back to GitHub REST API with this token. Also used for `gh pr list` when checking open automation PRs. Fine-grained PAT or GitHub App installation token with `contents: write` + `pull_requests: write`. |
| `ANTHROPIC_API_KEY` | No | Not used — both planner and coder use `kind: cursor`. |

You do **not** need to enable Automation structured tools (`prComment`, `requestReviewers`, etc.) for this flow — PR creation is handled inside the flowgraph graph via shell/API.

### Driver prompt

Thin wrapper — model mixing happens inside the graph via `provider:` / `model:`.

```text
You maintain the veloxdevworks/flowgraph repository.

Preflight (fail fast with a clear report if anything is missing):
- test -n "$CURSOR_API_KEY" || { echo "Missing CURSOR_API_KEY secret"; exit 1; }
- pnpm --version && node --version
- git status
- (optional) gh --version && gh auth status; or test -n "$GITHUB_TOKEN" -o -n "$GH_TOKEN"

Then:
1. Ensure you are on the latest main branch with a clean working tree.
2. Run: pnpm install && pnpm build   # usually cached via .cursor/environment.json
3. Run:
   flowgraph run automation/self-improve/self-improve.graph.yaml \
     --thread self-improve-$(date +%F) \
     --on-interrupt fail \
     --stream \
     --cwd automation/self-improve
4. Summarize the outcome: PR URL, no-op reason, skip reason, runtime failure, or error.
5. Never push directly to main — the graph opens PRs only.
```

Use a **cheap/auto** model for this driver; Sonnet 5 and Composer are selected inside the graph.

### Model id

Confirm the planner model string against your account (`Cursor.models.list()` or the model picker). Update `providers.planner.model` in `self-improve.graph.yaml` if `sonnet-5` is not the exact catalog id.

## Manual smoke test (before enabling cron)

From your laptop (with keys in env):

```bash
export CURSOR_API_KEY=...
export GITHUB_TOKEN=...   # or gh auth login

pnpm install && pnpm build
flowgraph run automation/self-improve/self-improve.graph.yaml \
  --thread self-improve-smoke \
  --on-interrupt fail \
  --stream \
  --cwd automation/self-improve
```

Dry run (no git/gh/model spend on side effects):

```bash
SELF_IMPROVE_DRY_RUN=1 pnpm --filter self-improve-automation run:dry
```

## Pause without deleting the automation

Merge or create `automation/self-improve/PAUSED` on `main`. The graph exits before any LLM calls.

## Notes

- PRs are labeled `automation` and include `Automated-by: self-improve-loop` in commits.
- If an open `automation` PR already exists, the cycle skips to avoid pile-up.
- Per-run spend is capped by `runtime.budget.maxUSD` in the graph YAML.
- `check-runtime` node fails the cycle early if `CURSOR_API_KEY` is missing (records `runtime-failed` in `STATE.md`).
