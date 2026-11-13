# ADR-0020 — Node placement: running parts of a flow on other machines

- **Status:** Proposed
- **Date:** 2026-11-08
- **Relates to:** [0005-durability-and-hitl.md](./0005-durability-and-hitl.md), [0014-oss-control-plane-client.md](./0014-oss-control-plane-client.md), [0017-generative-media-nodes-and-plugin-manifest.md](./0017-generative-media-nodes-and-plugin-manifest.md) (artifact contract), [03 — Node types](../03-node-types.md) §6 `subgraph`, flowgraph-desktop ADR 0001 (runtime targets)

## Context

A run executes on one machine. Desktop picks that machine per run (flowgraph-desktop ADR 0001, `RunSession.targetId`): this machine, or a named `flowgraph-server`. The whole thread, its checkpoints and every node live on that target.

Real pipelines need steps that only run in one place. The motivating case is a 3D asset pipeline started from a MacBook where character creation uses Character Creator 5, which is Windows-only. Today the whole flow has to move to the Windows box, or the Mac has to shell into it with ad hoc SSH. The same need comes from GPU-only steps, licensed software installed on one machine, secrets that should stay on the machine that owns them, and steps that should run next to large data.

Facts about the current code that constrain the design, checked on 2026-11-08:

- **The top-level and node schemas are not strict.** Many nested schemas in `@flowgraph/spec` use zod `.strict()`, but `GraphSpecSchema` and `NodeSpecSchema` are plain `z.object`, so unknown keys there are stripped. An engine that does not know `runsOn` drops it without an error. The only field every released engine checks exactly is `apiVersion` (`z.literal("flowgraph/v1")`).
- **`subgraph` already is a contract boundary.** `stateMap.in` / `stateMap.out` declare exactly what crosses into and out of the child, and the parent's reducers apply the delta. `bundleGraphForRemote` inlines child graphs as `spec:` so a remote host does not read the coordinator's filesystem.
- **`flowgraph-server` already runs a graph remotely.** `POST /runs` takes YAML plus a required `threadId`, events stream over SSE, and `resume` / cancel exist. Credentials resolve server-side; client `env` is rejected.
- **The server strips `imports`.** Registered functions and plugins must already be installed on the host that runs them.
- **A thread id with saved state is refused.** `RunService` returns 409 for a `threadId` that already has stored state and no owner. A coordinator that re-sends a dispatch gets an error, not the existing run.
- **Artifacts are workspace-relative paths.** Generated media and `demo` captures live under `<workspace>/.flowgraph/artifacts/<thread>/<nodeId>/` and are referenced as `Artifact` records with `sha256`. Another machine cannot read them.
- **Binary requirements already exist.** `shell`, `script` and `demo` accept `with.requires: [{ bin, version }]`, checked at preflight (`runtime/requires.ts`).
- **Outbound connectivity already exists.** ADR-0014 ships an optional outbound WebSocket client in `@flowgraph/server` that dials Platform, so self-hosted runners need no inbound ports.

## Decision

### 1. Three roles; control never migrates

| Role | Owns | Examples |
|---|---|---|
| **Operator** | Starting runs, watching them, answering gates | Desktop UI, CLI TTY, mobile app, Platform web |
| **Coordinator** | The thread, its checkpoints, scheduling, the event stream | Desktop sidecar, `flowgraph run`, a cloud `flowgraph-server` |
| **Worker** | Executing a dispatched piece of a graph and returning its result | Any `flowgraph-server` (or other implementation of the worker protocol) with matching labels |

The machine that starts the run is the coordinator for its whole life. A placed step is **sent** to a worker, which runs it and returns a result. The thread itself is never handed off between machines.

### 2. The unit of placement is a subgraph

A cross-machine hop costs data transfer, latency and auth, so the boundary is explicit and its state contract is declared. That is what `subgraph` already provides. `runsOn` on any other node type is shorthand: the compiler wraps the node in a one-node subgraph whose `stateMap.in` is the node's `input` and whose `stateMap.out` is its output projection.

On the worker, a wrapped node sees only its own `input`, plus the `env`, `secret` and `run` scopes (`run.threadId` is the child thread id). `state`, `config` and `issues` are not there. The node's `input:` mapping, `when` and `with.output` are evaluated on the coordinator and may read state; every other template under `with` runs on the worker. `map` and `router` cannot be placed, because wrapping them would lose per-item and routing behaviour; place a subgraph that contains them instead.

