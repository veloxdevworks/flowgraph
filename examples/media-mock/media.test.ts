import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile, rm } from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { runGraphFile } from "@flowgraph/testing";

const here = path.dirname(url.fileURLToPath(import.meta.url));

type Art = { path: string; mimeType: string; role: string; sizeBytes: number; meta?: Record<string, unknown> };
type Out = { artifact: Art; artifacts: Art[]; count: number; costUSD: number; reused: boolean };

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
