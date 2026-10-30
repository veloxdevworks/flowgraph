import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { loadGraph, compileGraph, createScriptedProvider, type AgentRequest } from "@flowgraph/core";
import { openSqliteBackend, type SqliteBackend } from "@flowgraph/checkpoint-sqlite";
import "./register.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const graphPath = path.join(__dirname, "react-factory.graph.yaml");
const project = "github.com/acme/storefront";

function block(text: string | undefined, id: string): string {
  const m = (text ?? "").match(new RegExp(`<memory id="${id}"[^>]*>([\\s\\S]*?)</memory>`));
  return m?.[1] ?? "";
}

/** Fake front-end model: follows recalled conventions and saved preferences; saves stated ones. */
const calls: AgentRequest[] = [];
const frontendDev = createScriptedProvider("frontend-dev", async (req, ctx) => {
  calls.push(req);
  const conv = block(req.prompt, "conventions");
  const css = conv.match(/"css":"([^"]+)"/)?.[1] ?? "unknown";
  const tests = conv.match(/"tests":"([^"]+)"/)?.[1] ?? "unknown";
  let exportStyle = block(req.system, "prefs").includes('"prefs/exports": "named"') ? "named" : "default";
  if (/prefer named exports/i.test(req.prompt)) {
    await ctx.invokeTool("remember", { scope: "user", key: "exports", value: "named" });
    exportStyle = "named";
  }
  const name = String(req.prompt.match(/Build this feature: (.+)/)?.[1] ?? "Feature").replace(/\W+/g, "");
  return {
    output: { files: [`src/${name}.tsx`, `src/${name}.${tests === "vitest" ? "test" : "spec"}.tsx`], css, tests, exportStyle },
    stopReason: "done",
  };
});

let dir = "";
let db: SqliteBackend;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-react-factory-"));
  db = await openSqliteBackend(path.join(dir, "flowgraph.db"));
});
afterAll(async () => {
  db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function build(user: string, feature: Record<string, unknown>, repo: Record<string, unknown>, threadId: string) {
  const { spec } = await loadGraph(graphPath, { cwd: __dirname });
  if (!spec) throw new Error("failed to load graph");
  const graph = await compileGraph(spec, {
    cwd: __dirname,
    checkpointer: db.checkpointer,
    memory: { backend: db.memory, identity: { org: "acme", project, user } },
    providers: [frontendDev],
  });
  const r = await graph.run({ threadId, input: { feature, repo }, onInterrupt: "fail" });
  expect(r.status).toBe("completed");
  return { result: r.state["result"] as Record<string, unknown>, req: calls[calls.length - 1]!, state: r.state };
}

const repo = { dependencies: ["react", "tailwindcss", "vitest", "react-router"] };

describe("react-factory example", () => {
  it("stores project conventions once and every build follows them", async () => {
    const a = await build("alice@acme.test", { title: "Login form", notes: "I prefer named exports." }, repo, "f-1");
    expect(a.result).toMatchObject({ css: "tailwind", tests: "vitest", exportStyle: "named", files: ["src/Loginform.tsx", "src/Loginform.test.tsx"] });
    expect(block(a.req.prompt, "conventions")).toContain('[project ');
    expect(JSON.stringify(a.state)).not.toContain("<memory");
  });

  it("remembers the requester's preference for their next build only", async () => {
    const again = await build("alice@acme.test", { title: "Cart drawer" }, repo, "f-2");
    expect(block(again.req.system, "prefs")).toContain('"prefs/exports": "named"');
    expect(again.result["exportStyle"]).toBe("named");

    const bob = await build("bob@acme.test", { title: "Search bar" }, repo, "f-3");
    expect(block(bob.req.system, "prefs")).toContain("(nothing recalled)");
    expect(bob.result).toMatchObject({ css: "tailwind", exportStyle: "default" });
  });

  it("a convention change is a patch, seen by the next build", async () => {
    const r = await build("bob@acme.test", { title: "Footer" }, { dependencies: ["react", "styled-components", "jest"] }, "f-4");
    expect(r.result).toMatchObject({ css: "styled-components", tests: "jest" });
    const row = await db.memory.get(
      { org: "acme", project, graph: "", usr: "", subjectType: "", subjectKey: "" },
      "conventions/frontend",
    );
    expect(row?.value).toEqual({ css: "styled-components", tests: "jest", routing: "none" });
    expect(row?.version).toBe(4); // one patch per run
  });
});