Adjacent placed nodes are **not** fused automatically. Two consecutive `runsOn: [os:windows]` nodes make two round trips through the coordinator; group them in a subgraph to avoid it. `flowgraph validate` warns (`PLACEMENT_ADJACENT_HOPS`) when consecutive nodes share a placement.

### 3. Spec: `runsOn`

An additive `flowgraph/v1` field on nodes:

```yaml
nodes:
  - id: character
    type: subgraph
    uses: ./cc5-character.graph.yaml
    runsOn: [os:windows, app:cc5]          # shorthand: all of these labels
    with:
      stateMap:
        in:  { brief: characterBrief, refs: conceptArt }
        out: { characterFbx: fbx, characterTextures: textures }

  - id: upscale
    type: shell
    runsOn:
      labels: [gpu:nvidia]
      target: render-01                    # optional: pin to one named target
      fallback: local                      # optional: run here if no worker matches
      wait: 30m                            # optional: queue until a worker appears
```

- `labels` is an all-of list. `anyOf` is deferred until a real case needs it.
- `target` pins to a named target from the topology (§4). The graph still runs elsewhere if that name is missing and `fallback: local` is set; otherwise it is a preflight error.
- `fallback` is `error` (default) or `local`. `local` is for steps that run *better* elsewhere, not steps that *can only* run elsewhere.
- `wait` defaults to none (fail at preflight). With a duration, an unmatched placement queues until a matching worker connects or the duration passes.

Validation rules:

- `runsOn` is rejected on `hitl`, `workshop` and `wait` (`PLACEMENT_NOT_ALLOWED`): those are coordinator-side gates, and gates *inside* a placed subgraph are forwarded (§8).
- Nested placement is rejected in v1 (`PLACEMENT_NESTED`): a placed subgraph may not contain `runsOn`.
- Only top-level nodes are resolved. `runsOn` inside an unplaced subgraph (inline, `uses:` or a `map` inner node) is rejected (`PLACEMENT_NOT_TOP_LEVEL`) by validation and again at compile, instead of being ignored. A graph file that places its own top-level nodes can still run standalone; embedding it with `uses:` is the error.
- `runsOn` on `map` or `router` is rejected (`PLACEMENT_NOT_SUPPORTED`), whether it would resolve local or remote.
- A placed non-subgraph node whose `with` templates read `state.*`, `config.*` or `issues` is rejected (`PLACEMENT_STATE_REFERENCE`): on the worker they would render empty. The message suggests passing the value through `input:` or placing a subgraph with `stateMap.in`.
- A placed non-subgraph node with an `input` key equal to its own id is rejected (`PLACEMENT_INPUT_ID_COLLISION`): input keys become child channels, and a channel cannot share a node's name.
- A placed subgraph that contains a gate (`hitl`, `workshop`, `wait` with `until`/`signal`/`webhook`, or an agent with `ask_human`) gets a `PLACEMENT_GATE_PHASE2` warning until gate forwarding ships; in phase 1 such a gate fails the node with `PLACEMENT_GATE_UNSUPPORTED`.
- The graph never names hosts or URLs. `target` is a name resolved by the topology.

**Older engines.** An engine older than this ADR strips `runsOn` silently (see Context) and would run a placed step on the coordinator. Inside one installation the coordinator and its bundled engine ship together, and §7's worker preflight checks the worker's `flowgraph:` version, so the exposure is a graph opened by an older CLI, desktop or server. Released engines are not changed for this; a new `apiVersion` token for an additive field is not worth the friction.

From this change on, `GraphSpecSchema` and `NodeSpecSchema` reject unknown keys with `UNKNOWN_FIELD` (with a "did you mean" hint and a note to upgrade flowgraph). The next additive field fails loudly on any engine from this release forward. A scan of all 78 graph files across the repos on 2026-11-09 found no stray top-level or node keys.

### 4. Topology lives outside the graph

The graph says what a step needs. A **topology** says which targets exist and how to reach them. It is supplied by the host running the coordinator, never by the graph:

| Coordinator host | Topology source |
|---|---|
| Desktop | Settings → Servers (`fg.serverTargets`, tokens in the keychain) |
| CLI | `--targets <file>` or the planned `flowgraph.config.ts` / `--config` |
| Cloud `flowgraph-server` | Platform enrollment (connect transport) or `FLOWGRAPH_TARGETS` |
| Programmatic | `compileGraph(spec, { placement: { targets, transport } })` |

