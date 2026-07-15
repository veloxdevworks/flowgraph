# 16 — Agent Definitions

A reusable **agent definition** is a named system prompt stored as an `AGENT.md` file (YAML front-matter + Markdown body). Agent nodes reference it via `with.agent`, and the body becomes the node's system prompt at run time — similar to how skill nodes resolve `uses:` to a `SKILL.md`.

Unlike skills, agent definitions are **prompt-only** in v1: they do not declare handlers, tools, models, or inputs. Model, tools, and permission stay on the agent **node**.

## 1. Anatomy

```
agents/
└── code-reviewer/
    └── AGENT.md            # required — front-matter + body (system prompt)
```

## 2. `AGENT.md` front-matter

````markdown
---
apiVersion: flowgraph/v1
kind: Agent
name: code-reviewer
description: Reviews diffs for bugs, clarity, and regressions.
---

You are a careful code reviewer.
Focus on correctness, edge cases, and clear feedback.
Prefer concrete suggestions over vague praise.
````

| Field | Required | Notes |
|-------|----------|-------|
| `name` | yes | Stable identifier shown in UIs |
| `description` | no | Short summary for library listings |
| `apiVersion` / `kind` | no | Optional metadata (`flowgraph/v1`, `Agent`) |

The Markdown body **is** the system prompt. It supports the same expression templating as inline `system` / `prompt` (`{{ state.* }}`, `{{ input.* }}`, etc.).

## 3. Referencing from an agent node

```yaml
nodes:
  - id: review
    type: agent
    provider: claude
    with:
      agent: ./agents/code-reviewer   # path, bare path, alias, or package
      system: "Keep feedback under 10 bullets."  # optional; appended after AGENT.md body
      prompt: "Review this diff:\n{{ state.diff }}"
```

When both `agent` and `system` are set, the effective system prompt is:

```
<AGENT.md body>

<node-level system>
```

## 4. Resolution order

Same algorithm as skills ([04 — Skills](./04-skills.md)):

1. **Alias** from `imports: [{ agent: ..., as: ... }]` or programmatic `RunConfig.agents`
2. **Relative / absolute path** (`./agents/foo`, `/abs/path`, `agents/foo`)
3. **npm package** (`@scope/agent-foo`) if the path does not resolve

```yaml
imports:
  - agent: ./agents/code-reviewer
    as: reviewer

nodes:
  - id: review
    type: agent
    with:
      agent: reviewer
      prompt: "..."
```

## 5. Preflight

`flowgraph validate --preflight` and `flowgraph run` resolve every top-level `with.agent` reference and fail early if `AGENT.md` is missing or its front-matter is invalid.
