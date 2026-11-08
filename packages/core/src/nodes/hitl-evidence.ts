/**
 * `hitl` `with.evidence` (ADR-0019 §7–8): the gate names the `demo` nodes whose verdicts it
 * needs, reads each one's result from `state.outputs.<id>`, and refuses an approving answer
 * past evidence that does not hold unless the answer carries `override: { reason }`.
 *
 * A named list is what makes absence visible: a node that never ran has no output, so it is
 * reported as `not_run` instead of rendering to nothing.
 */

import type { Artifact, DemoStatus } from "@flowgraph/spec";
import type { FlowAssertion } from "./demo-steps.js";
import { normalizeArtifactPath, resolveGateArtifacts } from "./hitl-artifacts.js";

export type GateEvidenceStatus = DemoStatus | "not_run";

export interface GateEvidence {
  nodeId: string;
  objective: string | null;
  status: GateEvidenceStatus;
  /** The demo's reason, plus a note when its files are gone. */
  reason: string | null;
  capturedAt: string | null;
  assertions: FlowAssertion[] | null;
  /** Confined to the gate's workspace and present on disk. */
  artifacts: Artifact[];
  needsOverride: boolean;
}

export interface GateOverride {
  reason: string;
  items: Array<{ nodeId: string; status: GateEvidenceStatus }>;
}

const DEMO_STATUSES: readonly string[] = ["passed", "failed", "inconclusive", "not_captured"];

/** The stored `demo` result of each named node, checked against the files on disk now. */
export async function collectGateEvidence(
  ids: readonly string[],
  outputs: Record<string, unknown> | undefined,
  workspace: string,
): Promise<GateEvidence[]> {
  const out: GateEvidence[] = [];
  for (const nodeId of [...new Set(ids)]) {
    const raw = outputs?.[nodeId];
    const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
    const status = typeof o?.["status"] === "string" && DEMO_STATUSES.includes(o["status"]) ? (o["status"] as DemoStatus) : undefined;
    if (!o || !status) {
      out.push({
        nodeId,
        objective: null,
        status: "not_run",
        reason: o ? "the stored result has no status" : null,
        capturedAt: null,
        assertions: null,
        artifacts: [],
        needsOverride: true,
      });
      continue;
    }
    const { artifacts } = await resolveGateArtifacts([o], workspace);
    const present = new Set(artifacts.map((a) => a.path));
    const recorded = (Array.isArray(o["artifacts"]) ? (o["artifacts"] as unknown[]) : [])
      .map((r) => (r && typeof r === "object" ? (r as { path?: unknown }).path : undefined))
      .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      .map(normalizeArtifactPath);
    const missing = recorded.filter((p) => !present.has(p));
    const goodStatus = status === "passed" || status === "inconclusive";
    const gone =
      missing.length > 0
        ? `evidence files are gone: ${missing.join(", ")}`
        : goodStatus && artifacts.length === 0
          ? "no evidence file is on disk"
          : undefined;
    const reason = typeof o["reason"] === "string" && o["reason"] ? o["reason"] : null;
    out.push({
      nodeId,
      objective: typeof o["objective"] === "string" ? o["objective"] : null,
      status,
      reason: gone ? (reason ? `${reason}; ${gone}` : gone) : reason,
      capturedAt: typeof o["capturedAt"] === "string" ? o["capturedAt"] : null,
      assertions: Array.isArray(o["assertions"]) ? (o["assertions"] as FlowAssertion[]) : null,
      artifacts,
      needsOverride: !goodStatus || gone !== undefined,
    });
  }
  return out;
}

/** Is this stored output one of the evidence entries? Used to keep it out of `captureFailures`. */
export function isEvidenceOutput(
  ids: readonly string[],
  outputs: Record<string, unknown> | undefined,
): (o: Record<string, unknown>) => boolean {
  const stored = ids
    .map((id) => outputs?.[id])
    .filter((v): v is Record<string, unknown> => !!v && typeof v === "object");
  // A template may hand back a copy, so match on what identifies one capture, not on identity.
  return (o) =>
    stored.some(
      (s) =>
        s === o ||
        (typeof s["capturedAt"] === "string" &&
          s["capturedAt"] === o["capturedAt"] &&
          s["kind"] === o["kind"] &&
          s["reason"] === o["reason"]),
    );
}

function statusLabel(e: GateEvidence): string {
  if (e.status === "not_run") return "not run";
  if (e.status === "not_captured") return "not captured";
  if (e.status === "inconclusive") return "inconclusive (no automated check)";
  return e.status;
}

/** Plain text for the gate message, so a client that knows nothing about `evidence` still shows the verdicts. */
export function evidenceNotice(evidence: readonly GateEvidence[]): string {
  const lines = evidence.map((e) => {
    const parts = [e.objective, e.reason].filter((p): p is string => !!p);
    const detail = parts.length ? `: ${parts.join(". ")}` : "";
    const flag = e.needsOverride ? " [approving needs an override]" : "";
    return `- ${e.nodeId}, ${statusLabel(e)}${detail}${flag}`;
  });
  return `Evidence (${evidence.length}):\n${lines.join("\n")}`;
}

/**
 * The override an approving answer carries, built from the evidence rather than copied from the
 * client. Returns null when nothing needs one; throws (so the gate re-prompts) when something
 * does and the answer gives no non-empty `override.reason`.
 */
export function requiredOverride(
  evidence: readonly GateEvidence[],
  resume: unknown,
  opts: { nodeId: string; mode: "approve" | "review" },
): GateOverride | null {
  const needing = evidence.filter((e) => e.needsOverride);
  if (needing.length === 0) return null;
  const rec = resume && typeof resume === "object" && !Array.isArray(resume) ? (resume as Record<string, unknown>) : {};
  const given = rec["override"];
  const reason =
    given && typeof given === "object" && !Array.isArray(given) ? (given as { reason?: unknown }).reason : undefined;
  if (typeof reason === "string" && reason.trim()) {
    return { reason: reason.trim(), items: needing.map((e) => ({ nodeId: e.nodeId, status: e.status })) };
  }
  const list = needing.map((e) => `${e.nodeId} (${e.status})`).join(", ");
  const shape =
    opts.mode === "review"
      ? `{ "decision": "approve", "override": { "reason": "<why>" } }`
      : `{ "approved": true, "override": { "reason": "<why>" } }`;
  const why = given === undefined ? "" : " The override was given without a non-empty reason.";
  throw new Error(
    `hitl node "${opts.nodeId}": approving needs an override, because this evidence does not hold: ${list}.${why} ` +
      `To approve anyway, answer ${shape}. Rejecting needs no override.`,
  );
}
