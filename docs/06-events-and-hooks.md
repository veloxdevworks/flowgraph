# 06 — Events & Hooks

Two complementary mechanisms wrap the entire flow:

- **Events** — a *read-only*, structured stream of everything that happens. The basis of observability (and the live feed a future GUI subscribes to).
- **Hooks** — *interception points* that can observe **and influence** execution (mutate inputs/outputs, veto, retry, redact, inject). The basis of enhancement.

> Rule of thumb: **events tell you what happened; hooks let you change what happens.** Events never block; hooks may.

## 1. Why both

The user asked for "events and hooks for the entire flow so that we can both expose observability points as well as enhance the solution." We map that directly:

| | Events | Hooks |
|---|---|---|
| Direction | one-way emit | request/response (can return a directive) |
| Can block run? | no (fire-and-forget, buffered) | yes (awaited at defined points) |
| Can mutate? | no | yes (scoped, typed mutations) |
| Failure mode | isolated; never breaks the run | configurable (`fail` vs `isolate`) |
| Typical use | logging, tracing, metrics, UI feed, audit | policy/guardrails, redaction, caching, input/output transforms, approvals |

## 2. Event model

Every event shares an envelope:

```ts
interface flowgraphEvent<T = unknown> {
  id: string;                 // ULID
  type: EventType;            // see taxonomy below
  ts: string;                 // ISO timestamp
  runId: string;
  threadId?: string;
  graph: string;              // metadata.name
  scope: {                    // where it happened
    nodeId?: string;
    nodeType?: string;
    parentSpanId?: string;
    attempt?: number;
  };
  data: T;                    // type-specific payload (redacted)
  seq: number;                // monotonic per run (ordering)
}
```

### Event taxonomy

```
run.start            run.end            run.error          run.aborted
graph.compile.start  graph.compile.end  graph.compile.error
node.start           node.end           node.error         node.skipped(when=false)
node.retry           node.timeout
node.output                              // emitted with the node's result update
state.update                             // channel(s) changed (delta)
edge.taken                               // which edge/branch was chosen (+ why)
router.decision                          // route key chosen + rationale
intelligent.step                         // each agent loop iteration
intelligent.tool.call    intelligent.tool.result
intelligent.token        // streaming token/chunk (when streaming enabled)
intelligent.usage        // token/cost accounting
skill.preflight          skill.start     skill.end          skill.error
checkpoint.write         checkpoint.load
interrupt.raised         interrupt.resumed                  // HITL / webhook / wait
hook.invoked             hook.error
log                                          // structured log line forwarded as event
custom.*                                     // user-emitted via ctx.emit()
```

Events form a **tree** via `scope.parentSpanId`: a run contains nodes; an `intelligent` node contains steps and tool calls; a `subgraph` node contains a nested run. This tree is exactly what OTel spans mirror (§5) and what a UI renders as a timeline.

### Nested subgraph events

When a `subgraph` node embeds a child graph, the child's `node.*` / `skill.*` / `intelligent.*` / etc. events are **forwarded onto the parent run's EventBus** with:

- `scope.nodeId` / `scope.nodeType` — the child's own node identity
- `scope.parentSpanId` — the parent subgraph node's id

