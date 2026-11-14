import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLangChainProviderFromConfig } from "./factory.js";

// Each fake vendor class records the options it was constructed with.
const VENDORS = [
  { vendor: "xai", pkg: "@langchain/xai", cls: "ChatXAI", field: "baseURL" },
  {
    vendor: "anthropic",
    pkg: "@langchain/anthropic",
    cls: "ChatAnthropic",
    field: "anthropicApiUrl",
  },
  { vendor: "ollama", pkg: "@langchain/ollama", cls: "ChatOllama", field: "baseUrl" },
] as const;

describe("PLAT-308: baseUrl reaches each vendor client under the option it reads", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "fg-qa-base-url-"));
    vi.stubEnv("FGQA_KEY", "sk-qa-base-url-decoy");
    vi.stubEnv("FGQA_OPTIONS_FILE", join(cwd, "options.json"));
    writeFileSync(join(cwd, "package.json"), '{"type":"module"}');
    for (const { pkg, cls } of VENDORS) {
      const dir = join(cwd, "node_modules", pkg);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), '{"type":"module","main":"index.js"}');
      writeFileSync(
        join(dir, "index.js"),
        `import { writeFileSync } from 'node:fs';
        export class ${cls} {
          constructor(options) { writeFileSync(process.env.FGQA_OPTIONS_FILE, JSON.stringify(options)); }
          bindTools() { return this; }
          async invoke() { throw new Error('not used'); }
        }`,
      );
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  });

  it.each(VENDORS)("$vendor uses $field", async ({ vendor, field }) => {
    await createLangChainProviderFromConfig(
      "qa",
      { vendor, model: "test-model", apiKeyEnv: "FGQA_KEY", baseUrl: "http://127.0.0.1:1/v1" },
      { cwd },
    );
    const options = JSON.parse(readFileSync(join(cwd, "options.json"), "utf8"));
    expect(options[field]).toBe("http://127.0.0.1:1/v1");
  });
});
