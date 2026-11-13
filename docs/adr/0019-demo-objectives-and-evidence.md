# ADR-0019 — Tying `demo` evidence to objectives

- **Status:** Accepted
- **Date:** 2026-11-06
- **Amends:** [0017-generative-media-nodes-and-plugin-manifest.md](./0017-generative-media-nodes-and-plugin-manifest.md) (answers open question 3), [0018-gate-artifact-review.md](./0018-gate-artifact-review.md)
- **Relates to:** [03 — Node types](../03-node-types.md) §9b

## Context

The goal of `demo` is to show a human that an objective was met. Today it can only show that a capture happened and that nothing obviously failed:

1. **No objective.** Nothing links a capture to a claim. `ok: true` on a page that loaded says nothing about whether checkout works.
2. **No interaction.** A capture can load a page or launch an app, then wait and record. Signing in or clicking through a flow is out of reach, and those are usually what needs proving.
3. **Missing evidence is invisible at a gate.** A gate lists what `with.artifacts` renders to. A `demo` node that never ran renders to nothing, so the human sees a shorter list and no warning.
4. **Two file conventions.** `demo` writes to `.flowgraph/demo/<nodeId>/` with absolute paths. Everything else uses the `Artifact` contract.

Verifying the honest-results work on real devices shaped this design. Screenshots of a boot logo and of a home screen returned `ok: true` and passed every test built on stand-ins; only looking at the output caught them. A settle heuristic cannot tell a finished screen from a stable error page. Only an assertion about the page can.

Three facts about the current code constrain the design. All were checked on 2026-11-06:

- **Stale files after a re-run.** The `outputs` channel is deep-merged, and a failed capture has no `path`. Running a graph where `demo` succeeds and then fails on a loop-back produced `{ ok: false, reason: "source not found", path: "<the first run's file>" }`. A gate would present that old file.
- **`flatten` checks `artifacts` first.** `resolveGateArtifacts` returns early for any object with an `artifacts` array, before it looks for a failure. Adding that field to the `demo` output without reordering would silently drop capture failures from gates.
- **`mode: review` spreads the client's answer.** `mapHitlResume` ends with `...rec`, so a client can overwrite `approved`, and any field it sends reaches the output. A gate rule has to be evaluated after the spread, and validated values have to replace what the client sent.

## Decision

### 1. Extend `demo`, one objective per node

`objective` and `steps` are added to `demo` rather than a new node type. The node already has the manifest, run issues, agent-tool support and gate handling, and the five current modes stay as shorthand. A graph with several objectives uses several nodes, which keeps each result a single verdict.

```yaml
- id: prove-checkout
  type: demo
  with:
    objective: "A signed-in user can complete checkout"
    target:
      web: { url: "{{ state.baseUrl }}/login", timeout: 2m }
    steps:
      - fill: { selector: "#email", value: "{{ config.vars.testUser }}" }
      - fill: { selector: "#password", value: "{{ secret.TEST_PASSWORD }}" }
      - click: "text=Sign in"
      - expect: { url: "**/account" }
      - click: "text=Checkout"
      - expect: { text: "Order confirmed" }
      - screenshot: confirmation
    expect: { noConsoleErrors: true }
```

- `steps` requires `target`, and is a sixth mode alongside `http`, `screenshot`, `video`, `simulator` and `file`: exactly one is set.
- `target` has one key, `web`, in this ADR (`url`, and optional `viewport`, `expect: { status }`, `timeout` and `stepTimeout`). The key is there so later capture drivers add a sibling rather than a new shape.
- `objective` is also allowed on the five shorthand modes. Such a node can never be `passed` (§3), which suits "a human should look at this".
- `target.web.timeout` bounds the whole flow (default 2m), and each step waits up to `stepTimeout` (default 30s). This sits with the other capture timeouts, such as `screenshot.timeout`. A node-level `timeout` still applies as an outer limit.

### 2. Step vocabulary

Each step has exactly one verb. Values are templates, and the rendered, redacted value is what gets recorded.

| Step | Effect |
|---|---|
| `goto: <url>` | Navigate. A status of 400 or above fails unless `target.web.expect.status` allows it |
| `click: <selector>` | Click, using Playwright's auto-wait |
| `fill: { selector, value }` | Fill an input |
| `press: <key>` | Press a key on the focused element |
| `wait: <selector or duration>` | Same rule as today's `waitFor` |
| `screenshot: <name>` | Save a named screenshot |
| `expect: { ... }` | Assert, as below |

| Assertion | Counts as positive? | Holds when |
|---|---|---|
| `text: <string>` | Yes | The text is **visible** on the page before the step times out; text hidden in the DOM does not count |
| `visible: <selector>` | Yes | The element is visible |
| `url: <glob>` | Yes | The page URL matches |
| `hidden: <selector>` | No | The element is absent or hidden |
| node-level `noConsoleErrors: true` | No | No `console.error` or uncaught page error during the flow |

