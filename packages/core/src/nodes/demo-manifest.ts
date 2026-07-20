/**
 * Run-scoped demo artifact manifest.
 *
 * Each successful or best-effort-failed `demo` capture appends one JSON line
 * under `<workspace>/.flowgraph/demo/runs/<threadId|runId>/manifest.jsonl`.
 * The key prefers `threadId` so HITL resume cycles accumulate in one file.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export type DemoKind = "http" | "screenshot" | "file";

export type DemoManifestEntry = {
  ok: boolean;
  kind: DemoKind;
  nodeId: string;
  capturedAt: string;
  path?: string;
  mimeType?: string;
  sizeBytes?: number;
  reason?: string;
  label?: string;
};

export function demoManifestPath(workspace: string, key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9._-]+/g, "_") || "run";
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
      const parsed = JSON.parse(trimmed) as DemoManifestEntry;
      if (parsed && typeof parsed === "object" && typeof parsed.kind === "string") {
        out.push(parsed);
      }
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

/** Prefer threadId (survives HITL resume) over the compile-time runId. */
export function demoManifestKey(meta: { threadId?: string; runId?: string }): string {
  return meta.threadId || meta.runId || "anonymous";
}
