import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, "../dist/bin.js"), ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

it("a correctly configured run with a per-node model override passes --fail-on-issues", async () => {
  const models: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += String(d); });
    req.on("end", () => {
      models.push(String((JSON.parse(body || "{}") as { model?: unknown }).model));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "chatcmpl-1", object: "chat.completion", created: 0, model: "m",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "done" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  const cwd = mkdtempSync(join(tmpdir(), "fg-override-issues-"));
  try {
    writeFileSync(join(cwd, "flow.yaml"), JSON.stringify({
      apiVersion: "flowgraph/v1", kind: "Graph", metadata: { name: "override-issues" },
      secrets: ["FGQA_OVERRIDE_KEY"],
      providers: { lc: { kind: "langchain", vendor: "openai", model: "default-model", apiKeyEnv: "FGQA_OVERRIDE_KEY", baseUrl: `http://127.0.0.1:${port}/v1` } },
      nodes: [{ id: "ask", type: "agent", provider: "lc", model: "override-model", with: { prompt: "Say done" } }],
      edges: [{ from: "START", to: "ask" }, { from: "ask", to: "END" }],
      runtime: { checkpoint: { backend: "memory" } },
    }));
    const env = { ...process.env, FGQA_OVERRIDE_KEY: "test-key-not-real" };
    const validate = await runCli(["validate", "flow.yaml", "--json"], cwd, env);
    expect(validate.stdout + validate.stderr).not.toContain("PROVIDER_MODEL_UNKNOWN");
    const run = await runCli(["run", "flow.yaml", "--fail-on-issues", "--json"], cwd, env);
    expect(run.stdout + run.stderr).not.toContain("PROVIDER_MODEL_UNKNOWN");
    expect(run.code, run.stderr).toBe(0);
    expect(models).toContain("override-model");
  } finally {
    server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);