Negative checks can't produce `passed` alone, because they also hold on a blank page or one still loading.

The vocabulary stays small on purpose. Anything richer belongs in a preceding `script` node or a later ADR, and steps never run arbitrary code in the page.

### 3. Four statuses, and what each requires

Every `demo` result gains `status`, including the shorthand modes.

| Status | Meaning | Requires |
|---|---|---|
| `passed` | The objective was shown to hold | `steps` ran to the end, every assertion held, at least one positive assertion ran, and at least one evidence file exists |
| `failed` | The target was reached and it did not do what was claimed | An assertion or action did not hold, or a status was unexpected. Files are kept as evidence |
| `inconclusive` | Evidence exists, but nothing checked the claim | A capture worked and recorded no failure, with no assertions to decide it. Every successful shorthand capture is this |
| `not_captured` | No evidence exists | Tool missing, browser crash, or target unreachable (connection refused, DNS) |

**`ok` is derived and keeps its meaning.** It is `true` for `passed` and `inconclusive`, and `false` for `failed` and `not_captured`, which matches today for every existing graph. Graphs that need proof route on `status == "passed"`.

**`strict`** keeps its behavior without an objective. With an objective it throws unless the status is `passed`.

A `not_captured` result raises `CAPTURE_FAILED`, as today. A `failed` result with an objective raises a new `OBJECTIVE_FAILED`.

### 4. The harness chooses the evidence

A `steps` flow always records video from the first navigation and always saves a final screenshot, on failure as well. On failure the screenshot is the point of failure, and no later steps run. A script can add named screenshots but cannot turn recording off, so the flow's author does not choose which moments a reviewer sees.

If the recording fails but a screenshot exists, the status stands and a warning issue is raised.

The result records what was checked, so a reviewer reads the literal assertions:

```ts
type DemoStatus = "passed" | "failed" | "inconclusive" | "not_captured";

interface DemoResult {
  // ...existing fields, kept
  status: DemoStatus;
  objective: string | null;
  artifacts: Artifact[];               // workspace-relative records
  steps: Array<{ index: number; action: string; detail: string; ok: boolean; ms: number; error?: string }> | null;
  assertions: Array<{ check: string; positive: boolean; held: boolean; observed?: string }> | null;
  console: { errors: number; messages: string[] } | null;  // first 20, redacted
}
```

Every string goes through the redactor that `http` mode uses, including `{{ secret.* }}` values rendered into steps and Playwright's own error messages, which can quote them.

### 5. Every run writes every field

Because `outputs` is deep-merged, each `demo` result writes every field on every run, using `null` for anything absent (`path: null`, `reason: null`, `extra: null`, and so on). This applies to all modes and fixes the stale-file bug above. ADR-0018 already does this for `selected`.

Arrays replace on merge, so `artifacts`, `steps` and `assertions` are safe. Nested objects still merge: `response.headers` and `response.body` can carry keys from an earlier run. The transcript file is unaffected, and a graph that reads them across a loop should use `output.to`.

### 6. Move `demo` onto the `Artifact` contract

This answers ADR-0017 open question 3: yes.

- All modes write to `.flowgraph/artifacts/<threadKey>/<nodeId>/` through the media helpers, and `artifacts` lists full records with `sha256`, `mimeType` and `role`.
- `path` and `extra` stay as they are (absolute paths) for existing graphs.
- The manifest stays at `.flowgraph/demo/runs/<key>/manifest.jsonl`, because Desktop's history reads it and old runs must stay readable. Entries gain `status`, `objective` and `artifacts`.
- `flatten` looks for a failure before it follows `artifacts`.
- Retention stays open (ADR-0017 question 2). Recordings make it more pressing.

### 7. Gates name the evidence they need

`hitl` gains `with.evidence`, a list of `demo` node ids, for `approve`, `review` and `choice`:

```yaml
- id: approve-release
  type: hitl
  with:
    mode: approve
    message: "Ship this?"
    evidence: [prove-checkout, prove-refund]
```

A named list is what makes absence visible: the gate knows what should be there, so a node that never ran is reported, where `with.artifacts` would just render nothing.

The gate reads `state.outputs.<id>` and sends `data.evidence`, one entry per id:

```ts
interface GateEvidence {
  nodeId: string;
  objective: string | null;
  status: DemoStatus | "not_run";
  reason: string | null;
  capturedAt: string | null;
  assertions: DemoResult["assertions"];
  artifacts: Artifact[];       // confined to the workspace, and present on disk
  needsOverride: boolean;
}
```

