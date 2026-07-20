import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendDemoManifestEntry,
  demoManifestKey,
  demoManifestPath,
  readDemoManifest,
} from "./demo-manifest.js";

function mkWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fg-demo-manifest-"));
}

describe("demoManifestPath / demoManifestKey", () => {
  it("sanitizes the key and nests under .flowgraph/demo/runs", () => {
    expect(demoManifestPath("/ws", "thread/abc")).toBe(
      path.join("/ws", ".flowgraph", "demo", "runs", "thread_abc", "manifest.jsonl"),
    );
  });

  it("prefers threadId over runId", () => {
    expect(demoManifestKey({ threadId: "t1", runId: "r1" })).toBe("t1");
    expect(demoManifestKey({ runId: "r1" })).toBe("r1");
    expect(demoManifestKey({})).toBe("anonymous");
  });
});

describe("appendDemoManifestEntry / readDemoManifest", () => {
  it("round-trips entries", () => {
    const workspace = mkWorkspace();
    appendDemoManifestEntry(workspace, "tid-1", {
      ok: true,
      kind: "http",
      nodeId: "capture",
      capturedAt: "2026-01-01T00:00:00.000Z",
      path: "/tmp/a.json",
      mimeType: "application/json",
      sizeBytes: 12,
      label: "health",
    });
    appendDemoManifestEntry(workspace, "tid-1", {
      ok: false,
      kind: "file",
      nodeId: "attach",
      capturedAt: "2026-01-01T00:00:01.000Z",
      reason: "not found",
    });

    const entries = readDemoManifest(workspace, "tid-1");
    expect(entries).toHaveLength(2);
    expect(entries[0]?.kind).toBe("http");
    expect(entries[0]?.label).toBe("health");
    expect(entries[1]?.ok).toBe(false);
    expect(entries[1]?.reason).toBe("not found");
  });

  it("skips malformed lines and returns [] when missing", () => {
    const workspace = mkWorkspace();
    expect(readDemoManifest(workspace, "missing")).toEqual([]);

    const file = demoManifestPath(workspace, "tid-2");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        '{"ok":true,"kind":"screenshot","nodeId":"s","capturedAt":"t"}',
        "not-json",
        '{"ok":false,"kind":"http","nodeId":"h","capturedAt":"t2","reason":"x"}',
        "",
      ].join("\n"),
      "utf8",
    );

    const entries = readDemoManifest(workspace, "tid-2");
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.nodeId)).toEqual(["s", "h"]);
  });
});
