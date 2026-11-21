import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLangChainChatModelFromConfig, createLangChainProviderFromConfig } from "./factory.js";

describe("LangChain factory reads only declared keys", () => {
  let cwd: string;
  const optionsFile = () => join(cwd, "options.json");
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "fg-declared-key-"));
    vi.stubEnv("FGQA_DECLARED_KEY", "sk-declared-value");
    vi.stubEnv("OPENAI_API_KEY", "sk-default-openai");
    vi.stubEnv("FGQA_OPTIONS_FILE", optionsFile());
    const pkg = join(cwd, "node_modules/@langchain/openai");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(cwd, "package.json"), '{"type":"module"}');
    writeFileSync(join(pkg, "package.json"), '{"type":"module","main":"index.js"}');
    writeFileSync(
      join(pkg, "index.js"),
      `import { writeFileSync } from 'node:fs';
      export class ChatOpenAI {
        constructor(options) { writeFileSync(process.env.FGQA_OPTIONS_FILE, JSON.stringify(options)); }
        bindTools() { return this; }
        async invoke() { throw new Error('not used'); }
      }`,
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("refuses an undeclared apiKeyEnv before reading it", async () => {
    await expect(
      createLangChainProviderFromConfig("lc", { vendor: "openai", apiKeyEnv: "FGQA_DECLARED_KEY" }, { cwd }),
    ).rejects.toMatchObject({
      code: "SECRET_UNDECLARED",
      message: expect.stringContaining("Add FGQA_DECLARED_KEY to the top-level secrets: list"),
    });
    expect(existsSync(optionsFile())).toBe(false);
  });

  it("reads a declared apiKeyEnv", async () => {
    await createLangChainProviderFromConfig(
      "lc",
      { vendor: "openai", apiKeyEnv: "FGQA_DECLARED_KEY" },
      { cwd, secrets: ["FGQA_DECLARED_KEY"] },
    );
    expect(JSON.parse(readFileSync(optionsFile(), "utf8"))).toMatchObject({ apiKey: "sk-declared-value" });
  });

  it("refuses to send an undeclared default key to a baseUrl", async () => {
    await expect(
      createLangChainChatModelFromConfig("lc", { vendor: "openai", baseUrl: "http://127.0.0.1:1/v1" }, { cwd }),
    ).rejects.toThrow(/sends its default API key OPENAI_API_KEY to baseUrl.*Add OPENAI_API_KEY/);
    expect(existsSync(optionsFile())).toBe(false);
  });

  it("uses the vendor default key without a declaration when no baseUrl is set", async () => {
    await createLangChainProviderFromConfig("lc", { vendor: "openai" }, { cwd });
    expect(JSON.parse(readFileSync(optionsFile(), "utf8"))).toMatchObject({ apiKey: "sk-default-openai" });
  });
});
