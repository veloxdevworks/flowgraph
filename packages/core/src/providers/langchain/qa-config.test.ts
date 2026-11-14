import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLangChainProviderFromConfig } from "./factory.js";
import { compileGraph } from "../../compiler.js";
import type { GraphSpec } from "@flowgraph/spec";

describe("PLAT-308 / PLAT-347: provider endpoint and error boundaries", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "fg-qa-provider-"));
    vi.stubEnv("FGQA_KEY", "sk-qa-prefix-credential-tail");
    vi.stubEnv("FGQA_OPTIONS_FILE", join(cwd, "options.json"));
    const pkg = join(cwd, "node_modules/@langchain/openai");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(cwd, "package.json"), '{"type":"module"}');
    writeFileSync(join(pkg, "package.json"), '{"type":"module","main":"index.js"}');
    writeFileSync(
      join(pkg, "index.js"),
      `
      import { writeFileSync } from 'node:fs';
      export class ChatOpenAI {
        constructor(options) { writeFileSync(process.env.FGQA_OPTIONS_FILE, JSON.stringify(options)); }
        bindTools() { return this; }
        async invoke() { throw new Error('401 Incorrect API key provided: sk-qa-pr********tail. Use another key.'); }
      }
    `,
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  });

  async function provider() {
    return createLangChainProviderFromConfig(
      "qa",
      {
        vendor: "openai",
        model: "test-model",
        apiKeyEnv: "FGQA_KEY",
        baseUrl: "http://127.0.0.1:1/v1",
        options: { configuration: { baseURL: "https://unwanted.invalid", timeout: 1 } },
      },
      { cwd },
    );
  }

  it("uses the documented endpoint and explicit key env while preserving other client options", async () => {
    await provider();
    expect(JSON.parse(readFileSync(join(cwd, "options.json"), "utf8"))).toMatchObject({
      apiKey: "sk-qa-prefix-credential-tail",
      configuration: { baseURL: "http://127.0.0.1:1/v1", timeout: 1 },
    });
  });

  it("keeps key fragments out of errors and public events", async () => {
    const events: unknown[] = [];
    const compiled = await compileGraph(
      {
        metadata: { name: "provider-errors" },
        nodes: [{ id: "ask", type: "agent", provider: "qa", with: { prompt: "hello" } }],
        edges: [
          { from: "START", to: "ask" },
          { from: "ask", to: "END" },
        ],
        runtime: { checkpoint: { enabled: false } },
      } as unknown as GraphSpec,
      {
        providers: [await provider()],
        sinks: [
          (event) => {
            events.push(event);
          },
        ],
      },
    );
    const result = await compiled.run();
    expect(result.status).toBe("error");
    const visible = JSON.stringify(events) + result.error?.message + result.error?.stack;
    expect(visible).not.toContain("sk-qa-pr");
    expect(visible).not.toContain("********tail");
    expect(visible).toContain("REDACTED");
  });
});
