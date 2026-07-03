# 00 — Vision & Scope

## 1. Problem

[LangGraph.js](https://langchain-ai.github.io/langgraphjs/) is a powerful, low-level engine for building stateful, multi-actor agent and automation graphs. But using it requires writing TypeScript: you wire `StateGraph` nodes and edges by hand, manage channels and reducers, wrap models, implement checkpointers, and bolt on your own observability. That power has a cost:

- **High barrier to entry.** Only engineers comfortable with LangGraph internals can author or change a workflow.
- **No standard packaging.** Every team reinvents project structure, config, secrets handling, retries, logging, and the "how do I run this in CI vs. locally" question.
- **Workflows are opaque.** Logic lives in imperative code, so non-authors (PMs, ops, reviewers) cannot read, audit, or safely tweak a flow.
- **Reusability is ad hoc.** A useful "step" (post to Slack, open a Jira ticket, run a codegen agent) is rarely portable across projects.

## 2. The idea

flowgraph is a thin, opinionated **packaging and authoring layer** over LangGraph.js. You describe a graph **declaratively in YAML**, reference reusable **skills** and **typed nodes**, and flowgraph compiles it into a real LangGraph `StateGraph` and runs it with batteries included: events, hooks, checkpointing, human-in-the-loop, and OpenTelemetry.

The same declarative artifact runs **headless in CI**, from a **CLI on a desktop**, or (in a future, separate project) behind a **GUI**. Because the workflow is data, not code, it can be generated — first by humans writing YAML (low-code), later by an agent or visual editor (no-code).

> **Our differentiator is not the engine. It is the low-code/no-code layer that packages the solution** so a graph can be authored, validated, shared, observed, and operated by anyone — from a platform engineer to (eventually) a non-technical author.

## 3. Who it is for

| Audience | How they use flowgraph |
|----------|--------------------|
| **Platform / automation engineers** | Author graphs in YAML, write custom nodes/skills in TS, run in CI. |
| **Application teams** | Compose existing skills/nodes into product workflows ("software factories"). |
| **Ops / SRE** | Operate graphs: observe via OTel, approve HITL steps, replay/resume. |
| **Eventually: non-technical authors** | Use a GUI/agent (separate project) that emits flowgraph YAML. |

## 4. Goals

1. **Declarative-first.** A graph is a validated YAML document. The YAML is the source of truth and the unit of sharing.
2. **Run anywhere.** One spec runs in CI (headless, non-interactive) and on a desktop CLI (interactive HITL), with no code changes — only config/runtime differences.
3. **Reusable units.** Skills and node types are portable, contract-bearing building blocks with declared environment dependencies and preflight checks.
4. **Intelligent + deterministic, side by side.** Agent nodes (Claude/Cursor) coexist with deterministic nodes (HTTP, webhook, code, router).
5. **Observable by default.** Every lifecycle moment emits a structured event and an OTel span; nothing requires custom instrumentation to see what happened.
6. **Extensible by design.** Events, hooks, a node registry, and a provider interface are all public extension points.
7. **Durable & resumable.** Long-running graphs (software factories, multi-day approvals) checkpoint and resume; humans can intervene.
8. **A genuine community standalone.** Quality, docs, and DX good enough that the OSS community adopts it independently of any GUI we build on top.

## 5. Non-goals (for this repository)

- **No GUI / visual editor.** Explicitly out of scope here. This repo produces the standalone engine + CLI the GUI will consume. (See [Architecture §"GUI boundary"](./01-architecture.md#9-the-gui-boundary).)
- **No new graph runtime.** We wrap LangGraph.js; we do not fork or reimplement scheduling, channels, or the pregel loop.
- **No model hosting / inference.** We adapt to existing SDKs/providers; we do not serve models.
- **No proprietary cloud control plane** (in this repo). Hosted/multi-tenant features, if ever built, live elsewhere and consume this library.
- **Not a general DAG/ETL scheduler.** flowgraph targets agentic + automation graphs; it is not Airflow/Temporal (though it can call into such systems via nodes).

## 6. Design principles

- **The engine is sacred.** Prefer composing LangGraph primitives over hiding them. Anything LangGraph can do should be reachable; flowgraph adds ergonomics, not walls.
- **Spec ⟶ code is a one-way compile.** YAML compiles to a `StateGraph`. We never round-trip arbitrary code back into YAML; the escape hatch is a typed `code`/custom node, not embedded scripting.
- **Make the easy things declarative, the hard things possible.** Common patterns are pure YAML. Complex logic is a registered TS node — still referenced declaratively by `type`.
- **Contracts over convention.** Skills and nodes declare typed inputs/outputs and env deps. Mismatches fail at validation/preflight, not at 2am in prod.
- **Observability is not optional plumbing.** Events and traces are part of the contract of running a graph.
- **Progressive disclosure.** A 10-line graph should be 10 lines. Power features (reducers, subgraphs, hooks, durability backends) appear only when needed.

## 7. Success criteria

flowgraph v1.0 is successful if:

- A new user can author and run a non-trivial multi-node graph **without writing TypeScript**, using built-in node types and published skills.
- The **same** spec runs unchanged in a GitHub Actions job and from a developer's laptop CLI.
- A graph author can add an **intelligent agent node** that calls **skills as tools** with three lines of YAML.
- Operators get **end-to-end OTel traces** of a run with zero custom instrumentation.
- A long-running graph can be **interrupted for human approval and resumed days later** from a durable checkpoint.
- A third party can publish a **reusable skill package** that others install and reference by name.

## 8. Guiding use cases (north stars)

1. **Issue triage bot (simple).** Webhook → summarize (agent) → router → open Jira ticket (skill) → notify Slack (skill). Runs in CI on issue events.
2. **Release notes factory (medium).** Collect merged PRs (HTTP) → group/classify (agent) → draft notes (agent) → human approval (HITL interrupt) → publish (skill).
3. **Software factory (complex).** Intake spec → plan (agent) → fan-out implementation subgraphs per task → run tests (code node) → router on results → agent fixes loop → human review gate → merge. Multi-hour, durable, resumable, fully traced.

These three span the complexity range the system must serve gracefully.

## 9. Naming

The project name is **flowgraph** — plain and descriptive (a graph of AI/automation nodes). It derives:

- npm scope: `@veloxdevworks/flowgraph-*` (e.g. `@veloxdevworks/flowgraph-core`, `@veloxdevworks/flowgraph-cli`)
- CLI binary: `flowgraph`
- spec token: `apiVersion: flowgraph/v1`
- env/config prefix: `FLOWGRAPH_*`; OTel attribute namespace: `flowgraph.*`

Before the first public release, verify package-name / GitHub repo availability and run a quick trademark sanity check; if a conflict forces a change it is a mechanical repo-wide rename. See [ADR-0013](./adr/0013-rename-to-flowgraph.md) (supersedes [ADR-0001](./adr/0001-naming.md)).
