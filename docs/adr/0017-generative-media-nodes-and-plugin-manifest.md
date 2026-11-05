# ADR-0017 — Generative media nodes, artifact contract, and plugin manifest

- **Status:** Proposed
- **Date:** 2026-11-05
- **Builds on:** [0004-pluggable-providers.md](./0004-pluggable-providers.md), [0005-durability-and-hitl.md](./0005-durability-and-hitl.md)
- **Relates to:** [03 — Node types](../03-node-types.md) §10 (custom node plugins), [05 — State & data](../05-state-and-data.md) (artifacts)

## Context

flowgraph's built-in nodes cover orchestration (`agent`, `router`, `map`, `hitl`, …) and I/O (`http`, `mcp`, `shell`, `script`). They do not cover **generating media**: images, video, 3D assets. Users want these inside flows (for example, generate concept art, turn it into a mesh, hand the mesh to a later step). They also want to add vendors (Tripo, Meshy, and others) without waiting on the core team.

What exists today, and what is missing:

| Area | Today | Gap |
|---|---|---|
| Node plugins | `defineNode()` + `imports[].nodes` load third-party `NodeFactory`s into the registry. | The **desktop app cannot show them.** The palette is the hardcoded `BUILTIN_NODE_TYPES` (`flowgraph-desktop/packages/ui-graph/src/types.ts`) and every type has a hand-written form in `components/nodeForms/`. A plugin node runs from YAML but has no palette entry and no inspector. |
| Artifacts | `demo` nodes write files under `.flowgraph/demo/<nodeId>/`; state holds `path` + `mimeType` + `sizeBytes`, not blobs ([05](../05-state-and-data.md)). | No shared, typed contract. Each node invents its own shape, so nodes cannot reliably consume each other's output and the UI cannot preview generically. |
| Providers | `ProviderAdapter` is an **agent-loop** interface (tools, steps, messages). | Media generation is an async job (submit, poll, download), not an agent loop. Forcing it into `ProviderAdapter` would be the same mismatch [0016](./0016-workshop-node.md) rejected for voice. |
| Durability | `ctx.once(key, fn)` records a result in graph state so side effects do not re-fire on replay. `ctx.signal` carries abort. `RunContext.budget` tracks `maxUSD`/`usedUSD`. | Long jobs (video can take minutes) need resume-safe job handling and cost reporting. No helper exists. |
| Decisions | `router` has rules and model modes; `agent` supports structured output. | No cheap, typed, single-pass decision primitive with a confidence value. Non-generative decision models (for example TypeSafe AI's Jev) are a natural fit, but `ProviderAdapter` is the wrong shape for them. |

## Decision

### 1. A shared `Artifact` contract (core)

Every node that produces or consumes a file uses one shape. It lives in `@flowgraph/spec` so the desktop UI and plugins share it.

```ts
interface Artifact {
  kind: "artifact";
  path: string;            // workspace-relative
  mimeType: string;        // e.g. image/png, video/mp4, model/gltf-binary
  sizeBytes: number;
  role?: "image" | "video" | "model3d" | "audio" | "document" | "file";
  sha256?: string;
  meta?: {
    width?: number; height?: number; durationMs?: number;
    thumbnail?: string;    // workspace-relative path
    source?: { provider: string; model?: string; jobId?: string; prompt?: string };
    costUSD?: number;
  };
}
```

- Files are written under `<workspace>/.flowgraph/artifacts/<threadId>/<nodeId>/`. Scoping by thread prevents collisions across runs. State holds only the `Artifact` record, never bytes.
- `demo` output is aligned to this contract as a superset (it already carries `path`, `mimeType`, `sizeBytes`). Its legacy directory stays until a follow-up migrates it.
- Nodes that take media input accept an `Artifact`, a state reference to one, or a URL/path string. Reference inputs (image-to-video, image-to-3D) therefore chain without glue.
- The desktop previews by `role`/`mimeType` (image, video, GLB viewer) and falls back to a file card.

### 2. An async-job helper (core SDK)

A small helper that every media node uses, so none of them reimplement polling:

```ts
runJob(ctx, {
  key,                                  // stable per node + attempt-independent
  start:  () => Promise<JobHandle>,     // submit; wrapped in ctx.once(key)
  poll:   (h) => Promise<JobStatus>,    // queued | running | done | failed (+ progress)
  fetch:  (h) => Promise<ProviderOutput[]>,
  cancel?: (h) => Promise<void>,
})
```

- `start` runs inside `ctx.once`, so the **job handle is checkpointed** and a resume re-attaches to the in-flight job instead of submitting (and paying for) a second one.
- Polling uses backoff and honors `ctx.signal`; on abort it calls `cancel` best-effort.
- Progress is emitted as events so the desktop can show a progress bar.
- **Known gap:** if the process dies after the vendor accepts a job but before the handle is checkpointed, that job is orphaned and still billed. Adapters should pass a vendor idempotency key where one exists; otherwise the helper records a `ctx.issue()` on resume when it cannot prove no job was submitted.

### 3. A capability-keyed `MediaProvider` interface (separate from `ProviderAdapter`)

```ts
interface MediaProvider {
  name: string;
  capabilities: { image?: ImageCaps; video?: VideoCaps; model3d?: Model3dCaps };
  start(req: MediaRequest, ctx): Promise<JobHandle>;
  poll(h: JobHandle, ctx): Promise<JobStatus>;
  fetch(h: JobHandle, ctx): Promise<ProviderOutput[]>;
  cancel?(h: JobHandle, ctx): Promise<void>;
  estimateCostUSD?(req: MediaRequest): number | undefined;
}
```

- Vendors with a synchronous API implement `start` and return a handle that is already `done`.
- Declared in the graph via the existing `providers:` block with a new `kind: media` and a `vendor` field; plugin packages register adapters through `imports[].providers`. The `providers` schema in `@flowgraph/spec` needs this new kind.
- Credentials come from `ctx.secrets`, never from node config.

### 4. Three modality nodes (first-party, optional package)

Add node types **`image`**, **`video`**, and **`model3d`**, shipped in a new optional package `@flowgraph/nodes-media` (peer-depends on `@flowgraph/core`, like the provider packages). `model3d` rather than `3d` because a type name starting with a digit is awkward in YAML and code.

- Separate types, not one `generate` node with a `modality:` switch. The desktop has one form, icon and output preview per type, and the `with` surfaces differ.
- Shared `with` core: `provider`, `model`, `prompt`, `input` (reference artifacts), `count`, `params` (vendor passthrough), `output`. Modality-specific fields are added per node (for example `model3d.mode: text | image | multiview`).
- Output: one or more `Artifact`s at `state.outputs.<nodeId>`. When `count > 1`, `output.artifacts` is an array.
- Capabilities: `sideEffecting: true` (they spend money). Replay safety is via `runJob` and `ctx.once`.
- Cost: nodes report `estimateCostUSD` and actual cost into the run budget so `runtime.budget.maxUSD` covers media spend. **Open item:** confirm `BudgetState` can be updated from non-agent nodes, or extend it.

### 5. A typed-decision provider and `decide` node

- New `DecisionProvider` interface: `decide({ question, input, answer: choice(options) | score(range) | boolean }) → { value, confidence, usage }`. Single pass, no tool loop.
- Surfaces as a **`router` mode** (`mode: decision`, with a `minConfidence` and a fallback edge) and as a standalone **`decide`** node that writes `{ value, confidence }` to state.
- The contract is vendor-neutral. Jev is the first adapter, shipped as a plugin. A second adapter built on an LLM with structured output is required alongside it, as the baseline to compare against. Published claims about Jev's speed and accuracy are vendor-reported and not independently verified, so nothing in core depends on them.
- The intended pattern is escalation: a high-confidence decision routes straight through; a low-confidence one falls to an `agent` or `hitl` node using existing `when` guards.

### 6. A plugin manifest so the desktop can show plugin nodes

A plugin package declares its nodes and providers in a manifest (`flowgraph.plugin.json`, or a `flowgraph` key in `package.json`):

```jsonc
{
  "nodes": [{
    "type": "model3d",
    "label": "3D asset",
    "description": "Generate a 3D model from text or images",
    "category": "media",
    "icon": "box",                    // lucide icon name
    "color": "#8b5cf6",
    "configSchema": { /* JSON Schema, generated from the node's zod schema */ },
    "outputs": { "artifact": "model3d" }
  }],
  "providers": [{ "kind": "media", "vendor": "tripo", "label": "Tripo" }]
}
```

- The sidecar reads manifests from the plugins a graph imports and returns them to the UI. The palette merges them with `BUILTIN_NODE_TYPES`.
- The inspector renders a **generic form from `configSchema`**. Built-in types keep their bespoke forms. Plugins may later ship a richer form, but the generic one is the floor, so a plugin is never a second-class citizen.
- `flowgraph plugins list` shows installed plugins and their node types.
- **Trust:** a plugin is arbitrary code in the sidecar, with the same trust as `imports[].nodes` today. This ADR adds no sandbox. Plugin installation must be explicit and user-initiated, and supply-chain hardening stays on the existing security track in the [roadmap](../10-roadmap.md).

### 7. First-party versus plugin: the rule

> **Core (or a first-party package) owns contracts and anything that needs engine integration. Plugins own vendors, heavy dependencies, and fast-moving APIs.**

| Item | Where |
|---|---|
| `Artifact` contract, `runJob`, `MediaProvider`, `DecisionProvider`, plugin manifest | First-party (`@flowgraph/spec`, `@flowgraph/core`) |
| `image`, `video`, `model3d`, `decide` nodes | First-party optional package (`@flowgraph/nodes-media`) |
| Vendor adapters (Tripo, Meshy, image and video vendors, Jev) | Plugins, one package each (for example `@flowgraph/media-tripo`) |
| Local video inference (bundled tool, GPU, model weights) | Plugin; may wrap a managed process like the `service` node |
| Computer use | **Out of scope here; deferred.** Start as an agent tool or MCP server. It needs `permission: ask`, HITL gating and a desktop-only capability flag before it could be a node. |

## Consequences

- Image, video and 3D nodes chain by passing `Artifact`s, and the desktop can preview them without per-node code.
- Third parties can add a vendor by implementing `MediaProvider` and a manifest, with no core change.
- Resuming a run does not resubmit paid jobs, except in the narrow orphan window described in §2.
- The `providers` schema gains `kind: media`, and `EventType` gains job/progress events. Both are additive within `flowgraph/v1`.
- Desktop work is required: manifest ingestion in the sidecar, merged palette, generic schema form, artifact preview (image, video, GLB). Without it the engine side is usable only from YAML.
- Plugins widen the attack surface (see §6).

## Alternatives considered

| Option | Why not |
|---|---|
| Put media generation behind `ProviderAdapter` | Agent-loop interface; async jobs and cost-per-call do not fit (same reasoning as [0016](./0016-workshop-node.md) for voice) |
| One `generate` node with `modality:` | One bloated `with` schema, one inspector for three different UIs |
| Vendor-specific first-party nodes (`tripo`, `meshy`) | Core would churn with every vendor API change; downstream nodes would depend on the vendor, not the artifact |
| Plugins-only, no first-party media nodes | No out-of-the-box experience and no shared contract, so every vendor plugin reinvents the output shape |
| Skills or MCP servers for each vendor | Fine for agent-driven use, but a deterministic node needs durable job handling, cost reporting and a typed output that MCP calls do not provide |
| Store media as base64 in state | Every checkpoint copies the full value ([05](../05-state-and-data.md)); files plus references avoid that |

## Open questions

1. Which image and video vendors ship as the first reference adapters? Needs input from the people using them.
2. Can non-agent nodes write to `BudgetState`, or does it need extending?
3. Do we want `EventType` additions (`job.progress` and similar) or reuse `log`?
4. Plugin manifest location: standalone file or `package.json` key.
5. Artifact retention: when are `.flowgraph/artifacts/<threadId>/` directories cleaned up relative to checkpoint retention?
