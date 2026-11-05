# ADR-0017 — Generative media nodes, artifact contract, and node-type metadata

- **Status:** Proposed (engine implemented in the same change; see [Implementation notes](#implementation-notes))
- **Date:** 2026-11-05
- **Builds on:** [0004-pluggable-providers.md](./0004-pluggable-providers.md), [0005-durability-and-hitl.md](./0005-durability-and-hitl.md)
- **Relates to:** [03 — Node types](../03-node-types.md) §9d and §10 (custom node plugins), [05 — State & data](../05-state-and-data.md) (artifacts), [08 — Providers](../08-providers.md) (media providers)

## Context

flowgraph's built-in nodes cover orchestration (`agent`, `router`, `map`, `hitl`, …) and I/O (`http`, `mcp`, `shell`, `script`). They do not cover **generating media**: images, video, 3D assets. Users want these inside flows (for example: concept art, turn it into a mesh, hand the mesh to a later step), and want to add vendors (Tripo, Meshy, Grok Imagine, OpenAI image generation, local tools) without waiting on the core team.

What existed, and what was missing:

| Area | Before | Gap |
|---|---|---|
| Node plugins | `defineNode()` + `imports[].nodes` load third-party `NodeFactory`s into the registry. | The **desktop app could not show them.** The palette is hardcoded (`BUILTIN_NODE_TYPES`) and every type has a hand-written form. A plugin node ran from YAML but had no palette entry and no inspector. |
| Artifacts | `demo` nodes write files under `.flowgraph/demo/<nodeId>/`; state holds `path` + `mimeType` + `sizeBytes`. | No shared, typed contract, so nodes cannot reliably consume each other's output and the UI cannot preview generically. |
| Providers | `ProviderAdapter` is an **agent-loop** interface (tools, steps, messages). | Media generation is an async job (submit, poll, download). Forcing it into `ProviderAdapter` would be the same mismatch [0016](./0016-workshop-node.md) rejected for voice. |
| Credentials | A graph declares `providers: { grok: { kind: langchain, vendor: xai } }` once. | A user who configured xAI for LLMs must not have to configure xAI **again** for images, and OpenAI likewise. |
| Durability | `ctx.once(key, fn)` records results in graph state so side effects do not re-fire on replay. | **`ctx.once` is persisted only when the node returns.** A crash halfway through a multi-minute job loses the record, and the resumed node submits (and pays for) a second job. |
| Decisions | `router` has rules and model modes; `agent` has structured output. | No cheap, typed, single-pass decision primitive with a confidence value (for example TypeSafe AI's Jev). |

## Decision

### 1. A shared `Artifact` contract (`@flowgraph/spec`)

Every node that produces or consumes a file uses one shape. It lives in the spec package so the desktop UI and plugins share it.

```ts
interface Artifact {
  kind: "artifact";
  path: string;            // workspace-relative, posix separators
  mimeType: string;        // image/png, video/mp4, model/gltf-binary, ...
  sizeBytes: number;
  role?: "image" | "video" | "model3d" | "audio" | "document" | "file";
  sha256?: string;
  meta?: {
    width?: number; height?: number; durationMs?: number;
    thumbnail?: string;
    source?: { provider: string; vendor?: string; model?: string; jobId?: string; prompt?: string };
    costUSD?: number;
  };
}
```

- Files are written under `<workspace>/.flowgraph/artifacts/<threadId>/<nodeId>/`. Scoping by thread prevents collisions across runs. State holds only the record, never bytes. File names are deterministic per job, so re-collecting a job overwrites instead of duplicating.
- Reference inputs accept an `Artifact`, a media node's whole output, a `{ path }` / `{ url }` object (a `demo` node's output works), a workspace path, an http(s) URL, or a `data:` URI. Image-to-video and image-to-3D therefore chain with no glue.
- `demo` keeps its own directory for now; migrating it onto this contract is a follow-up.

### 2. Durable jobs: a write-ahead journal, not `ctx.once`

Every media job runs through `runMediaJob`:

1. Read the job journal (`.flowgraph/jobs/<thread>/<node>-<fingerprint>.json`). The fingerprint hashes the provider, model, prompt, inputs' identities and parameters, so the same request in the same thread is the same job.
2. A `done` entry whose files still exist is **reused** (no vendor call, no cost charged). A `submitted` entry is **re-attached** (poll/fetch, no new submit).
3. Otherwise `start` submits the job and the handle is written to the journal **immediately**, before any polling.
4. Poll with backoff (default 2s growing to 10s, or the provider's hint), honoring `ctx.signal`. Progress is emitted as `custom.media.job` events.
5. `failed` / `canceled` clears the journal (a retry submits fresh). **Timeout leaves the journal** and the vendor job running, so a retry re-attaches. **Abort** calls the provider's `cancel` best-effort and clears the journal.
6. Collected artifacts are written to the journal as `done`.

Reported or estimated cost is charged to the run budget (`runtime.budget.maxUSD`) only when the job actually ran in this invocation.

**Remaining window:** a crash between the vendor accepting a job and the journal write finishing (milliseconds) orphans a billed job. Adapters should send a vendor idempotency key derived from the fingerprint where the vendor supports one.

### 3. A capability-keyed `MediaProvider`, configured through the existing `providers:` block

```ts
interface MediaProvider {
  name: string; vendor: string;
  modalities: ("image" | "video" | "model3d")[];
  maxPerJob?: Partial<Record<Modality, number>>;      // node splits larger counts
  pollIntervalMs?: number;
  start(req, ctx): Promise<JobHandle>;                 // sync vendors return { id, done: Artifact[] }
  poll?(handle, ctx): Promise<JobStatus>;
  fetch?(handle, ctx): Promise<Artifact[]>;            // via ctx.saveOutput
  cancel?(handle, ctx): Promise<void>;
  estimateCostUSD?(req): number | undefined;
}
```

- **Configure credentials once.** A `langchain` entry whose vendor has a registered media factory (`xai`, `openai`) **also** serves media under the same name, reusing its `apiKeyEnv` and `baseUrl`. The LLM `model` is not forwarded (it is not a media model).
- **Dedicated backends** use a new `kind: media` provider entry (`vendor`, `model`, `baseUrl`, `apiKeyEnv`, `options`). `vendor` is a free string, so third parties register their own.
- The key is resolved **at call time** through the run's secret provider (`env`/`dotenv`, redaction applies), never baked into the adapter.
- Derived from `spec.providers` inside `compileGraph`, so no CLI/server wiring is needed beyond skipping `kind: media` in the agent-provider builders. Plugins register vendors with `registerMediaVendor()` (or ready providers with `registerMediaProvider()`) from a module loaded via `imports[].providers`.
- Node resolution order: node `provider:` → `config.defaults.provider` if it can do the modality → the only provider that can → an error listing candidates. A bare vendor name (`provider: xai`) works with the vendor's default key env var.

### 4. Three modality nodes, built into core

Add node types **`image`**, **`video`**, **`model3d`** and **`audio`**. Separate types, not one `generate` node with a `modality:` switch: the desktop has one icon, form and preview per type and the `with` surfaces differ. They share one implementation. `model3d` rather than `3d` because a type name starting with a digit is awkward in YAML and code.

They are **built into `@flowgraph/core`** (revised from the first draft, which proposed an optional package): the nodes depend only on the contracts above and carry no heavy dependency. The dependencies live in the vendor adapters, which are separate. Built-in nodes also give every user the palette entries and bespoke inspectors with no install step.

Common `with`: `prompt`, `input`, `count`, `seed`, `negativePrompt`, `params` (vendor passthrough), `timeout`, `output`. Modality fields: image `size`/`aspectRatio`/`quality`; video `duration`/`aspectRatio`/`resolution`; model3d `mode`/`format`/`texture`/`quality`; audio `kind` (`speech` | `sfx` | `music`), `text`, `voice`, `language`, `duration`, `instrumental`, `format`. `audio` is one node with a `kind` rather than three node types: speech, sound effects and music share a provider capability, an artifact role (`audio`) and a player, and a vendor typically offers more than one (ElevenLabs does all three). Its `with` is validated per kind (speech needs `text`, sfx needs `prompt`, music needs `prompt` or lyrics), and a provider may restrict `audioKinds` so a music-only backend is not chosen for speech.

Output: `{ artifact, artifacts[], count, provider, vendor, model?, costUSD, reused }`. Capabilities: `sideEffecting: true`.

### 5. Node-type metadata is code-defined, not a manifest file

The first draft proposed a separate `flowgraph.plugin.json`. Revised: a `NodeFactory` may carry `ui` (`label`, `description`, `category`, `icon`, `color`), and `describeNodeTypes()` returns every registered type with its capabilities and a **JSON Schema of its `with` block**. A plugin's metadata therefore lives in the same module as its code and cannot drift out of sync.

- The desktop sidecar loads the open graph's `imports`, calls `describeNodeTypes()`, and the UI merges the result into the palette. The inspector renders a **generic form from the JSON Schema** for any type without a bespoke form, so a plugin is never second-class.
- Built-in types keep their bespoke forms.
- **Trust:** listing a plugin runs its module, with the same trust as `imports[].nodes` today. This ADR adds no sandbox. A static, no-execute manifest (for browsing plugins before importing them) is a possible follow-up.

### 6. Security properties

- Local file inputs must resolve **inside the run workspace**, after symlink resolution.
- Under a host node policy with `outboundHttp`, **URL inputs are refused** (Artifact or workspace path only), so an untrusted graph cannot make the host fetch internal URLs.
- On the hosted server, an untrusted author's `kind: media` entry gets the same endpoint checks as `langchain` entries (no `baseUrl`), and derived media providers inherit the existing `langchain` checks.
- Downloads are streamed to disk with a size cap, hashed, and written via a temp file then renamed. Signed URLs are redacted (query dropped) in errors and logs.

### 7. Typed decisions (deferred to a follow-up change)

A `DecisionProvider` interface (`decide({ question, input, answer: choice | score | boolean }) → { value, confidence }`), surfaced as a `router` mode and a standalone `decide` node, with Jev as one adapter and an LLM structured-output adapter as the baseline. It is a single-pass interface, deliberately separate from `ProviderAdapter`. Not implemented here; the intended use is escalation, where a high-confidence decision routes straight through and a low-confidence one falls to an `agent` or `hitl` node via existing `when` guards. Published claims about Jev's speed and accuracy are vendor-reported and not independently verified, so nothing in core may depend on them.

### 8. First-party versus plugin: the rule

> **Core owns contracts and anything that needs engine integration. Plugins own vendors, heavy dependencies, and fast-moving APIs.**

| Item | Where |
|---|---|
| `Artifact`, journal/`runMediaJob`, `MediaProvider`, registry, `describeNodeTypes` | `@flowgraph/spec`, `@flowgraph/core` |
| `image`, `video`, `model3d` nodes | `@flowgraph/core` |
| Reference vendor adapters (xAI, OpenAI images, Tripo, Meshy, ElevenLabs, and Suno if it offers an official API) | `@flowgraph/media` (dependency-free `fetch`) |
| Other vendors, local video inference (GPU, weights, licenses) | Third-party plugins |
| `decide` node / Jev | Follow-up |
| Computer use | **Deferred.** Start as an agent tool or MCP server; needs `permission: ask`, HITL gating and a desktop-only capability flag before it could be a node. |

## Consequences

- Image, video and 3D nodes chain by passing `Artifact`s, and the desktop can preview them without per-node code.
- A user who configured xAI or OpenAI for LLMs gets image (and for xAI, video) generation with no second configuration.
- Third parties add a vendor by implementing `MediaProvider` and registering it; their node types, if any, show up in the palette through `describeNodeTypes()`.
- Resume, retry and replay do not resubmit paid jobs, except in the narrow window described in §2.
- Additive within `flowgraph/v1`: a new provider `kind`, three node types, new `custom.media.job` events.
- Desktop work is required to benefit fully: sidecar RPC, merged palette, generic form, artifact preview.
- Plugins widen the attack surface (see §5 trust note).
- The journal lives in the run workspace: a host whose workspace is ephemeral loses re-attach across restarts.

## Alternatives considered

| Option | Why not |
|---|---|
| Put media generation behind `ProviderAdapter` | Agent-loop interface; async jobs and per-call cost do not fit |
| Separate credentials for media (`kind: media` only) | Makes users configure xAI/OpenAI twice |
| `ctx.once` to protect against resubmission | Persisted only on node return; a mid-node crash resubmits a paid job |
| One `generate` node with `modality:` | One bloated `with` schema, one inspector for three different UIs |
| Vendor-specific first-party nodes (`tripo`, `meshy`) | Core would churn with every vendor API change; downstream nodes would depend on the vendor, not the artifact |
| Media nodes in an optional package | No palette entries or inspectors out of the box; the nodes carry no heavy dependency |
| Separate `flowgraph.plugin.json` manifest | Duplicates metadata that already sits next to the code and can drift; revisit only for no-execute browsing |
| Skills or MCP servers per vendor | Fine for agent-driven use, but a deterministic node needs durable job handling, cost reporting and a typed output |
| Base64 media in state | Every checkpoint copies the full value ([05](../05-state-and-data.md)) |

## Implementation notes

Implemented alongside this ADR: spec schemas (`Artifact`, `kind: media`, `image`/`video`/`model3d` `with`), `packages/core/src/media/*` (types, artifacts, journal, `runMediaJob`, inputs, registry), `packages/core/src/nodes/media.ts`, `NodeFactory.ui` + `describeNodeTypes()`, and CLI/server handling of `kind: media`. Vendor adapters and the desktop integration are tracked in the same change.

## Open questions

1. Suno: is there an official, supported API? Unofficial wrappers that automate the web app are not an acceptable basis for a first-party adapter. Decide before building one.
2. Artifact retention: when are `.flowgraph/artifacts/<thread>/` and `.flowgraph/jobs/<thread>/` cleaned up relative to checkpoint retention?
3. Should `demo` move onto the `Artifact` contract (and its directory)?
4. Static plugin manifest for no-execute browsing: needed, and if so where does it live?
5. Idempotency keys: which target vendors accept one, so the orphan window can be closed for them?
