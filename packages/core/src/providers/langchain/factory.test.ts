import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { isKnownLangChainVendor, LANGCHAIN_VENDORS } from "./factory.js";

describe("LangChain provider factory", () => {
  it("recognizes known LangChain vendors", () => {
    for (const v of LANGCHAIN_VENDORS) {
      expect(isKnownLangChainVendor(v)).toBe(true);
    }
    expect(isKnownLangChainVendor("unknown")).toBe(false);
  });

  it("includes bedrock as a known vendor", () => {
    expect(isKnownLangChainVendor("bedrock")).toBe(true);
    expect(LANGCHAIN_VENDORS).toContain("bedrock");
  });

  it("createLangChainProviderFromConfig fails for unknown vendor", async () => {
    const { createLangChainProviderFromConfig } = await import("./factory.js");
    await expect(
      createLangChainProviderFromConfig("bad", {
        kind: "langchain",
        vendor: "not-a-vendor" as "openai",
      }),
    ).rejects.toThrow(/Unknown LangChain vendor/);
  });

  it("createLangChainProviderFromConfig fails when vendor package is missing", async () => {
    const { createLangChainProviderFromConfig } = await import("./factory.js");
    await expect(
      createLangChainProviderFromConfig("openai", {
        kind: "langchain",
        vendor: "openai",
        model: "gpt-4o",
      }),
    ).rejects.toThrow(/not installed|Missing API key/);
  });
});

// The bedrock branch loads `@langchain/aws`, which is an optional peer dep and
// not installed in this monorepo. The vendor loader resolves packages via
// createRequire relative to `cwd`, so we point `cwd` at a temp directory that
// contains a fake `@langchain/aws` package. This exercises the real
// construction path (ChatBedrockConverse + region/credentials) without a real
// install and without any AWS calls.
describe("LangChain provider factory — bedrock construction", () => {
  let tmpDir: string;
  let ctorOutPath: string;
  const AWS_ENV_VARS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flowgraph-bedrock-"));
    ctorOutPath = path.join(tmpDir, "ctor-opts.json");
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "bedrock-test-cwd" }));
    const pkgDir = path.join(tmpDir, "node_modules", "@langchain", "aws");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "@langchain/aws", version: "0.0.0-test", type: "module", main: "./index.js" }),
    );
    // Fake vendor package: records the constructor options to a file so the
    // test can assert them across the vitest/native module boundary.
    fs.writeFileSync(
      path.join(pkgDir, "index.js"),
      'import { writeFileSync } from "node:fs";\n' +
        "export class ChatBedrockConverse {\n" +
        "  constructor(opts) {\n" +
        "    writeFileSync(process.env.FLOWGRAPH_BEDROCK_CTOR_OUT, JSON.stringify(opts ?? null));\n" +
        "  }\n" +
        "}\n",
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const key of AWS_ENV_VARS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    delete process.env["FLOWGRAPH_BEDROCK_CTOR_OUT"];
    if (fs.existsSync(ctorOutPath)) fs.rmSync(ctorOutPath);
  });

  function stashAwsEnv(): void {
    for (const key of AWS_ENV_VARS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env["FLOWGRAPH_BEDROCK_CTOR_OUT"] = ctorOutPath;
  }

  function readCtorOpts(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(ctorOutPath, "utf8")) as Record<string, unknown>;
  }

  it("constructs ChatBedrockConverse with region and explicit credentials when AWS env vars are present", async () => {
    stashAwsEnv();
    process.env["AWS_ACCESS_KEY_ID"] = "AKIA_TEST";
    process.env["AWS_SECRET_ACCESS_KEY"] = "secret_test";
    process.env["AWS_SESSION_TOKEN"] = "session_test";

    const { createLangChainProviderFromConfig } = await import("./factory.js");
    const provider = await createLangChainProviderFromConfig(
      "bedrock",
      {
        kind: "langchain",
        vendor: "bedrock",
        model: "us.anthropic.claude-3-5-sonnet-20240620-v1:0",
        region: "us-east-1",
      },
      { cwd: tmpDir },
    );

    expect(provider.name).toBe("bedrock");
    const opts = readCtorOpts();
    expect(opts["model"]).toBe("us.anthropic.claude-3-5-sonnet-20240620-v1:0");
    expect(opts["region"]).toBe("us-east-1");
    expect(opts["credentials"]).toEqual({
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "secret_test",
      sessionToken: "session_test",
    });
    // Bedrock must NOT go through the single-string apiKey path.
    expect(opts["apiKey"]).toBeUndefined();
  });

  it("omits credentials for bedrock when AWS env vars are absent (defers to AWS default chain)", async () => {
    stashAwsEnv();

    const { createLangChainProviderFromConfig } = await import("./factory.js");
    await createLangChainProviderFromConfig(
      "bedrock",
      {
        kind: "langchain",
        vendor: "bedrock",
        model: "us.anthropic.claude-3-5-sonnet-20240620-v1:0",
        region: "us-west-2",
      },
      { cwd: tmpDir },
    );

    const opts = readCtorOpts();
    expect(opts["region"]).toBe("us-west-2");
    expect(opts["credentials"]).toBeUndefined();
    expect(opts["apiKey"]).toBeUndefined();
  });
});