Evidence files are also added to `data.artifacts`, and the message gains a plain-text summary, so a client that knows nothing about `evidence` still shows the verdicts. These entries are left out of `captureFailures` so nothing is listed twice.

**Compile-time checks.** Each id must exist, be a `demo` node with an `objective`, not use `output: none`, and not be exposed as an agent tool.

### 8. Approving past bad evidence takes a recorded override

| Evidence | Approve needs |
|---|---|
| `passed`, with a file on disk | Nothing |
| `inconclusive`, with a file on disk | Nothing. It is labelled "no automated check", because the human looking at it is the check |
| `failed`, `not_captured`, `not_run`, or any status whose files are gone | `override: { reason: "<non-empty>" }` in the answer |

- Applies to approving answers in `approve` and `review`, evaluated after `...rec` is applied. Rejecting never needs an override.
- An approval without a required override is an invalid answer, so `interruptUntilValid` re-prompts with a message saying what's wrong and how to override. After `maxResumeAttempts` rejections the run fails with the interrupt still pending.
- `choice` gates show evidence but enforce nothing in this ADR, since the engine can't tell which answer means "ship".
- The output gains `override: { reason, items: [{ nodeId, status }] } | null`, built by the node rather than copied from the client, and written as `null` when unused. An accepted override raises `EVIDENCE_OVERRIDDEN`.
- `--on-interrupt approve` sends `true`, which is rejected here, so unattended runs cannot wave past missing evidence. An automated pipeline that really wants to has to send a reason.

An override is a record, not access control. Anyone who can answer the gate can give a reason.

### 9. Agents don't get to prove things in this phase

A node with `objective` or `steps` cannot be exposed as an agent tool; that is a compile error. Tool calls don't write `state.outputs`, so they couldn't satisfy a gate anyway, and an agent choosing its own assertions would make `passed` meaningless. Agent-planned flows are a later phase, where the plan is saved and the harness does the recording.

Assertions may still template from state, so a graph author can wire an agent's output into a check. That is the author's choice, and the gate shows the rendered check.

### 10. Cancelling stops captures

`demo` honors `ctx.signal` in every mode. Aborting closes the browser context, which rejects any in-flight Playwright call, and kills simulator capture processes, including the recorder on the device. The abort propagates as a cancellation, not as a failed capture. Scripted flows run long enough for this to matter, so it is included here.

### 11. Playwright

