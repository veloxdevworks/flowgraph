/**
 * Placement resolution (ADR-0020 §5, §7). Top-level nodes only: nested placement is rejected by validation.
 */

import { normalizeRunsOn, type Diagnostic, type GraphSpec, type NodeSpec } from "@flowgraph/spec";
import { effectiveRequirements } from "./requirements.js";
import type { Topology } from "./topology.js";
import type { LabelCheckResult } from "./labels.js";
import type { TransportTarget, WorkerTransport } from "./transport.js";

export type CandidateStatus = "local-mismatch" | "matched" | "no-match" | "unreachable" | "preflight-failed" | "not-in-topology";

export interface CandidateReport {
  /** Target name; the local host is `"local"`. */
  target: string;
  status: CandidateStatus;
  /** Required labels this candidate lacks. */
  missing: string[];
  /** Human-readable reason, one line. */
  detail: string;
}

export interface PlacementDecision {
  nodeId: string;
  /** `unsatisfied` accompanies a PLACEMENT_UNSATISFIED diagnostic. */
  kind: "local" | "remote" | "queued" | "unsatisfied";
  target?: string;
  required: string[];
  candidates: CandidateReport[];
}

export interface ResolvePlacementsOptions {
  localLabels: string[];
  topology?: Topology;
  transport?: WorkerTransport;
  /** Resolve `uses:` subgraph refs (requirements inference and the worker preflight spec). */
  loadChild?: (ref: string) => GraphSpec | undefined;
  /** Input handed to worker preflight. */
  input?: Record<string, unknown>;
}

export const LOCAL_TARGET = "local";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function stateRef(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `{{ state.${key} }}` : `{{ state[${JSON.stringify(key)}] }}`;
}

/**
 * The one-node graph a worker runs for a non-subgraph node (ADR-0020 §2):
 * - the node's resolved `input` is the child's run input: each key is a child channel and the node's
 *   `input:` reads it back, so `{{ input.x }}` inside the node sees what it sees in-process;
 * - `with.output` is removed, so the node writes its raw result to `outputs.<nodeId>` and the
 *   coordinator applies the real `output` mapping to that result;
 * - `runsOn`, `when`, `retry` and `timeout` are removed: the coordinator owns them.
 *
 * Limit: templates in the node's `with` that read parent state other than its `input` have nothing
 * to read on the worker.
 */
export function wrapNodeAsGraph(node: NodeSpec, inputKeys: readonly string[]): GraphSpec {
  const { runsOn: _runsOn, when: _when, retry: _retry, timeout: _timeout, input: _input, ...rest } = node as NodeSpec & {
    when?: unknown;
    retry?: unknown;
    timeout?: unknown;
    input?: unknown;
  };
  const withBlock = isPlainObject(node.with) ? { ...node.with } : {};
  delete withBlock["output"];
  const keys = [...new Set(inputKeys)];
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: `placed-${node.id}` },
    ...(keys.length > 0 ? { state: { channels: Object.fromEntries(keys.map((k) => [k, { type: "any" }])) } } : {}),
    nodes: [
      {
        ...rest,
        ...(Object.keys(withBlock).length > 0 ? { with: withBlock } : {}),
        ...(keys.length > 0 ? { input: Object.fromEntries(keys.map((k) => [k, stateRef(k)])) } : {}),
      },
    ],
    edges: [
      { from: "START", to: node.id },
      { from: node.id, to: "END" },
    ],
  } as unknown as GraphSpec;
}

/** The spec a worker would run for `node`: inline/loaded subgraph, or the node wrapped in a one-node graph. */
export function childSpecForNode(node: NodeSpec, loadChild?: (ref: string) => GraphSpec | undefined): GraphSpec {
  if (node.type === "subgraph") {
    if (node.spec) return node.spec;
    const loaded = node.uses ? loadChild?.(node.uses) : undefined;
    if (loaded) return loaded;
  }
  const input = (node as { input?: unknown }).input;
  return wrapNodeAsGraph(node, isPlainObject(input) ? Object.keys(input) : []);
}

function missingOf(required: string[], have: Iterable<string>): string[] {
  const set = new Set(have);
  return required.filter((l) => !set.has(l));
}

function describeMismatch(missing: string[], have: string[], checks?: Record<string, LabelCheckResult>): string {
  const withdrawn = missing
    .map((l) => ({ l, c: checks?.[l] }))
    .filter((x): x is { l: string; c: LabelCheckResult } => !!x.c && !x.c.ok);
  const plain = missing.filter((l) => !withdrawn.some((w) => w.l === l));
  const parts: string[] = [];
  // Show what the candidate does have in the namespaces we need, as in the ADR example.
  const nsHave = [...new Set(plain.map((l) => l.split(":")[0]))]
    .flatMap((ns) => have.filter((h) => h.startsWith(`${ns}:`)))
    .slice(0, 3);
  if (plain.length) parts.push(`${nsHave.length ? nsHave.join(" ") + "  " : ""}no match on ${plain.join(", ")}`);
  for (const w of withdrawn) {
    const ago = Date.now() - Date.parse(w.c.checkedAt);
    const when = Number.isFinite(ago) && ago >= 0 ? ` ${formatAgo(ago)} ago` : "";
    parts.push(`${w.l} withdrawn${when}${w.c.error ? ` (${w.c.error})` : ""}`);
  }
  return parts.join("; ");
}