```yaml
# targets.yaml (CLI)
targets:
  studio-pc:
    url: https://studio-pc.lan:8787
    token: env:STUDIO_PC_TOKEN
local:
  labels: [app:blender]        # custom labels for this machine
```

**The local host is a target.** It has built-in labels (§6) plus any configured ones. Desktop's existing per-run target choice becomes the choice of *coordinator*; it is independent of where nodes run.

### 5. Resolution order

For each placed node, at preflight:

1. If the local host satisfies `labels` (and `target` is unset or names the local host), the node runs **in-process**, exactly as today.
2. Otherwise, pick a matching connected target (§7).
3. Otherwise, if `fallback: local`, run in-process.
4. Otherwise, if `wait` is set, queue (§7).
5. Otherwise, fail before any node runs with `PLACEMENT_UNSATISFIED`.

Consequences of rule 1: a graph with `runsOn: [os:windows, app:cc5]` runs fully, with no topology and no platform, on a Windows machine that has CC5 configured. The same graph started from a Mac delegates that step. There is no silent fallback that runs a CC5 step on a Mac.

The OSS CLI plus OSS `flowgraph-server` instances support everything in this ADR except the Platform-queued transport (§9). Platform adds the registry UI, enrollment and a hosted queue.

### 6. Labels: built-in, custom, and inferred

**Built-in labels** are detected by the host and live in reserved namespaces that cannot be set by hand:

| Namespace | Example | Source |
|---|---|---|
| `os:` | `os:windows`, `os:macos`, `os:linux` | `process.platform` |
| `arch:` | `arch:x64`, `arch:arm64` | `process.arch` |
| `gpu:` | `gpu:nvidia`, `gpu:apple` | best-effort probe |
| `flowgraph:` | `flowgraph:0.42` | engine version |
| `nodeType:` | `nodeType:model3d` | registered node factories |
| `plugin:` | `plugin:@acme/cc5-nodes` | loaded plugins |

**Custom labels** are declared in the worker's config, optionally with a check:

```yaml
# worker config on the Windows box
labels:
  app:cc5:
    check: ["powershell", "-NoProfile", "-c", "Test-Path '<CC5 install path>'"]
    every: 10m
  site:studio: {}               # no check: trusted as declared
```

The worker runs checks at startup and every `every` (default 10m), and withdraws a label whose check fails, recording the last failure. A label with no check is trusted as declared.

**Inferred requirements.** The compiler adds to each placed node's effective labels the `nodeType:*` and `plugin:*` its subgraph uses. Authors write only what cannot be inferred, such as `app:cc5`.

### 7. Two-stage matching before the run starts

1. **Label match** picks candidates: connected targets whose current labels include the node's effective labels.
2. **Worker preflight** confirms one. The coordinator sends the bundled child spec to a candidate's preflight endpoint, which validates and preflights it **without running it**: node types, plugins, `with.requires` binaries, skill `env`, and provider credentials on that worker. The first candidate that passes is chosen.

If any placed node has no confirmed worker, the run does not start. The error names the node, the labels it needed, and what each candidate reported:

```
PLACEMENT_UNSATISFIED: node "character" needs [os:windows, app:cc5]
  studio-pc   os:windows  app:cc5 withdrawn 3m ago (check exited 1)
  render-01   os:linux    no match on os:windows
```

The choice is held until the node runs. If the chosen worker has disconnected by then, matching runs again for that node only.

With `wait`, an unmatched node does not fail preflight; the run starts, and the node waits for a match when it is reached, failing with `PLACEMENT_WAIT_EXPIRED` after the duration.

Runtime failure cannot be ruled out (a license expires, the app crashes), so:

- A worker may **reject** a job it finds it cannot run (`WORKER_REJECTED`). The job is offered to the next candidate and does not count as a retry attempt.
- A failure after the worker accepted is an ordinary node error, handled by `retry` / `on.error`. A retry runs matching again and may choose a different worker.

### 8. Dispatch and lifecycle

