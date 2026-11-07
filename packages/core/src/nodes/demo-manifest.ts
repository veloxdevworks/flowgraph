/**
 * Run-scoped demo artifact manifest.
 *
 * Each successful or best-effort-failed `demo` capture appends one JSON line
 * under `<workspace>/.flowgraph/demo/runs/<threadId|runId>/manifest.jsonl`.
 * The key prefers `threadId` so HITL resume cycles accumulate in one file.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Artifact, DemoStatus } from "@flowgraph/spec";
import { runScopedKey, sanitizeRunKey } from "../runtime/run-key.js";

export type DemoKind = "http" | "screenshot" | "file" | "video" | "simulator";

export type DemoExtraArtifact = {
  path: string;
  mimeType: string;
  kind: string;
  sizeBytes?: number;
};

export type DemoManifestEntry = {
  ok: boolean;
  /** Entries written before ADR-0019 have none: `readDemoManifest` derives it. */
  status: DemoStatus;
  kind: DemoKind;
  nodeId: string;
  capturedAt: string;
  path?: string;
  mimeType?: string;
  sizeBytes?: number;
  reason?: string;
  label?: string;
  extra?: DemoExtraArtifact[];
  /** Workspace-relative records of the files this capture kept. */
  artifacts?: Artifact[];
};

export function demoManifestPath(workspace: string, key: string): string {
  const safe = sanitizeRunKey(key);
  return join(workspace, ".flowgraph", "demo", "runs", safe, "manifest.jsonl");
}

export function appendDemoManifestEntry(
  workspace: string,
  key: string,
  entry: DemoManifestEntry,
): void {
  const path = demoManifestPath(workspace, key);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
}

export function readDemoManifest(workspace: string, key: string): DemoManifestEntry[] {
  const path = demoManifestPath(workspace, key);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const out: DemoManifestEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Omit<DemoManifestEntry, "status"> & { status?: DemoStatus };
      if (parsed && typeof parsed === "object" && typeof parsed.kind === "string") {
        out.push({ ...parsed, status: parsed.status ?? legacyStatus(parsed) });
      }
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

/** Old entries had no status: `ok` means a capture nothing checked, and a failure with a file was seen. */
function legacyStatus(entry: { ok: boolean; path?: string }): DemoStatus {
  if (entry.ok) return "inconclusive";
  return entry.path ? "failed" : "not_captured";
}

/** Prefer threadId (survives HITL resume) over the compile-time runId. */
export const demoManifestKey = runScopedKey;
