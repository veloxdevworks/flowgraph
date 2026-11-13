import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile, rm } from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { runGraphFile } from "@flowgraph/testing";
import type { InterruptInfo } from "@flowgraph/core";

const here = path.dirname(url.fileURLToPath(import.meta.url));

type Art = { path: string; mimeType: string; role: string; sizeBytes: number; meta?: Record<string, unknown> };
type Out = { artifact: Art; artifacts: Art[]; count: number; costUSD: number; reused: boolean };

type Gate = { decision: string; round: number; selected?: Art | null; feedback?: string };

describe("media-review example", () => {
  const scratch = path.join(here, ".flowgraph");
  beforeAll(() => rm(scratch, { recursive: true, force: true }));
  afterAll(() => rm(scratch, { recursive: true, force: true }));

  const payloadOf = (ints: InterruptInfo[]) =>
    (ints[0]!.payload as { data: { artifacts: Art[]; select: string; round?: number } }).data;

  it("approves with a selection and feeds it to the 3D model", async () => {
    let pending: Art[] = [];
    const result = await runGraphFile(path.join(here, "media-review.graph.yaml"), {
      cwd: here,
      onInterrupt: "prompt",
      resolveInterrupt: (ints) => {
        const data = payloadOf(ints);
        pending = data.artifacts;
        expect(data.select).toBe("one");
        return { decision: "approve", selected: data.artifacts[1]!.path };
      },
    });
    expect(result.status).toBe("completed");
    expect(pending).toHaveLength(2);
    const outputs = result.state.outputs as Record<string, Out & Gate>;
    expect(outputs.review!.selected).toEqual(pending[1]);
    expect(outputs.review!.round).toBe(1);
    expect((result.state.check as Gate).selected).toEqual(pending[1]);
    expect(outputs.mesh!.artifact).toMatchObject({ mimeType: "model/gltf-binary", role: "model3d" });
  });

  it("regenerate makes a new vendor job and different files", async () => {
    const seen: string[][] = [];
    const answers = ["regenerate", "approve"];
    const result = await runGraphFile(path.join(here, "media-review.graph.yaml"), {
      cwd: here,
      onInterrupt: "prompt",
      resolveInterrupt: (ints) => {
        const data = payloadOf(ints);
        seen.push(data.artifacts.map((a) => a.path));
        const decision = answers.shift()!;
        return decision === "approve" ? { decision, selected: data.artifacts[0]!.path } : { decision };
      },
    });
    expect(result.status).toBe("completed");
    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toEqual(seen[0]);
    expect(seen[1]!.some((p) => seen[0]!.includes(p))).toBe(false);
    const jobs = result.events.filter(
      (e) => e.type === "custom.media.job" && (e.data as { nodeId?: string }).nodeId === "concept",
    );
    // Two image jobs in round 1 and again in round 2 are all real submissions, none re-attached.
    expect(jobs.some((e) => (e.data as { reused?: boolean }).reused === true)).toBe(false);
    expect((result.state.outputs as Record<string, Gate>).review!.round).toBe(2);
    expect((result.state.outputs as Record<string, Out>).concept!.reused).toBe(false);
  });
});

describe("media-mock example", () => {
  // Generated files land in <example>/.flowgraph; clean up before and after.
  const scratch = path.join(here, ".flowgraph");
  beforeAll(() => rm(scratch, { recursive: true, force: true }));
  afterAll(() => rm(scratch, { recursive: true, force: true }));

  it("generates images, then a 3D model from the first image", async () => {
    const result = await runGraphFile(path.join(here, "media.graph.yaml"), { cwd: here });
    expect(result.status).toBe("completed");

    const outputs = result.state.outputs as Record<string, Out>;
    expect(outputs.concept!.count).toBe(2);
    expect(outputs.concept!.artifact).toMatchObject({ mimeType: "image/png", role: "image" });
    expect(outputs.concept!.artifact.meta).toMatchObject({ width: 64, height: 64 });

    expect(outputs.mesh!.artifact).toMatchObject({ mimeType: "model/gltf-binary", role: "model3d" });
    const glb = await readFile(path.join(here, outputs.mesh!.artifact.path));
    expect(glb.subarray(0, 4).toString("ascii")).toBe("glTF");
    expect(outputs.mesh!.costUSD).toBeCloseTo(0.25);
  });
});