- The peer range rises to `^1.55.1`, the first version without the advisory on unverified browser downloads, and the lockfile moves to a current release.
- Bundling and first-use download are out of scope and get their own ADR. A real isolated install works ([test notes below](#what-was-measured)). Two findings carry over: a signed app is untested, and a workspace with its own Playwright ignores an isolated folder, so Desktop will need a way to pass its own copy in.

## Consequences

- **Additive within `flowgraph/v1`.** New optional `with` fields, new result fields, new issue codes. A graph that doesn't use `objective` or `with.evidence` behaves the same, apart from files moving (below) and `null` fields appearing in results.
- **Files move.** New captures land in `.flowgraph/artifacts/`. Anything hard-coding `.flowgraph/demo/<nodeId>/` breaks. This is marked as breaking in the changeset; old runs' files are not moved.
- **Flows take real actions.** A flow really clicks "Place order". Point flows at local or test environments. A node-level `retry` re-runs the whole flow, side effects included, and steps are never retried individually. `demo` stays on `UNTRUSTED_BLOCKED_NODE_TYPES`.
- **Secrets can still show in pixels.** Text masking covers results, transcripts and logs, not images or video. A password field shows dots, but a token rendered on the page is visible. Masking in images is a later phase; until then use test credentials.
- **`passed` means exactly what the assertions say.** `text: "Order confirmed"` proves that text was visible, not that an order exists. Listing the checks at the gate is how a reviewer judges whether they are enough.
- **Web only.** `simulator` stays shorthand, so it can reach `inconclusive` at best, and its settle warning still applies.
- **Clients.** The engine enforces gates, so a client without an override control gets a re-prompt it can't satisfy. CLI and Desktop change in the same phase. Any other client needs the same control before it can approve past bad evidence.

## Alternatives considered

| Option | Why not |
|---|---|
| A new `prove` or `verify` node | Duplicates the manifest, issues, gate handling and tool support, and leaves two ways to capture |
| Several objectives per node | Needs per-objective status, step grouping and partial results; several nodes give the same thing with one verdict each |
| Bundling `@playwright/test` for its `expect` | Test-runner dependency for a few checks; `locator.waitFor` is enough |
| Let an LLM judge `passed` from frames | Not reproducible, and it can be wrong with confidence. Vision review can come later as labelled advice, and only assertions produce `passed` |
| `ok` meaning `passed` when an objective is set | `ok` would mean two things depending on another field, so `when: ok` would behave differently per node |
| Treat `inconclusive` as needing an override | Punishes the visual review this node exists for; the human is the check |
| Gate rule driven by `with.artifacts` alone | Can't report a node that never ran |
| Move the manifest too | No benefit, and it strands existing run history |

## Implementation

Build in this order, one PR per slice. Before starting: push `main` in both repos (`flowgraph` first), upgrade Playwright, and install the browser with `npx playwright install --only-shell chromium ffmpeg`.

| # | Slice | Repo | Main files |
|---|---|---|---|
| 1 | Statuses, explicit `null`s, `Artifact` migration, `flatten` order | engine | `spec/src/schema.ts`, `core/src/nodes/demo.ts`, `demo-manifest.ts`, `hitl-artifacts.ts` |
| 2 | Cancellation in all modes | engine | `demo.ts`, `demo-simulator.ts` |
| 3 | `target`, `steps`, assertions, recording, tool-exposure check | engine | `schema.ts`, new `core/src/nodes/demo-steps.ts`, `demo-playwright.ts`, `runtime/validate-graph.ts` |
| 4 | `with.evidence`, override, issues, CLI prompt | engine | `hitl.ts`, `hitl-artifacts.ts`, `cli/src/interrupts.ts`, `runtime/validate-graph.ts` |
| 5 | Gate view by objective, override control, one previewer, form handling | desktop | `GateArtifacts.tsx`, `ArtifactList.tsx`, `lib/hitl.ts`, `ui-graph` `DemoForm.tsx` |
| 6 | Docs, an example graph, authoring-agent prompt (it lists 3 of 5 modes today) | both | `docs/03-node-types.md`, `examples/`, `authoring-agent.graph.yaml` |

`DemoForm` must not drop `objective` or `steps` when a user saves. Showing them read-only is fine for now.

### Verification rules

Stand-ins are fine for unit tests, but they don't finish a slice. The worst bugs so far passed every test and only showed up in real output. For each slice:

1. Run against the real tool: a real browser, a local HTTP server, and real gate answers.
2. **Open the images and frames it produced, and describe what they show.** Never accept `ok: true` or `status: passed` alone.
3. Report what wasn't run. Keep existing failures out of the count (`worktree.test.ts`, `langchain/factory.test.ts` fail on `main` today).

These must all be checked with a real browser:

| Scenario | Expected |
|---|---|
| Full flow, all assertions hold | `passed`; the video shows the flow from the first navigation; the final screenshot shows the end state |
| Expected text absent | `failed`; the screenshot shows the page at that moment |
| Text in the DOM but hidden | `failed` |
| Click on a missing element | `failed` at that step; later steps not run |
| `goto` returns 500 | `failed`, files kept |
| Server down | `not_captured` |
| Browser not installed | `not_captured`, with the install hint |
| Only `hidden` and `noConsoleErrors` checks | `inconclusive`, never `passed` |
| Passing run, then a loop-back with the server down | `not_captured`, with `path: null`, and no old file at the gate |
| Secret in `fill` | The value appears in no JSON, manifest, issue or log (search for it) |
| Gate: `passed` | Bare approve accepted |
| Gate: `failed`, or a node that never ran | Bare approve re-prompts; approve with a reason accepted and recorded; `{ approved: true, override: { reason: "  " } }` rejected |
| Gate: `review` with `{ decision: "reject", approved: true }` | Treated as approving, so it needs an override |
| Evidence file deleted before the gate | Needs an override |
| `--on-interrupt approve` at a gate with bad evidence | Run fails, interrupt pending |
| Cancel mid-flow | No browser process left; a simulator recorder also stops |
| Console noise | Confirm whether a missing favicon counts for `noConsoleErrors` in the headless browser, and filter it if so |

### What was measured

On 2026-11-06, on an Apple Silicon Mac with Playwright 1.61.1: installing to a private folder took 12s and 194.7 MB and left the default cache empty. Real screenshots and video from that folder were checked by eye. Launching the headless browser takes about 70ms, or about 330ms the first time. Windows, Linux and signed builds were not run.

## Open questions

1. **Freshness.** A loop that skips a `demo` node presents an old `passed` for code that has since changed. This ADR only shows `capturedAt`. Should a result record the workspace commit, and the gate flag a mismatch?
2. **API objectives.** `http` mode can't reach `passed` here. An `expect` on status and body would let a server-only change be proven.
3. **Enforcing on `choice` gates.** Would need a way to mark which answers count as approving.
4. **Which later driver comes first,** and whether `steps` maps cleanly onto mobile flows. That spike decides whether this vocabulary holds up outside the web.