function formatAgo(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

export function placementUnsatisfiedMessage(nodeId: string, required: string[], candidates: CandidateReport[]): string {
  const width = Math.max(0, ...candidates.map((c) => c.target.length));
  const lines = candidates.map((c) => `  ${c.target.padEnd(width)}  ${c.detail}`);
  const head = `PLACEMENT_UNSATISFIED: node "${nodeId}" needs [${required.join(", ")}]`;
  return lines.length ? [head, ...lines].join("\n") : `${head}\n  no targets configured`;
}

/**
 * Decide where each placed top-level node runs. Order (ADR §5): local; first matching connected target
 * that passes worker preflight; `fallback: local`; `wait` (queued); else a PLACEMENT_UNSATISFIED error.
 */
export async function resolvePlacements(
  spec: GraphSpec,
  opts: ResolvePlacementsOptions,
): Promise<{ decisions: PlacementDecision[]; diagnostics: Diagnostic[] }> {
  const decisions: PlacementDecision[] = [];
  const diagnostics: Diagnostic[] = [];
  const targets = opts.topology?.targets ?? {};
  // One labels() call per target per resolve, however many placed nodes ask.
  const labelsByTarget = new Map<string, ReturnType<WorkerTransport["labels"]>>();

  for (const node of spec.nodes ?? []) {
    if (node.runsOn === undefined) continue;
    const placement = normalizeRunsOn(node.runsOn);
    const required = effectiveRequirements(node, opts.loadChild ? { loadChild: opts.loadChild } : {});
    const candidates: CandidateReport[] = [];
    const done = (d: Omit<PlacementDecision, "nodeId" | "required" | "candidates">) =>
      decisions.push({ nodeId: node.id, required, candidates, ...d });

    // 1. Local host.
    const pinnedElsewhere = placement.target !== undefined && placement.target !== LOCAL_TARGET;
    const localMissing = missingOf(required, opts.localLabels);
    if (!pinnedElsewhere) {
      if (localMissing.length === 0) {
        done({ kind: "local", target: LOCAL_TARGET });
        continue;
      }
      candidates.push({
        target: LOCAL_TARGET,
        status: "local-mismatch",
        missing: localMissing,
        detail: describeMismatch(localMissing, opts.localLabels),
      });
    }

    // 2. Connected targets: label match, then worker preflight.
    let chosen: string | undefined;
    const names = pinnedElsewhere ? [placement.target!] : Object.keys(targets);
    for (const name of names) {
      const t = targets[name];
      if (!t) {
        candidates.push({
          target: name,
          status: "not-in-topology",
          missing: required,
          detail: `target "${name}" is not in the topology`,
        });
        continue;
      }
      if (!opts.transport) {
        candidates.push({ target: name, status: "unreachable", missing: required, detail: "no worker transport configured" });
        continue;
      }
      const tt: TransportTarget = { name, ...t };
      let info;
      try {
        let pending = labelsByTarget.get(name);
        if (!pending) {
          pending = opts.transport.labels(tt);
          labelsByTarget.set(name, pending);
        }
        info = await pending;
      } catch (err) {
        candidates.push({
          target: name,
          status: "unreachable",
          missing: required,
          detail: `unreachable: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      const missing = missingOf(required, info.labels);
      if (missing.length) {
        candidates.push({ target: name, status: "no-match", missing, detail: describeMismatch(missing, info.labels, info.checks) });
        continue;
      }
      let pre;
      try {
        pre = await opts.transport.preflight(tt, {
          spec: childSpecForNode(node, opts.loadChild),
          ...(opts.input ? { input: opts.input } : {}),
        });
      } catch (err) {
        pre = {
          ok: false,
          diagnostics: [{ severity: "error" as const, code: "PREFLIGHT_UNAVAILABLE", message: err instanceof Error ? err.message : String(err) }],
        };
      }
      if (!pre.ok) {
        const first = pre.diagnostics.find((d) => d.severity === "error") ?? pre.diagnostics[0];
        candidates.push({
          target: name,
          status: "preflight-failed",
          missing: [],
          detail: `labels match; worker preflight failed${first ? `: ${first.message}` : ""}`,
        });
        continue;
      }
      candidates.push({ target: name, status: "matched", missing: [], detail: "matched" });
      chosen = name;
      break;
    }
    if (chosen) {
      done({ kind: "remote", target: chosen });
      continue;
    }

    // 3. fallback: local
    if (placement.fallback === "local") {
      done({ kind: "local", target: LOCAL_TARGET });
      continue;
    }
    // 4. wait
    if (placement.wait !== undefined) {
      done({ kind: "queued" });
      continue;
    }
    // 5. error
    done({ kind: "unsatisfied" });
    diagnostics.push({
      severity: "error",
      code: "PLACEMENT_UNSATISFIED",
      message: placementUnsatisfiedMessage(node.id, required, candidates),
      path: `nodes.${node.id}.runsOn`,
    });
  }
  return { decisions, diagnostics };
}
