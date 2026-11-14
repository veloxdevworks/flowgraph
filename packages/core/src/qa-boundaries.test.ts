import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";

function graph(type: string, config: Record<string, unknown>): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "qa-boundaries" },
    config: { vars: { marker: "configured" } },
    nodes: [{ id: "execute", type, with: { ...config, output: { to: "answer" } } }],
    edges: [
      { from: "START", to: "execute" },
      { from: "execute", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
}

afterEach(() => vi.unstubAllEnvs());

describe("PLAT-297 / PLAT-326: explicit child credentials", () => {
  it("does not pass undeclared host variables into a shell child", async () => {
    vi.stubEnv("FGQA_DECOY", "decoy-only");
    const compiled = await compileGraph(
      graph("shell", {
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.env.FGQA_DECOY ?? 'absent')"],
      }),
    );
    const result = await compiled.run();
    expect(result.status).toBe("completed");
    expect(result.state.answer).toMatchObject({ stdout: "absent" });
  });

  it("supports explicit inherited variable names and env overrides", async () => {
    vi.stubEnv("FGQA_DECOY", "decoy-only");
    const compiled = await compileGraph(
      graph("shell", {
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.env.FGQA_DECOY + '|' + process.env.EXPLICIT)"],
        inheritEnv: ["FGQA_DECOY"],
        env: { EXPLICIT: "{{ secret.FGQA_DECOY }}" },
      }),
    );
    const result = await compiled.run();
    expect(result.status).toBe("completed");
    expect(result.state.answer).toMatchObject({ stdout: "decoy-only|decoy-only" });
  });

  it("resolves secret templates in the script sandbox", async () => {
    vi.stubEnv("FGQA_DECOY", "decoy-only");
    const compiled = await compileGraph(
      graph("script", {
        code: "export default async () => ({ value: process.env.EXPLICIT, hidden: process.env.FGQA_DECOY ?? null });",
        env: { EXPLICIT: "{{ secret.FGQA_DECOY }}" },
      }),
    );
    const result = await compiled.run();
    expect(result.status).toBe("completed");
    expect(result.state.answer).toMatchObject({ value: "decoy-only", hidden: null });
  });

  it("enforces secret policy for shell nodes", async () => {
    vi.stubEnv("FGQA_DECOY", "decoy-only");
    const compiled = await compileGraph(
      graph("shell", {
        command: "echo",
        args: ["{{ secret.FGQA_DECOY }}"],
      }),
      { nodePolicy: { blockSecrets: true } },
    );
    const result = await compiled.run();
    expect(result.status).toBe("error");
    expect(result.error?.message).toMatch(/secret.*blocked|not allowed/i);
  });
});
