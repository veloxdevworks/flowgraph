/**
 * Artifacts shown at a `hitl` gate, and the selection a human makes from them.
 *
 * `with.artifacts` entries are templates, so what they render to is whatever the
 * graph holds: an Artifact, an array of them, a media node's whole output, a
 * workspace path, a demo-manifest ref. `resolveGateArtifacts` flattens all of
 * that into full Artifact records (for clients to preview) plus plain string
 * refs (for older clients), never `[object Object]`.
 *
 * The interrupt payload is checkpointed, so records carry metadata only, never
 * file bytes.
 */

import { realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import type { Artifact } from "@flowgraph/spec";
import { mimeForExtension, roleForMime, toPosix } from "../media/artifacts.js";

export type HitlSelect = "none" | "one" | "many";

/** A `demo` capture that failed: the human must see this, not an absent preview. */
export interface GateCaptureFailure {
  reason: string;
  kind?: string;
  label?: string;
  path?: string;
}

export interface GateArtifacts {
  /** Full records, de-duplicated by path, in the order they were given. */
  artifacts: Artifact[];
  /** Record paths plus every string that could not become a record. */
  artifactRefs: string[];
  /** `demo` outputs with `ok: false`. Any file they kept is also in `artifacts`. */
  captureFailures: GateCaptureFailure[];
}

/**
 * `demoFile`: a file of a `demo` output. `abs` is the absolute path the demo recorded and
 * `record` its workspace-relative record, relative to the *demo's* workspace, which may not
 * be the gate's. The record is only presented when it names the same file here.
 */
type Item =
  | { kind: "record"; record: Artifact }
  | { kind: "path"; value: string }
  | { kind: "demoFile"; abs: string; record: Artifact };

function isArtifactRecord(o: Record<string, unknown>): boolean {
  return (
    o["kind"] === "artifact" &&
    typeof o["path"] === "string" &&
    o["path"].length > 0 &&
    typeof o["mimeType"] === "string" &&
    typeof o["sizeBytes"] === "number"
  );
}

function captureFailureOf(o: Record<string, unknown>): GateCaptureFailure | undefined {
  if (o["ok"] !== false || typeof o["reason"] !== "string") return undefined;
  return {
    reason: o["reason"],
    ...(typeof o["kind"] === "string" ? { kind: o["kind"] } : {}),
    ...(typeof o["label"] === "string" ? { label: o["label"] } : {}),
    ...(typeof o["path"] === "string" ? { path: o["path"] } : {}),
  };
}

/** A `demo` result: the only producer of `ok`, a `kind` and `artifacts` together. */
function isDemoOutput(o: Record<string, unknown>): boolean {
  return (
    typeof o["kind"] === "string" &&
    typeof o["ok"] === "boolean" &&
    Array.isArray(o["artifacts"]) &&
    !(o["artifact"] && typeof o["artifact"] === "object")
  );
}

/**
 * A `demo` output's files: its main `path` and each `extra`, each with the record that
 * describes it. A record is found by the demo's own absolute path, which ends with the
 * record's relative one, so no other file is taken for it.
 */
function flattenDemo(o: Record<string, unknown>, out: Item[]): void {
  const records = (o["artifacts"] as unknown[]).filter(
    (r): r is Artifact => !!r && typeof r === "object" && isArtifactRecord(r as Record<string, unknown>),
  );
  const extras = Array.isArray(o["extra"]) ? (o["extra"] as unknown[]) : [];
  const files = [
    o["path"],
    ...extras.map((e) => (e && typeof e === "object" ? (e as { path?: unknown }).path : undefined)),
  ].filter((f): f is string => typeof f === "string" && f.trim().length > 0);
  for (const abs of files) {
    const posix = abs.split("\\").join("/");
    const record = records.find((r) => posix.endsWith(`/${normalizeArtifactPath(r.path)}`));
    out.push(record ? { kind: "demoFile", abs, record } : { kind: "path", value: abs });
  }
}

function flatten(value: unknown, out: Item[], failures: GateCaptureFailure[]): void {
  if (value == null || value === "") return;
  if (Array.isArray(value)) {
    for (const v of value) flatten(v, out, failures);
    return;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (s) out.push({ kind: "path", value: s });
    return;
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (isArtifactRecord(o)) {
      out.push({ kind: "record", record: o as unknown as Artifact });
      return;
    }
    // A `demo` node's output also carries `artifacts`, so a failure has to be read before
    // that list is followed: the list would otherwise hide that the capture failed.
    const failure = captureFailureOf(o);
    if (failure) failures.push(failure);
    // A `demo` output: its main file and the recording kept beside it, each checked against
    // the gate's workspace, because the demo node may have run in another one.
    if (isDemoOutput(o)) return flattenDemo(o, out);
    // A media node's whole output: `artifacts` already contains `artifact`.
    if (Array.isArray(o["artifacts"])) return flatten(o["artifacts"], out, failures);
    if (o["artifact"] && typeof o["artifact"] === "object") return flatten(o["artifact"], out, failures);
    // A `demo` output without `artifacts` (a run from before they existed): its file and recording.
    if (typeof o["path"] === "string") flatten(o["path"], out, failures);
    if (Array.isArray(o["extra"])) flatten(o["extra"], out, failures);
    return;
  }
  // Numbers, booleans and unrecognised objects have no sane string form here: drop them.
}

/** Normalise a workspace-relative path for comparison (posix, no `./`). */
export function normalizeArtifactPath(p: string): string {
  const posix = p.trim().split("\\").join("/");
  const n = path.posix.normalize(posix);
  return n.replace(/^(\.\/)+/, "");
}

/** The record for a file inside the workspace, or undefined (missing, a directory, outside, unreadable). */
async function recordForPath(workspace: string, workspaceReal: string, value: string): Promise<Artifact | undefined> {
  try {
    const real = await realpath(path.resolve(workspace, value));
    const rel = path.relative(workspaceReal, real);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    const st = await stat(real);
    if (!st.isFile()) return undefined;
    const ext = path.extname(real).slice(1).toLowerCase();
    const mimeType = mimeForExtension(ext) ?? "application/octet-stream";
    return {
      kind: "artifact",
      path: toPosix(rel),
      mimeType,
      sizeBytes: st.size,
      role: roleForMime(mimeType, ext),
    };
  } catch {
    return undefined;
  }
}

/** Is an existing Artifact record's file (if present) confined to the workspace? */
async function recordConfined(workspace: string, workspaceReal: string, rec: Artifact): Promise<boolean> {
  const abs = path.resolve(workspace, rec.path);
  try {
    const real = await realpath(abs);
    const rel = path.relative(workspaceReal, real);
    return !(rel.startsWith("..") || path.isAbsolute(rel));
  } catch {
    // Not on disk (yet, or any more): only a lexical check is possible.
    const rel = path.relative(path.resolve(workspace), abs);
    return !(rel.startsWith("..") || path.isAbsolute(rel));
  }
}

/**
 * Does the record, resolved under this gate's workspace, name the very file the demo
 * recorded? Compares real paths, so a same-named file here, or a record whose file is
 * missing, is not taken for it.
 */
async function sameFileHere(workspace: string, workspaceReal: string, rec: Artifact, abs: string): Promise<boolean> {
  try {
    const here = await realpath(path.resolve(workspace, rec.path));
    const rel = path.relative(workspaceReal, here);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
    return here === (await realpath(abs));
  } catch {
    return false;
  }
}

/**
 * Flatten rendered `with.artifacts` entries into records + refs.
 * Never throws for a bad entry: a path that is missing or outside the workspace
 * simply stays a plain ref.
 */
export async function resolveGateArtifacts(rendered: unknown[], workspace: string): Promise<GateArtifacts> {
  const items: Item[] = [];
  const captureFailures: GateCaptureFailure[] = [];
  flatten(rendered, items, captureFailures);

  const workspaceReal = await realpath(workspace).catch(() => path.resolve(workspace));
  const out: Array<{ key: string; record?: Artifact; ref: string }> = [];
  const byKey = new Map<string, number>();

  for (const item of items) {
    let record: Artifact | undefined;
    let ref: string;
    if (item.kind === "record") {
      if (await recordConfined(workspace, workspaceReal, item.record)) {
        record = { ...item.record, path: normalizeArtifactPath(item.record.path) };
        ref = record.path;
      } else {
        ref = item.record.path;
      }
    } else if (item.kind === "demoFile") {
      if (await sameFileHere(workspace, workspaceReal, item.record, item.abs)) {
        record = { ...item.record, path: normalizeArtifactPath(item.record.path) };
        ref = record.path;
      } else {
        // Another workspace, or a file that is gone: keep the real path as a plain ref.
        record = await recordForPath(workspace, workspaceReal, item.abs);
        ref = record ? record.path : item.abs;
      }
    } else {
      record = await recordForPath(workspace, workspaceReal, item.value);
      ref = record ? record.path : item.value;
    }
    const key = record ? `p:${record.path}` : `s:${ref}`;
    const seen = byKey.get(key);
    if (seen !== undefined) {
      // Prefer the producer's own record (hash, dimensions, provenance) over a stat-derived one.
      if ((item.kind === "record" || item.kind === "demoFile") && record) out[seen] = { key, record, ref };
      continue;
    }
    byKey.set(key, out.length);
    out.push({ key, ...(record ? { record } : {}), ref });
  }

  return {
    artifacts: out.flatMap((o) => (o.record ? [o.record] : [])),
    artifactRefs: out.map((o) => o.ref),
    captureFailures,
  };
}

/** Plain text every client shows, so a failed capture never looks like nothing to review. */
export function captureFailuresNotice(failures: readonly GateCaptureFailure[]): string {
  const lines = failures.map((f) => {
    const name = f.label ?? f.kind ?? "capture";
    return `- ${name}: ${f.reason}`;
  });
  return `Capture problems (${failures.length}):\n${lines.join("\n")}`;
}

function selectedPaths(raw: unknown): string[] {
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((entry) => {
    if (typeof entry === "string" && entry.trim()) return normalizeArtifactPath(entry);
    if (entry && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string") {
      const p = (entry as { path: string }).path;
      if (p.trim()) return normalizeArtifactPath(p);
    }
    throw new Error(`"selected" entries must be a path string or an artifact with a path`);
  });
}

export interface SelectionOpts {
  select: HitlSelect;
  presented: readonly Artifact[];
  /** True when this answer must carry a selection (approving outcome, or any choice answer). */
  required: boolean;
  nodeId: string;
}

/**
 * Validate the `selected` part of a resume value against what the gate showed.
 * Returns the matched records (not the client's objects), or undefined for
 * `select: none`. Throws on an invalid answer so the caller re-prompts.
 */
export function resolveSelection(raw: unknown, opts: SelectionOpts): Artifact | Artifact[] | null | undefined {
  const { select, presented, required, nodeId } = opts;
  if (select === "none") return undefined;

  const byPath = new Map(presented.map((a) => [normalizeArtifactPath(a.path), a]));
  const asked = selectedPaths(raw);
  const matched: Artifact[] = [];
  for (const p of asked) {
    const hit = byPath.get(p);
    if (!hit) {
      throw new Error(
        `hitl node "${nodeId}": selected "${p}" was not presented at this gate. ` +
          (presented.length
            ? `Choose from: ${presented.map((a) => a.path).join(", ")}`
            : `No artifacts were presented.`),
      );
    }
    if (!matched.includes(hit)) matched.push(hit);
  }

  if (select === "one" && matched.length > 1) {
    throw new Error(`hitl node "${nodeId}": select "one" takes exactly one artifact, got ${matched.length}`);
  }

  if (matched.length === 0 && required && presented.length > 0) {
    if (select === "one" && presented.length === 1) return presented[0]!;
    throw new Error(
      `hitl node "${nodeId}": a selection is required. Answer with "selected" set to ` +
        `${select === "one" ? "one of" : "any of"}: ${presented.map((a) => a.path).join(", ")}`,
    );
  }

  // Nothing picked on an answer that does not need it: an explicit empty value, so a
  // previous round's selection is not merged back in from `state.outputs.<node>`.
  if (select === "one") return matched[0] ?? null;
  return matched;
}