- **Deterministic child thread id:** `{parentThreadId}/{nodeId}/{attempt}`. The dispatch is recorded with `ctx.once`, and the parent checkpoint stores `{ target, childThreadId }`. The id is percent-encoded in URLs (`%2F`), so a reverse proxy in front of a worker must pass encoded slashes through. The server's graph store maps characters outside `[A-Za-z0-9._-]` to `_` in file names and caps ids at 234 characters; an id that would exceed that fails before dispatch.
- **Attempt numbers.** `attempt` is the node's 1-based retry attempt. A retry requested by a `node:error` hook continues the numbering after the policy's attempts (`/2`, or `/4` after `maxAttempts: 3`), so it never reuses a failed child. Numbering depends only on the sequence of attempts, so a crash re-entry replays the same ids.
- **The record only persists with the node's update.** A crash or throw mid-node loses the `ctx.once` record. Re-entry is still safe: the deterministic child id gets `THREAD_EXISTS`, and the coordinator attaches.
- **Reconnect, not re-send.** LangGraph re-runs an interrupted node from its start. On re-entry, the coordinator looks up the recorded dispatch and subscribes to the existing child run. The server's 409 for an existing thread id gains a structured body (`code: THREAD_EXISTS`, current status) so the coordinator can tell "already running here" from a real conflict.
- **Events** from the worker are nested under the parent node's span and carry `placement: { target, childThreadId }`, so UIs can show where each node ran.
- **Gates inside the placed subgraph** surface as parent interrupts with ids namespaced by `childThreadId`. The coordinator's `onInterrupt` policy applies. A resume is forwarded to the worker's `resume`.
- **Cancel** of the parent run cancels the child run.
- **Checkpoints** for the child live on the worker. `getStateHistory` on the parent returns the pointer; the child's history is fetched from the worker on demand.
- **Credentials** resolve on the worker. Nothing from the coordinator's environment is sent (same rule as REQ-RT-006).

**Durable waiting (phase 2).** In phase 1 the parent node stays in one long step while the child runs. Phase 2 parks the parent thread as `paused` while the child runs and reconnects on wake. This lets a laptop coordinator sleep through a long remote step, and keeps a long step from running into `activeTtl` on shared databases.

### 9. Transports

The engine defines a `WorkerTransport` interface (`labels`, `preflight`, `dispatch`, `attach`, `resume`, `cancel`, and for artifacts `hasArtifact`, `putArtifact`, `getArtifact`). Two implementations:

| Transport | Direction | Where | Notes |
|---|---|---|---|
| **direct** | Coordinator calls the worker's REST + SSE API | OSS; LAN, VPN, Tailscale | Worker must be reachable. Default for desktop and CLI. |
| **connect** | Worker receives jobs over its outbound connection (ADR-0014) | Platform | No inbound ports on workers. Required for a cloud coordinator reaching machines on home or office networks. |

For the connect transport the job queue lives in Platform, not in the coordinator process. This matters for cloud coordinators whose processes are short-lived (an AgentCore session can land on a fresh microVM): any coordinator instance can find a recorded dispatch and reconnect. Workers register through Platform's existing runner enrollment; there is no second registry. The engine side stays transport-only, as ADR-0014 requires.

A cloud-hosted `flowgraph-server` acting as coordinator uses the same code path as a desktop coordinator; only the topology source and transport differ.

### 10. Artifacts across machines

State holds artifact references, never file contents. When a placed node runs on a worker:

- **Stage in.** On a fresh dispatch (not a reconnect), every `Artifact` record in the child's input is uploaded to the worker's content store (`.flowgraph/artifact-store/<sha256>`, one directory per principal on multi-user workers), unless `hasArtifact` says it is there already. A record without `sha256` gets one computed. The dispatched record's `path` becomes `fg-staged:<sha256>/<basename>` with `staged: true`. When the run starts, the worker copies each staged file into `.flowgraph/artifacts/<childThreadId>/staged/<sha256>/<basename>` and rewrites `path`, so worker nodes see ordinary records. A record whose file is missing or resolves outside the coordinator's workspace fails with `ARTIFACT_MISSING` before anything is sent; an unknown staged sha makes the worker refuse the run (`ARTIFACT_NOT_STAGED`).
- **Stage out.** `Artifact` records in what flows back (the projected parent update of a subgraph, or `outputs.<nodeId>` of a wrapped node), not the whole child state, are downloaded into `.flowgraph/artifacts/<parentThreadId>/<nodeId>/`, verified against their `sha256` while streaming, and rewritten. Returned records must carry `sha256`. A file the coordinator already has with that content is not downloaded again. Failure is `ARTIFACT_STAGE_OUT_FAILED`; it happens after the child ran, so a node `retry` runs the child again.
- **Not transferred:** `meta.thumbnail` previews, bare path strings and `{ path }` values that are not `Artifact` records.
- **Shared store.** An `ArtifactStore` interface lets artifacts carry a `uri` (`s3://`, a mapped share) so only the reference moves. It is **required** when the coordinator's workspace is short-lived (cloud) and optional otherwise.

