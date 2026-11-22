import { describe, expect, it } from "vitest";
import {
  AgentWithSchema,
  KindSchema,
  PluginProviderConfigSchema,
  ProviderConfigSchema,
  RouterWithSchema,
  isNamespacedPluginType,
} from "./index.js";

describe("KindSchema", () => {
  it("accepts only Graph", () => {
    expect(KindSchema.safeParse("Graph").success).toBe(true);
    expect(KindSchema.safeParse("Skill").success).toBe(false);
    expect(KindSchema.safeParse("Subgraph").success).toBe(false);
  });
});

describe("AgentWithSchema", () => {
  it.each(["claude", "cursor", "langchain", "deepagents", "hub"])(
    "rejects removed agent with.%s",
    (key) => {
      const parsed = AgentWithSchema.safeParse({
        prompt: "hi",
        [key]: key === "hub" ? "deepagents" : { extra: true },
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.some((i) => i.code === "unrecognized_keys" && i.keys.includes(key))).toBe(true);
    },
  );
});

describe("RouterWithSchema", () => {
  it("rejects removed router with.provider", () => {
    const parsed = RouterWithSchema.safeParse({
      mode: "model",
      input: "hello",
      provider: "mock",
      routes: [{ name: "a", to: "x" }],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((i) => i.code === "unrecognized_keys" && i.keys.includes("provider"))).toBe(true);
  });
});

describe("PluginProviderConfigSchema", () => {
  it("parses kind: plugin entries through ProviderConfigSchema", () => {
    const parsed = ProviderConfigSchema.parse({
      kind: "plugin",
      plugin: "acme:llm",
      model: "acme-1",
      apiKeyEnv: "ACME_KEY",
      options: { region: "us-west", retries: 2 },
    });
    expect(parsed).toEqual({
      kind: "plugin",
      plugin: "acme:llm",
      model: "acme-1",
      apiKeyEnv: "ACME_KEY",
      options: { region: "us-west", retries: 2 },
    });
    expect(PluginProviderConfigSchema.safeParse({ kind: "plugin" }).success).toBe(true);
    expect(PluginProviderConfigSchema.safeParse({ kind: "plugin", plugin: "" }).success).toBe(false);
  });
});

describe("isNamespacedPluginType", () => {
  it("accepts namespace:name, namespace/name, and scoped @org/pkg:name forms", () => {
    for (const valid of [
      "acme:greet",
      "acme/greet",
      "my-plugin:step-2",
      "@acme/nodes:greet",
      "@acme/nodes/greet",
    ]) {
      expect(isNamespacedPluginType(valid), valid).toBe(true);
    }
  });

  it("rejects bare and malformed names", () => {
    for (const invalid of ["greet", "shell", "code", "intelligent", "Acme:greet", ":greet", "acme:", "acme:1bad"]) {
      expect(isNamespacedPluginType(invalid), invalid).toBe(false);
    }
  });
});
