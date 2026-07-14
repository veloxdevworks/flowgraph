import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import {
  loadGraph,
  compileGraph,
  createScriptedProvider,
  loadGraphImports,
  validateSpec,
} from "@veloxdevworks/flowgraph-core";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const graphPath = path.join(__dirname, "self-improve.graph.yaml");
const pausedPath = path.join(__dirname, "PAUSED");

const plannerProvider = createScriptedProvider("planner", (req) => {
  if (process.env["SELF_IMPROVE_TEST_NO_PROCEED"] === "1") {
    return {
      output: { proceed: false, reason: "nothing to do this cycle" },
      stopReason: "done",
      usage: { totalTokens: 1 },
    };
  }
  return {
    output: {
      proceed: true,
      title: "Improve CLI validate docs",
      description: "Clarify validate --preflight in 09-cli.md",
      docsOnly: true,
      targets: ["docs/09-cli.md"],
    },
    stopReason: "done",
    usage: { totalTokens: 1 },
  };
});

let reviewApprovals = 0;
const coderProvider = createScriptedProvider("coder", (req) => {
  if (req.schema && "approved" in ((req.schema as { properties?: object }).properties ?? {})) {
    return {
      output: { approved: true, feedback: "looks good" },
      stopReason: "done",
      usage: { totalTokens: 1 },
    };
  }
  reviewApprovals += 1;
  return {
    output: { text: "implemented" },
    stopReason: "done",
    usage: { totalTokens: 1 },
  };
});

async function compileWithEnv(extraEnv: Record<string, string | undefined> = {}) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(extraEnv)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  const { spec } = await loadGraph(graphPath, { cwd: __dirname });
  if (!spec) throw new Error("failed to load graph");
  await loadGraphImports(spec, { cwd: __dirname });
  const diags = validateSpec(spec);
  const errors = diags.filter((d) => d.severity === "error");
  if (errors.length > 0) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }

  const graph = await compileGraph(spec, {
    cwd: __dirname,
    checkpointer: "none",
    providers: [plannerProvider, coderProvider],
  });

  return {
    graph,
    restore: () => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

describe("self-improve automation", () => {
  beforeEach(() => {
    reviewApprovals = 0;
    process.env["SELF_IMPROVE_DRY_RUN"] = "1";
    delete process.env["SELF_IMPROVE_TEST_SKIP"];
    delete process.env["SELF_IMPROVE_TEST_NO_PROCEED"];
    delete process.env["SELF_IMPROVE_TEST_GATE_FAIL"];
    delete process.env["SELF_IMPROVE_TEST_OPEN_PR"];
    if (fs.existsSync(pausedPath)) fs.unlinkSync(pausedPath);
  });

  afterEach(() => {
    if (fs.existsSync(pausedPath)) fs.unlinkSync(pausedPath);
  });

  it("ends immediately when PAUSED file is present", async () => {
    fs.writeFileSync(pausedPath, "vacation\n", "utf8");
    const { graph, restore } = await compileWithEnv();
    try {
      const result = await graph.run({ threadId: "si-paused", onInterrupt: "fail" });
      expect(result.status).toBe("completed");
      expect((result.state["outcome"] as { status: string }).status).toBe("paused");
      expect(reviewApprovals).toBe(0);
    } finally {
      restore();
    }
  });

  it("records skip when an automation PR is already open", async () => {
    const { graph, restore } = await compileWithEnv({ SELF_IMPROVE_TEST_SKIP: "1" });
    try {
      const result = await graph.run({ threadId: "si-skip", onInterrupt: "fail" });
      expect(result.status).toBe("completed");
      expect((result.state["outcome"] as { status: string }).status).toBe("skipped");
      expect(reviewApprovals).toBe(0);
    } finally {
      restore();
    }
  });

  it("no-ops when planner returns proceed false", async () => {
    const { graph, restore } = await compileWithEnv({ SELF_IMPROVE_TEST_NO_PROCEED: "1" });
    try {
      const result = await graph.run({ threadId: "si-noop", onInterrupt: "fail" });
      expect(result.status).toBe("completed");
      expect((result.state["outcome"] as { status: string }).status).toBe("no-op");
      expect(reviewApprovals).toBe(0);
    } finally {
      restore();
    }
  });

  it("abandons after repeated quality-gate failures", async () => {
    const { graph, restore } = await compileWithEnv({ SELF_IMPROVE_TEST_GATE_FAIL: "1" });
    try {
      const result = await graph.run({ threadId: "si-gate-fail", onInterrupt: "fail" });
      expect(result.status).toBe("completed");
      expect((result.state["outcome"] as { status: string }).status).toBe("abandoned");
      expect(reviewApprovals).toBeGreaterThanOrEqual(3);
    } finally {
      restore();
    }
  });

  it("records runtime-failed when CURSOR_API_KEY is missing (live preflight)", async () => {
    const { graph, restore } = await compileWithEnv({
      SELF_IMPROVE_DRY_RUN: undefined,
      CURSOR_API_KEY: undefined,
    });
    try {
      const result = await graph.run({ threadId: "si-runtime", onInterrupt: "fail" });
      expect(result.status).toBe("completed");
      expect((result.state["outcome"] as { status: string }).status).toBe("runtime-failed");
      expect(reviewApprovals).toBe(0);
    } finally {
      restore();
    }
  });

  it("opens a PR on the happy path", async () => {
    const { graph, restore } = await compileWithEnv({ SELF_IMPROVE_TEST_OPEN_PR: "1" });
    try {
      const result = await graph.run({ threadId: "si-ok", onInterrupt: "fail" });
      expect(result.status).toBe("completed");
      expect((result.state["outcome"] as { status: string }).status).toBe("pr-opened");
      expect((result.state["pr"] as { prUrl: string }).prUrl).toContain("github.com");
    } finally {
      restore();
    }
  });
});