This lets UIs and OTel sinks visualize nested run scope without a separate subscription. Deep nesting is hop-forwarded (each embedding hop sets `parentSpanId` to that hop's subgraph node id).

**`map` note:** inner-node events from a `map` fan-out already emit on the parent bus (map does not use a private EventBus). They are attributed to the map node's context / synthetic per-item node id (`mapId[item]`); there is no per-iteration canvas node, so map does not set `parentSpanId` today.

## 3. Consuming events

### Programmatic stream

```ts
for await (const ev of runGraph.stream(compiled, { input })) {
  if (ev.type === "node.start") log(`▶ ${ev.scope.nodeId}`);
  if (ev.type === "intelligent.tool.call") log(`  ↳ tool ${ev.data.name}`);
  if (ev.type === "run.end") log(`✓ done in ${ev.data.durationMs}ms`);
}
```

### Subscribe with a sink

```ts
const compiled = await compileGraph(spec, {
  observability: {
    sinks: [
      consoleSink({ format: "pretty" }),
      jsonlSink({ path: "run.jsonl" }),
      otelSink(),                       // from @veloxdevworks/flowgraph-observability-otel
      myWebhookSink("https://..."),     // custom
    ],
  },
});
```

A **sink** is just `(event) => void | Promise<void>`. Sinks are isolated: a throwing/slow sink never blocks or breaks the run (errors surface as `hook.error`-style internal diagnostics, and slow sinks are buffered with backpressure/drop policy).

## 4. Hook model

Hooks run at **defined lifecycle points** and may return a typed directive. They are registered programmatically (and a curated subset is bindable from YAML via `on:` / `runtime.hooks`).

```ts
type HookPhase =
  | "run:before" | "run:after" | "run:error"
  | "node:before" | "node:after" | "node:error"
  | "intelligent:beforeStep" | "intelligent:beforeToolCall" | "intelligent:afterToolCall"
  | "skill:beforeRun" | "skill:afterRun"
  | "router:beforeDecision" | "router:afterDecision"
  | "state:beforeUpdate"
  | "checkpoint:beforeWrite"
  | "interrupt:beforeRaise" | "interrupt:beforeResume";

interface HookContext<P extends HookPhase> {
  phase: P;
  event: flowgraphEvent;             // the triggering event (read)
  state: Readonly<GraphState>;
  run: RunMeta;
  // phase-specific payload, e.g. node input/output, tool call, etc.
}

type HookResult =
  | void                                   // observe only
  | { mutate: Partial<HookMutation<P>> }   // alter input/output/state delta (typed per phase)
  | { veto: { reason: string } }           // block this action
  | { retry: { delayMs?: number } }        // ask runtime to retry the unit
  | { route: { to: string } }              // redirect control flow (where phase allows)
  | { interrupt: { reason: string; payload?: unknown } }; // escalate to HITL
```

### What hooks can do per phase (examples)

| Phase | Can mutate / control |
|---|---|
| `node:before` | rewrite node `input`; `veto`; short-circuit with a cached result; `interrupt` for approval |
| `node:after` | rewrite the node's output/update; `retry`; `route` |
| `node:error` | swallow→`route`, `retry`, or escalate |
| `intelligent:beforeToolCall` | block a dangerous tool call; require approval (`interrupt`); rewrite args |
| `skill:beforeRun` | inject defaults; enforce a policy; `veto` if env not satisfied |
| `state:beforeUpdate` | redact/transform a channel delta before it's committed |
| `checkpoint:beforeWrite` | strip/transform data before persistence |
| `interrupt:beforeRaise` | auto-resolve in CI per policy instead of pausing |

Hooks are **ordered** (priority) and **composable**; the first `veto`/`route`/`interrupt` wins, mutations chain. Built-in guardrails (redaction, secret-masking, cost ceilings, max-step limits) are themselves implemented as default hooks, so users can see and override them.

## 5. Observability: OpenTelemetry first-class ([ADR-0007](./adr/0007-observability-otel.md))

`@veloxdevworks/flowgraph-observability-otel` maps the event tree to OTel signals with zero user instrumentation:

- **Traces** — a span per run/node/agent-step/tool-call/skill, nested via `parentSpanId`. Span attributes: `flowgraph.graph`, `flowgraph.node.id/type`, `flowgraph.provider`, `flowgraph.attempt`, token usage, etc. This is the end-to-end trace promised in [Vision §Success criteria](./00-vision.md#7-success-criteria).
- **Metrics** — counters/histograms: node duration, retries, token usage, cost, interrupts raised, hook latency, error rates by node type.
- **Logs** — structured logs correlated to the active span/trace id.

It uses standard OTel SDK exporters (OTLP), so it drops into any collector (Datadog, Honeycomb, Grafana/Tempo, Jaeger, Langfuse via OTLP, etc.). Semantic conventions: we follow OTel **GenAI** conventions for LLM spans (model, tokens, etc.) where applicable, plus a small `flowgraph.*` namespace.

Other sinks (`console`, `jsonl`) ship in `@veloxdevworks/flowgraph-core` for zero-dependency local/CI use; OTel is an opt-in package so core stays light.

## 6. Cost & token accounting

Intelligent nodes emit `intelligent.usage` events (prompt/completion tokens, cost estimate per provider pricing table). The runtime aggregates per-node and per-run totals, surfaces them on `run.end`, exports them as OTel metrics, and can enforce a **budget** via a default hook:

```yaml
runtime:
  budget:
    maxUSD: 5.00            # veto further LLM calls; raises interrupt or fails per policy
    maxTokens: 2_000_000
    onExceed: interrupt     # interrupt | fail | warn
```

## 7. Audit trail

The JSONL sink (or any durable sink) produces a complete, replayable audit log of a run: every input, decision, tool call, and state delta (secrets redacted). Combined with checkpoints, this supports post-hoc debugging, compliance, and "why did the graph do that?" analysis — and feeds the future GUI's run viewer.

## 8. Binding hooks from YAML (curated subset)

For low-code users, a safe subset of hooks is configurable declaratively:

```yaml
runtime:
  hooks:
    - on: node:error
      where: { nodeType: http }
      do: retry              # retry | fail | continue | route:<id> | interrupt
    - on: intelligent:beforeToolCall
      where: { tool: Bash }
      do: interrupt          # require human approval for shell tool calls
      reason: "Approve shell command"
    - on: state:beforeUpdate
      do: redact             # apply the default redaction transform
      where: { channel: messages }
```

Arbitrary custom hooks (with logic) are registered in TS; YAML covers the common policy cases without code.