Only artifacts named by the state contract move. Files a step writes but does not return stay on the worker.

Phase-1 limits: uploads are not resumable, the worker never evicts its content store, and transfers go through the coordinator (there is no shared store yet). Uploads are capped by `FLOWGRAPH_ARTIFACT_MAX_BYTES` (default 4 GiB).

## Phases

1. **Placement core.** `runsOn` in the spec and validator; topology loading in CLI and desktop; local-host labels; built-in and custom labels with checks; two-stage matching; direct transport; deterministic dispatch with reconnect; event nesting; cancel; artifact stage-in and stage-out by `sha256`.
2. **Long-running and interactive.** Gate forwarding; durable waiting (park and reconnect); `wait`; `WORKER_REJECTED` handling; the single-node shorthand.
3. **Scale and cloud.** Connect transport through Platform; `ArtifactStore` with object storage; worker pools and per-worker concurrency limits; `map` fan-out across matching workers.

## Out of scope

- **Moving the thread between machines.** See Alternatives.
- **Nested placement** inside a placed subgraph.
- **Worker-to-worker transfer** that skips the coordinator for artifacts. Possible later as an optimisation of §10.
- **Mobile as coordinator or worker.** The mobile app remains an operator (flowgraph-mobile ADR 0001). Placement changes nothing for it beyond showing where nodes ran and forwarding gates.

## Consequences

**Positive**

- One graph runs on a single capable machine with no setup, and is split across machines when started elsewhere.
- Capability mismatches are caught before the run starts, with the node, labels and reason named.
- The OSS engine and server support multi-machine runs without Platform.
- The same coordinator code serves desktop, CLI and cloud.

**Negative**

- Placed steps pay for state and artifact transfer, which is significant for large 3D assets on the direct transport.
- Every worker needs the plugins and tools its steps use installed, since `imports` are not shipped.
- The coordinator now depends on worker availability; an unreachable worker blocks a run that needs it.
- Re-matching after a transport failure (a retry of a node whose worker dropped) does not fall back to local, even with `fallback: local`; it fails with `REMOTE_NODE_FAILED` when no other worker matches.
- Docs to update when implemented: [02 — Graph spec](../02-graph-spec.md) (`runsOn`), [03 — Node types](../03-node-types.md) §6, [07 — Runtime](../07-runtime-and-execution.md) (placement, transports), `packages/server/README.md` (labels, preflight endpoint, worker config). flowgraph-desktop ADR 0001 has been amended (2026-11-09, effective on acceptance of this ADR): its per-run target now selects the coordinator.

## Alternatives considered

| Option | Why not |
|---|---|
| Move the whole thread to the Windows box and back via a shared checkpointer | Both machines must be able to run the whole graph; ownership handoff stacks onto the active-mark, `THREAD_MOVED_ON` and `activeTtl` logic; hard to reason about |
| Per-node placement with automatic fusing of adjacent nodes | Hides the state contract and the cost of each hop; subgraph boundaries make both explicit |
| Hostnames or URLs in the graph | Not portable across environments; mixes deployment with logic |
| No capability declaration; fail at runtime | The failure surfaces mid-pipeline, after expensive earlier steps |
| Static built-in labels only | Cannot express installed applications such as CC5 |
| Silent local fallback when no worker matches | Runs Windows-only steps on a Mac and fails later with a worse error |
| Only the pull/connect model, everywhere | Requires every LAN coordinator to host a job endpoint; direct calls are simpler where the worker is reachable |
| SSH from the coordinator to run steps | No events, gates, retries, artifact handling or credential isolation |

## Open questions

1. Default check interval for custom labels, and whether a check failing mid-run should affect an already-dispatched job.
2. Per-worker concurrency limits: declared in worker config, or reported live.
3. Size limits and resumable upload for staging large artifacts over the direct transport.
4. Where the local host's custom labels live for desktop (settings) versus CLI (topology file), and whether one should read the other.
5. Whether `wait` should notify operators (desktop, Platform) that a run is queued for a worker.
6. ~~How an older engine is stopped from ignoring `runsOn`.~~ Decided 2026-11-09: graphs and nodes reject unknown keys from this release on (§3, Older engines); released engines are left as they are.
