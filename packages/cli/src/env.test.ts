import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadDotenvFromCwd } from "./env.js";

describe("loadDotenvFromCwd", () => {
  let tmp: string;
  const prev = process.env["DOTENV_TEST_KEY"];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flowgraph-env-"));
    delete process.env["DOTENV_TEST_KEY"];
  });

  afterEach(() => {
    if (prev === undefined) delete process.env["DOTENV_TEST_KEY"];
    else process.env["DOTENV_TEST_KEY"] = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("loads keys from .env without overriding existing env", () => {
    process.env["DOTENV_TEST_KEY"] = "from-shell";
    fs.writeFileSync(path.join(tmp, ".env"), 'DOTENV_TEST_KEY="from-file"\nOTHER=1\n');
    loadDotenvFromCwd(tmp);
    expect(process.env["DOTENV_TEST_KEY"]).toBe("from-shell");
    expect(process.env["OTHER"]).toBe("1");
  });

  it("trims quoted values", () => {
    fs.writeFileSync(path.join(tmp, ".env"), 'DOTENV_TEST_KEY="  trimmed  "\n');
    loadDotenvFromCwd(tmp);
    expect(process.env["DOTENV_TEST_KEY"]).toBe("  trimmed  ");
  });
});
