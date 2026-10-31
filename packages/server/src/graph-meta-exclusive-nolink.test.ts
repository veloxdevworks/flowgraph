import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileExclusive } from "./graph-source.js";

// A filesystem without hard links: creating falls back to an exclusive open.
const link = vi.hoisted(() =>
  vi.fn(async () => {
    throw Object.assign(new Error("operation not permitted, link"), { code: "EPERM" });
  }),
);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, link, default: { ...actual, link } };
});

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe("createFileExclusive without hard links", () => {
  it("still creates the file once and refuses a second create with EEXIST", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-meta-nolink-"));
    dirs.push(dir);
    const target = path.join(dir, "x.json");
    await createFileExclusive(target, "first");
    await expect(createFileExclusive(target, "second")).rejects.toMatchObject({ code: "EEXIST" });
    expect(link).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(target, "utf-8")).toBe("first");
    expect(await fs.readdir(dir)).toEqual(["x.json"]);
  });
});
