import { describe, it, expect } from "vitest";
import { GraphSpecSchema } from "./index.js";

const base = {
  apiVersion: "flowgraph/v1",
  kind: "Graph",
  metadata: { name: "secrets" },
  nodes: [{ id: "a", type: "shell", with: { command: "true" } }],
  edges: [
    { from: "START", to: "a" },
    { from: "a", to: "END" },
  ],
};

describe("top-level secrets", () => {
  it("accepts a list of environment variable names", () => {
    const parsed = GraphSpecSchema.parse({ ...base, secrets: ["GITHUB_TOKEN", "_PRIVATE", "key2"] });
    expect(parsed.secrets).toEqual(["GITHUB_TOKEN", "_PRIVATE", "key2"]);
  });

  it("is optional", () => {
    expect(GraphSpecSchema.parse(base).secrets).toBeUndefined();
  });

  it.each(["", "2FA", "MY-TOKEN", "a.b", "$HOME"])("rejects the name %j", (name) => {
    const r = GraphSpecSchema.safeParse({ ...base, secrets: [name] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["secrets", 0]);
    expect(r.error?.issues[0]?.message).toContain("Invalid secret name");
  });

  it("rejects a name declared twice", () => {
    const r = GraphSpecSchema.safeParse({ ...base, secrets: ["A", "B", "A"] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["secrets", 2]);
    expect(r.error?.issues[0]?.message).toBe('Secret "A" is declared more than once');
  });

  it("rejects a map in place of the list", () => {
    expect(GraphSpecSchema.safeParse({ ...base, secrets: { GITHUB_TOKEN: true } }).success).toBe(false);
  });
});
