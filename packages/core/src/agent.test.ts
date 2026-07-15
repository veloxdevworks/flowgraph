import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { resolveAgentPath } from "./agent-resolver.js";
import { loadAgentDef } from "./agents/loader.js";
import { compileGraph } from "./compiler.js";
import { createScriptedProvider } from "./providers/index.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import type { AgentRequest } from "./providers/types.js";

describe("resolveAgentPath + loadAgentDef", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-agent-"));
    const agentDir = path.join(tmpDir, "agents", "reviewer");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "AGENT.md"),
      `---
name: reviewer
description: Code review agent
---
You are a careful code reviewer.
Focus on bugs and clarity.
`,
      "utf-8",
    );
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves a relative path to AGENT.md directory", async () => {
    const resolved = await resolveAgentPath("./agents/reviewer", { cwd: tmpDir });
    expect(resolved).toBe(path.join(tmpDir, "agents", "reviewer"));
  });

  it("resolves via alias", async () => {
    const resolved = await resolveAgentPath("reviewer", {
      cwd: tmpDir,
      aliases: { reviewer: "./agents/reviewer" },
    });
    expect(resolved).toBe(path.join(tmpDir, "agents", "reviewer"));
  });

  it("loads front matter and body", async () => {
    const { agent, diagnostics } = await loadAgentDef(path.join(tmpDir, "agents", "reviewer"));
    expect(diagnostics).toEqual([]);
    expect(agent?.frontMatter.name).toBe("reviewer");
    expect(agent?.frontMatter.description).toBe("Code review agent");
    expect(agent?.body).toContain("careful code reviewer");
  });

  it("throws when AGENT.md is missing", async () => {
    await expect(resolveAgentPath("./agents/missing", { cwd: tmpDir })).rejects.toThrow(/AGENT\.md/);
  });
});

describe("agent node with.agent", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-agent-run-"));
    const agentDir = path.join(tmpDir, "agents", "helper");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "AGENT.md"),
      `---
name: helper
---
You are HelperBot for topic {{ state.topic }}.
`,
      "utf-8",
    );
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function agentSpec(nodeWith: Record<string, unknown>): GraphSpec {
    return {
      metadata: { name: "agent-def-graph" },
      state: { channels: { answer: { type: "object" }, topic: { type: "string" } } },
      nodes: [{ id: "agent", type: "agent", provider: "capture", with: nodeWith }],
      edges: [
        { from: "START", to: "agent" },
        { from: "agent", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;
  }

  it("uses AGENT.md body as system prompt", async () => {
    let captured: AgentRequest | undefined;
    const capture = createScriptedProvider("capture", (req) => {
      captured = req;
      return { output: { ok: true }, stopReason: "done" };
    });

    const compiled = await compileGraph(
      agentSpec({
        agent: "./agents/helper",
        prompt: "Say hello",
        output: { to: "answer" },
      }),
      { providers: [capture], cwd: tmpDir },
    );
    const r = await compiled.run({ input: { topic: "testing" } });
    expect(r.status).toBe("completed");
    expect(captured?.system).toContain("HelperBot");
    expect(captured?.system).toContain("topic testing");
  });

  it("appends node-level system after agent body", async () => {
    let captured: AgentRequest | undefined;
    const capture = createScriptedProvider("capture", (req) => {
      captured = req;
      return { output: { ok: true }, stopReason: "done" };
    });

    const compiled = await compileGraph(
      agentSpec({
        agent: "./agents/helper",
        system: "Also be brief.",
        prompt: "Say hello",
        output: { to: "answer" },
      }),
      { providers: [capture], cwd: tmpDir },
    );
    const r = await compiled.run({ input: { topic: "x" } });
    expect(r.status).toBe("completed");
    expect(captured?.system).toMatch(/HelperBot[\s\S]*Also be brief\./);
  });

  it("errors when agent definition is missing", async () => {
    const capture = createScriptedProvider("capture", () => ({
      output: { ok: true },
      stopReason: "done",
    }));
    const compiled = await compileGraph(
      agentSpec({
        agent: "./agents/does-not-exist",
        prompt: "hi",
        output: { to: "answer" },
      }),
      { providers: [capture], cwd: tmpDir },
    );
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("error");
    expect(r.error?.message).toMatch(/agent node "agent"/);
  });
});

describe("config.defaults provider/model", () => {
  it("uses config.defaults.provider and model when node omits them", async () => {
    let captured: AgentRequest | undefined;
    const capture = createScriptedProvider("defaults-prov", (req) => {
      captured = req;
      return { output: { ok: true }, stopReason: "done" };
    });

    const spec = {
      metadata: { name: "defaults-graph" },
      config: { defaults: { provider: "defaults-prov", model: "defaults-model" } },
      state: { channels: { answer: { type: "object" } } },
      nodes: [
        {
          id: "agent",
          type: "agent",
          with: { prompt: "hi", output: { to: "answer" } },
        },
      ],
      edges: [
        { from: "START", to: "agent" },
        { from: "agent", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;

    const compiled = await compileGraph(spec, { providers: [capture] });
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    expect(captured?.model).toBe("defaults-model");
  });

  it("node provider/model override config.defaults", async () => {
    let captured: AgentRequest | undefined;
    const capture = createScriptedProvider("node-prov", (req) => {
      captured = req;
      return { output: { ok: true }, stopReason: "done" };
    });
    const unused = createScriptedProvider("defaults-prov", () => ({
      output: { unused: true },
      stopReason: "done",
    }));

    const spec = {
      metadata: { name: "override-graph" },
      config: { defaults: { provider: "defaults-prov", model: "defaults-model" } },
      state: { channels: { answer: { type: "object" } } },
      nodes: [
        {
          id: "agent",
          type: "agent",
          provider: "node-prov",
          model: "node-model",
          with: { prompt: "hi", output: { to: "answer" } },
        },
      ],
      edges: [
        { from: "START", to: "agent" },
        { from: "agent", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;

    const compiled = await compileGraph(spec, { providers: [capture, unused] });
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    expect(captured?.model).toBe("node-model");
  });
});
