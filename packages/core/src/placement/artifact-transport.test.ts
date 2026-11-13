import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpTransport } from "./http-transport.js";

let dir: string;
let server: http.Server;
let target: { name: string; url: string; token?: string };
const blobs = new Map<string, Buffer>();
const seen: Array<{ method: string; url: string; auth?: string; length?: string }> = [];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-atransport-"));
  blobs.clear();
  seen.length = 0;
  server = http.createServer((req, res) => {
    seen.push({ method: req.method!, url: req.url!, ...(req.headers.authorization ? { auth: req.headers.authorization } : {}), ...(req.headers["content-length"] ? { length: req.headers["content-length"] } : {}) });
    const sha = req.url!.split("/").pop()!;
    if (req.method === "HEAD") {
      res.writeHead(blobs.has(sha) ? 200 : 404).end();
    } else if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        blobs.set(sha, Buffer.concat(chunks));
        res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      });
    } else if (req.method === "GET" && req.url!.startsWith("/worker/runs/t%2Fn%2F1/artifacts/")) {
      const b = blobs.get(sha);
      if (!b) res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "no such artifact", code: "ARTIFACT_NOT_FOUND" }));
      else res.writeHead(200).end(b);
    } else res.writeHead(500).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  target = { name: "w", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "tok" };
});
afterEach(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  await fs.rm(dir, { recursive: true, force: true });
});

describe("http transport artifacts", () => {
  it("has / put / get stream over the worker routes", async () => {
    const t = createHttpTransport();
    const content = Buffer.alloc(300_000, "abc");
    const sha = createHash("sha256").update(content).digest("hex");
    const src = path.join(dir, "src.bin");
    await fs.writeFile(src, content);

    expect(await t.hasArtifact(target, sha)).toBe(false);
    await t.putArtifact(target, sha, src);
    expect(blobs.get(sha)?.equals(content)).toBe(true);
    expect(await t.hasArtifact(target, sha)).toBe(true);

    const dest = path.join(dir, "dest.bin");
    expect(await t.getArtifact(target, { threadId: "t/n/1", sha256: sha }, dest)).toEqual({ sha256: sha, sizeBytes: content.length });
    expect((await fs.readFile(dest)).equals(content)).toBe(true);

    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      `HEAD /worker/artifacts/${sha}`,
      `PUT /worker/artifacts/${sha}`,
      `HEAD /worker/artifacts/${sha}`,
      `GET /worker/runs/t%2Fn%2F1/artifacts/${sha}`,
    ]);
    expect(seen.every((s) => s.auth === "Bearer tok")).toBe(true);
    expect(seen[1]!.length).toBe(String(content.length));
  });

  it("reports the status and code of a refused download", async () => {
    const t = createHttpTransport();
    await expect(t.getArtifact(target, { threadId: "t/n/1", sha256: "0".repeat(64) }, path.join(dir, "x"))).rejects.toThrow(/returned 404.*ARTIFACT_NOT_FOUND/);
  });

  it("aborts a transfer when the signal fires", async () => {
    const t = createHttpTransport();
    const ac = new AbortController();
    ac.abort();
    const src = path.join(dir, "s");
    await fs.writeFile(src, "x");
    await expect(t.putArtifact(target, "a".repeat(64), src, { signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
    await expect(t.hasArtifact(target, "a".repeat(64), { signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
