# 04 — Skills

A **skill** is a portable, contract-bearing, environment-aware unit of capability. It is the reusable building block that makes flowgraph graphs composable across projects and teams. Skills are referenced by `skill` nodes ([03 §2](./03-node-types.md#2-skill--invoke-a-declared-skill)) and exposed as tools to `agent` nodes ([03 §1](./03-node-types.md#1-intelligent--agent-node-hub--spoke)).

Skills deliberately mirror the familiar **`SKILL.md` = YAML front-matter + Markdown body** format (as used by the Claude Agent SDK and Cursor skills), so existing skill authors feel at home and so an agent can read a skill's body as instructions.

## 1. Anatomy

```
skills/
└── create-jira-bug/
    ├── SKILL.md            # required — front-matter (contract + env) + body (instructions)
    ├── handler.ts          # optional — executable handler (kind: executable)
    ├── schema.input.json   # optional — externalized input schema ($ref-able)
    └── assets/             # optional — templates, prompts, fixtures
```

A skill can also be a **single `SKILL.md`** with everything inline. Directory form is for skills with code/assets.

## 2. `SKILL.md` front-matter

````markdown
---
apiVersion: flowgraph/v1
kind: Skill
name: create-jira-bug
version: 0.2.0
description: >
  Create a Jira bug ticket from a summary and return its key/url.
labels: { domain: jira }

kind_of: executable            # executable | command  (see §3)

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
  network: true                 # requires outbound network
  node: ">=20"                  # optional engine constraint
  packages:                     # optional npm deps the handler needs (for executable kind)
    - "@atlassian/jira-client@^8"

# --- execution config for this skill kind ---
handler: ./handler.ts           # for kind_of: executable
# command: ["python", "create.py"]   # for kind_of: command

timeout: 60s
sideEffecting: true             # affects retry/replay safety
permissions:                    # optional declared capability surface (informational + enforced where possible)
  - network:jira
---

# Create Jira Bug

When invoked, create a Jira **bug** in `{{ inputs.project }}` with the given
`{{ inputs.summary }}`. Return the issue key and URL.

> The Markdown body is human documentation **and** the instruction text passed
> to the model when this skill is used as an agent tool.
````

### Field reference

| Field | Meaning |
|---|---|
| `name` | Skill identifier (unique within its package/namespace). |
| `version` | Semver of the skill; enables pinning when published. |
| `kind_of` | How the skill executes — see §3. |
| `inputs` / `outputs` | The **contract**: a map of name → JSON Schema (draft-07), the same [data contract](./05-state-and-data.md#data-contracts-json-schema) dialect as hitl forms and agent output. Each input value is checked against its schema before the skill runs. An input's `required: true` means the caller must pass it (default `false`); a `required: [a, b]` list keeps its JSON Schema meaning for an object-typed input. |
| `env.vars` | Required env vars; `secret: true` ⇒ resolved via SecretProvider + redacted. |
| `env.bin` | Required executables on PATH (with `optional`). |
| `env.network` | Whether outbound network is needed (preflight can fail in offline CI). |
| `env.node` / `env.packages` | Engine + npm deps for executable skills. |
| `handler` / `command` | Execution target per `kind_of`. |
| `sideEffecting` | If true, the runtime treats retries/replays carefully (idempotency). |
| `permissions` | Declared capability surface (informational; enforced where the runtime can). |

## 3. Skill kinds

| `kind_of` | Executes by | Use for |
|---|---|---|
| `executable` | Calling a TS `handler(input, ctx)` exported from `handler.ts` | Most reusable logic; full typing & ctx (secrets, http, logger) |
| `command` | Spawning a process (`command:`), passing input as JSON on stdin/env, parsing stdout | Wrapping existing CLIs/scripts in any language |

`agent` and `composite` are reserved: a skill that declares either fails to load (`SKILL_SCHEMA_ERROR`: `kind_of "agent" is not supported`). For judgment tasks, use an `agent` node with the skill's instructions as its prompt; for multi-step bundles, use a subgraph.

### `executable` handler signature

```ts
import type { SkillHandler } from "@flowgraph/skills";

const handler: SkillHandler<
  { project: string; summary: string; priority: "low" | "medium" | "high" },
  { key: string; url: string }
> = async (input, ctx) => {
  const token = await ctx.secrets.get("JIRA_TOKEN");        // never logged
  const base  = ctx.env.get("JIRA_BASE_URL");
  const res = await ctx.http.post(`${base}/rest/api/3/issue`, {
    headers: { Authorization: `Bearer ${token}` },
    json: { /* ...build payload from input... */ },
  });
  ctx.logger.info("created jira issue", { key: res.body.key });
  return { key: res.body.key, url: `${base}/browse/${res.body.key}` };
};

export default handler;
```

`ctx` provides: `secrets`, `env`, `http` (instrumented + redacted), `logger`, `emit` (custom events), `signal` (abort), `workspace` (scratch dir), and `interrupt()` (request HITL). It is the **only** way side-effects reach the outside world, which is what makes them observable/redactable.

## 4. Contracts & validation

Each entry under `inputs` / `outputs` is a JSON Schema (draft-07) — the same [data contract](./05-state-and-data.md#data-contracts-json-schema) dialect as node `schema:` blocks. They are checked at two points:

1. **Load time** — every declaration must be a valid contract schema. An unknown keyword, an unknown `format`, `type: any` or a boolean `required` nested inside a schema fails the skill with `SKILL_SCHEMA_ERROR`.
2. **Runtime (pre)** — before the skill runs, a missing `required: true` input is an error, and each input that is present is validated against its schema; invalid input ⇒ node error (no side effects).

`outputs` describe the result for readers, editors and agent tools; the return value is not validated against them.

A skill's declared `outputs` are its documented promise to the graph; keep them accurate, since agent tools and editors read them.

## 5. Preflight & environment checks

Because skills declare `env`, flowgraph can answer **"is this environment set up to run this node?"** before (and independently of) execution.

- `flowgraph skills doctor` / `flowgraph validate --preflight` walks every referenced skill and checks: required env vars present, secret vars resolvable, `bin` on PATH, `node` engine satisfied, network availability (if required), and `packages` installed (for executable skills).
- Results are reported as a table; missing **required** deps are errors, missing **optional** deps are warnings.
- Preflight runs automatically at compile time (cheap checks) and is **deep-checked at run start** so a graph fails fast — *before* doing partial work — if the environment can't satisfy a downstream skill.
- The check is also exposed programmatically (`checkSkillEnv(skill, ctx) => Diagnostics`) so the future GUI can show green/red readiness per node.

Example output:

```
$ flowgraph skills doctor ./triage.graph.yaml
Skill                Env                         Status
create-jira-bug      JIRA_BASE_URL ✓             ok
                     JIRA_EMAIL    ✓
                     JIRA_TOKEN    ✓ (secret)
post-to-slack        SLACK_TOKEN   ✗ missing      ERROR
                     network       ✓
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

This gives us a path to a community skill ecosystem without inventing a new registry (npm is the registry).

## 7. Skills as agent tools

When a skill is listed under an `agent` node's `with.tools`, flowgraph wraps it as a provider tool:

- The tool's **name/description** come from the skill's `name`/`description`.
- The tool's **input schema** is the skill's `inputs` contract (so the model calls it with valid args).
- Invocation runs the skill through the normal runtime (events/traces/contract validation), and the result is returned to the agent.
- `sideEffecting` skills can require `permission: ask`, turning a tool call into a HITL approval.

This is the hub-and-spoke pattern in practice: the agent is the hub, skills/nodes are the spokes, and the contract + preflight keep those calls safe.

## 8. Authoring guidelines

- Keep a skill **single-purpose** and **idempotent** where possible; declare `sideEffecting: true` honestly.
- Declare **every** env dependency — this is what makes preflight trustworthy.
- Prefer **typed `outputs`** over free-form text so downstream nodes/routers can rely on structure.
- Write the Markdown body as if instructing a capable teammate; when the skill is an agent tool it *is* the instruction.
- Version skills; treat the contract (`inputs`/`outputs`) as a public API — breaking changes bump the major.
