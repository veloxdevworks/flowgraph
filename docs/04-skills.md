# 04 — Skills

A **skill** is a portable, contract-bearing, environment-aware unit of capability. It is the reusable building block that makes flowgraph graphs composable across projects and teams. Skills are referenced by `skill` nodes ([03 §2](./03-node-types.md#2-skill--invoke-a-declared-skill)) and exposed as tools to `agent` nodes ([03 §1](./03-node-types.md#1-agent--llm-agent-node-hub--spoke)).

Skills deliberately mirror the familiar **`SKILL.md` = YAML front-matter + Markdown body** format (as used by the Claude Agent SDK and Cursor skills), so existing skill authors feel at home and so an agent can read a skill's body as instructions.

## 1. Anatomy

```
skills/
└── create-jira-bug/
    ├── SKILL.md            # required — front-matter (contract + env) + body (instructions)
    ├── handler.ts          # optional — executable handler (kindOf: executable)
    └── assets/             # optional — templates, prompts, fixtures
```

A skill can also be a **single `SKILL.md`** with everything inline (for `kindOf: command`). Directory form is for skills with code/assets.

## 2. `SKILL.md` front-matter

Front matter is YAML only. The opening fence is `---`, or `---yaml` / `---yml`. Any other engine, including `---js`, is rejected when the skill is loaded (`SKILL_FRONT_MATTER_ERROR`) and is not evaluated.

````markdown
---
apiVersion: flowgraph/v1
kind: Skill
name: create-jira-bug
version: 0.2.0
description: >
  Create a Jira bug ticket from a summary and return its key/url.
labels: { domain: jira }

kindOf: executable              # executable | command  (see §3)

# --- the contract: each input / output is a JSON Schema (draft-07) ---
inputs:
  project:  { type: string, required: true, description: "Jira project key, e.g. PLAT" }
  summary:  { type: string, required: true, maxLength: 255 }
  priority: { type: string, enum: [low, medium, high], default: medium }
  labels:   { type: array, items: { type: string } }
outputs:
  key: { type: string, description: "Created issue key, e.g. PLAT-123" }
  url: { type: string }

# --- environment dependencies (drives preflight) ---
env:
  vars:                         # required environment variables (secrets resolved at runtime)
    - name: JIRA_BASE_URL
    - name: JIRA_EMAIL
    - name: JIRA_TOKEN
      secret: true              # redacted everywhere; never checkpointed
  bin:                          # executables that must be on PATH
    - { name: git, optional: true }
  node: ">=20"                  # optional engine constraint

# --- execution config for this skill kind ---
handler: ./handler.ts           # for kindOf: executable
# command: ["python", "create.py"]   # for kindOf: command

timeout: 60s                    # enforced at runtime (SKILL_TIMEOUT)
---

# Create Jira Bug

When invoked, create a Jira **bug** in `{{ inputs.project }}` with the given
`{{ inputs.summary }}`. Return the issue key and URL.
````

### Field reference

| Field | Meaning |
|---|---|
| `name` | Skill identifier (unique within its package/namespace). |
| `version` | Semver of the skill; enables pinning when published. |
| `description` | Human-readable summary; also used as the tool description when exposed to an `agent` node. |
| `kindOf` | How the skill executes — `executable` or `command` (see §3). |
| `inputs` / `outputs` | The **contract**: a map of name → JSON Schema (draft-07), the same [data contract](./05-state-and-data.md#data-contracts-json-schema) dialect as hitl forms and agent output. Each input value is checked against its schema before the skill runs, and declared `outputs` are checked against the return value after it runs (`SKILL_OUTPUT_INVALID`). An input's `required: true` means the caller must pass it (default `false`); a `required: [a, b]` list keeps its JSON Schema meaning for an object-typed input. |
| `env.vars` | Required env vars; `secret: true` ⇒ resolved via SecretProvider + redacted. A `command` skill's process receives the default host allowlist (`PATH`, `HOME`, temp and locale variables), its `env.vars`, and `FLOWGRAPH_INPUT`; a `secret: true` var reaches it only when the graph lists the name under top-level `secrets:`. |
| `env.bin` | Required executables on PATH (with `optional`). `name` is one executable name — letters, digits, `.`, `_`, `+` or `-` — not a path or a shell command. Preflight looks it up with `which` / `where` and no shell. |
| `env.node` | Optional Node.js version constraint (e.g. `>=20`) checked during preflight. |
| `handler` / `command` | Execution target per `kindOf`. `handler` paths must stay inside the skill directory. |
| `timeout` | Duration string (e.g. `30s`, `2m`) enforced at runtime. Aborts the handler's `ctx.signal` / kills the command child and fails with `SKILL_TIMEOUT`. |

## 3. Skill kinds

| `kindOf` | Executes by | Use for |
|---|---|---|
| `executable` | Calling a JS/TS default-exported `handler(input, ctx)` from `handler` | Reusable logic with direct access to `NodeRunContext` (`emit`, `signal`, `workspace`, `config`, `meta`) |
| `command` | Spawning a process (`command:`), writing JSON-encoded input to **stdin** and setting `FLOWGRAPH_INPUT`, and parsing stdout as JSON (or falling back to raw text) | Wrapping existing CLIs/scripts in any language |

`agent` and `composite` are reserved: a skill that declares either fails to load (`SKILL_SCHEMA_ERROR`: `kindOf "agent" is not supported`). For judgment tasks, use an `agent` node; for multi-step bundles, use a subgraph.

### `executable` handler signature

An executable skill module exports a default function (or named `handler`) taking the validated `input` object and the node's `NodeRunContext`:

```ts
import type { NodeRunContext } from "@flowgraph/core";

export default async function handler(
  input: { project: string; summary: string; priority?: "low" | "medium" | "high" },
  ctx: NodeRunContext,
): Promise<{ key: string; url: string }> {
  const base = process.env["JIRA_BASE_URL"] ?? "";
  const token = process.env["JIRA_TOKEN"] ?? "";
  const res = await fetch(`${base}/rest/api/3/issue`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: { project: { key: input.project }, summary: input.summary },
    }),
    signal: ctx.signal,
  });
  const body = (await res.json()) as { key: string };
  ctx.emit("custom.jira.created", { key: body.key });
  return { key: body.key, url: `${base}/browse/${body.key}` };
}
```

`ctx` is the runtime `NodeRunContext` providing `emit`, `signal` (aborted on skill or node timeout), `workspace`, `config`, `meta`, `store`, and `memory`.

### `command` skill input & output

For `kindOf: command`, the runtime spawns `command[0]` with `command.slice(1)` (no OS shell), writes the JSON-serialized input object to the child's **stdin** (closing stdin after writing), and also sets the `FLOWGRAPH_INPUT` environment variable to the same JSON string. Standard output is parsed as JSON when valid (or returned as trimmed text otherwise), then validated against `outputs` if declared.

On Unix, the command runs in its own process group (`detached: true`), so a terminal `Ctrl-C` (`SIGINT`) does not reach it directly. When a run is cancelled or the skill times out, Flowgraph stops the process group (`SIGTERM`, then `SIGKILL` after the stop grace period) so child and grandchild processes exit cleanly.

## 4. Contracts & validation

Each entry under `inputs` / `outputs` is a JSON Schema (draft-07) — the same [data contract](./05-state-and-data.md#data-contracts-json-schema) dialect as node `schema:` blocks. They are checked at three points:

1. **Load time** — every declaration must be a valid contract schema. An unknown keyword, an unknown `format`, `type: any` or a boolean `required` nested inside a schema fails the skill with `SKILL_SCHEMA_ERROR`.
2. **Runtime (pre)** — before the skill runs, a missing `required: true` input is an error, and each input that is present is validated against its schema; invalid input fails before any side effects run.
3. **Runtime (post)** — when `outputs` is declared, the return value must be an object containing every declared output key and each value must match its JSON Schema; mismatches fail with `SKILL_OUTPUT_INVALID`.

## 5. Preflight & environment checks

Because skills declare `env`, flowgraph can answer **"is this environment set up to run this node?"** before (and independently of) execution.

- `flowgraph skills doctor` / `flowgraph validate --preflight` walks every referenced skill and checks: required env vars present, secret vars resolvable, `bin` on PATH (one executable name, looked up with `which` / `where` and no shell), and `node` engine satisfied.
- Results are reported as a table; missing **required** deps are errors, missing **optional** deps are warnings.
- Preflight runs automatically before a skill executes so a run fails fast if the environment can't satisfy it.
- The check is also exposed programmatically (`preflightSkill(skill) => PreflightResult`) so hosts and UIs can show readiness per node.

Example output:

```
$ flowgraph skills doctor ./triage.graph.yaml
Skill                Env                         Status
create-jira-bug      JIRA_BASE_URL ✓             ok
                     JIRA_EMAIL    ✓
                     JIRA_TOKEN    ✓ (secret)
post-to-slack        SLACK_TOKEN   ✗ missing      ERROR
run-tests            git           ✓
                     node >=20     ✓ (v22.3.0)    ok

1 error — set SLACK_TOKEN to run `post-to-slack`.
```

## 6. Resolution & distribution

Skills are referenced by `uses:` (on a `skill` node) or `imports[].skill`, resolved in order:

1. **Alias** declared in `imports` (`as: file-bug`).
2. **Relative/absolute path** to a `SKILL.md` or skill directory (`./skills/create-jira-bug`).
3. **npm package** — a published skill pack (`@acme/skills/post-to-slack`). A skill pack is a normal package exporting one or more skills via an index; versioning/pinning use npm semver.

A **skill pack** package layout:

```
@acme/skills/
├── package.json          # "flowgraph": { "skills": ["./post-to-slack", "./create-jira-bug"] }
├── post-to-slack/SKILL.md
└── create-jira-bug/SKILL.md
```

This gives a path to a community skill ecosystem without inventing a new registry (npm is the registry).

## 7. Skills as agent tools

When a skill is listed under an `agent` node's `with.tools` (for example `{ skill: create-jira-bug }`), flowgraph loads the skill and builds its provider `ToolSpec` from the skill's front matter:

- The tool's **name** and **description** come from the skill's `name` and `description`.
- The tool's **input schema** is a JSON Schema `object` built from the skill's `inputs` contract (with `required` populated from inputs marked `required: true`), so the model calls it with valid arguments.
- Invocation runs the skill through the normal runtime (`runSkill`: preflight, input validation, `timeout`, output validation, and events) and returns the result to the agent.
- Gate specific skill tool calls with `permission: ask` or `runtime.hooks` on `agent:beforeToolCall`.

This is the hub-and-spoke pattern in practice: the agent is the hub, skills/nodes are the spokes, and the contract + preflight keep those calls safe.

## 8. Authoring guidelines

- Keep a skill **single-purpose** and **idempotent** where possible.
- Declare **every** env dependency (`env.vars`, `env.bin`, `env.node`) — this is what makes preflight trustworthy.
- Declare `inputs` and `outputs` schemas so callers, agent tools, and runtime validation enforce the contract.
- Set `timeout` on skills that perform network or subprocess work so stalled calls fail promptly with `SKILL_TIMEOUT`.
- Version skills; treat the contract (`inputs`/`outputs`) as a public API — breaking changes bump the major.
