import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { classifyAddress, guardedFetch, hostIsAllowListed, type OutboundHttpPolicy } from "./outbound-http.js";

describe("classifyAddress", () => {
  const blocked: Array<[string, string]> = [
    ["127.0.0.1", "loopback"],
    ["127.255.0.9", "loopback"],
    ["0.0.0.0", "unspecified"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "cgnat"],
    ["100.127.255.254", "cgnat"],
    ["169.254.169.254", "metadata"],
    ["169.254.170.2", "metadata"],
    ["169.254.1.1", "link-local"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "reserved"],
    ["198.18.0.1", "reserved"],
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fd00:ec2::254", "metadata"],
    ["fc00::1", "private"],
    ["fd12:3456::1", "private"],
    ["fe80::1", "link-local"],
    ["fe80::1%eth0", "link-local"],
    ["ff02::1", "multicast"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["::ffff:169.254.169.254", "metadata"],
    ["::ffff:0:10.0.0.1", "private"],
    ["64:ff9b::10.0.0.1", "private"],
    ["64:ff9b::a9fe:a9fe", "metadata"],
    ["2002:7f00:1::", "loopback"],
    ["2002:c0a8:101::1", "private"],
    ["2001:db8::1", "reserved"],
    ["[::1]", "loopback"],
  ];
  it.each(blocked)("refuses %s (%s)", (ip, reason) => {
    expect(classifyAddress(ip)).toMatchObject({ blocked: true, reason });
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001::200e", "::ffff:8.8.8.8", "64:ff9b::808:808"])(
    "allows public %s",
    (ip) => {
      expect(classifyAddress(ip)).toEqual({ blocked: false });
    },
  );

  it("marks metadata and link-local as blocked even for allow-listed hosts", () => {
    expect(classifyAddress("169.254.169.254").always).toBe(true);
    expect(classifyAddress("fd00:ec2::254").always).toBe(true);
    expect(classifyAddress("fe80::2").always).toBe(true);
    expect(classifyAddress("10.0.0.1").always).toBeUndefined();
  });

  it("refuses text that is not an address", () => {
    expect(classifyAddress("example.com").blocked).toBe(true);
  });
});

describe("hostIsAllowListed", () => {
  const u = (s: string) => new URL(s);
  it("matches host, host:port, wildcard and IPv6 entries", () => {
    expect(hostIsAllowListed(u("http://api.internal/x"), ["api.internal"])).toBe(true);
    expect(hostIsAllowListed(u("http://api.internal:8080/x"), ["api.internal:8080"])).toBe(true);
    expect(hostIsAllowListed(u("http://api.internal:9090/x"), ["api.internal:8080"])).toBe(false);
    expect(hostIsAllowListed(u("https://api.internal/x"), ["api.internal:443"])).toBe(true);
    expect(hostIsAllowListed(u("http://a.svc.local/"), ["*.svc.local"])).toBe(true);
    expect(hostIsAllowListed(u("http://svc.local/"), ["*.svc.local"])).toBe(false);
    expect(hostIsAllowListed(u("http://evilsvc.local/"), ["*.svc.local"])).toBe(false);
    expect(hostIsAllowListed(u("http://[::1]:81/"), ["[::1]:81"])).toBe(true);
    expect(hostIsAllowListed(u("http://API.Internal/"), ["api.internal"])).toBe(true);
    expect(hostIsAllowListed(u("http://api.internal/"), undefined)).toBe(false);
  });
});

type Hit = { url: string; method: string; auth?: string };
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise((r) => {
          s.close(r);
          s.closeAllConnections();
        }),
    ),
  );
});

async function server(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ port: number; hits: Hit[] }> {
  const hits: Hit[] = [];
  const s = http.createServer((req, res) => {
    hits.push({ url: req.url ?? "", method: req.method ?? "", ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
    handler(req, res);
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { port: (s.address() as AddressInfo).port, hits };
}

const PUBLIC: OutboundHttpPolicy = { publicOnly: true };

describe("guardedFetch", () => {
  it("refuses loopback, localhost and non-http schemes without connecting", async () => {
    const s = await server((_q, r) => r.end("hi"));
    await expect(guardedFetch(`http://127.0.0.1:${s.port}/`, {}, PUBLIC)).rejects.toMatchObject({ code: "OUTBOUND_ADDRESS_BLOCKED" });
    await expect(guardedFetch(`http://localhost:${s.port}/`, {}, PUBLIC)).rejects.toMatchObject({ code: "OUTBOUND_ADDRESS_BLOCKED" });
    await expect(guardedFetch(`http://[::ffff:127.0.0.1]:${s.port}/`, {}, PUBLIC)).rejects.toMatchObject({ code: "OUTBOUND_ADDRESS_BLOCKED" });
    await expect(guardedFetch(`http://0x7f000001:${s.port}/`, {}, PUBLIC)).rejects.toMatchObject({ code: "OUTBOUND_ADDRESS_BLOCKED" });
    await expect(guardedFetch("file:///etc/passwd", {}, PUBLIC)).rejects.toMatchObject({ code: "OUTBOUND_URL_BLOCKED" });
    await expect(guardedFetch("not a url", {}, PUBLIC)).rejects.toMatchObject({ code: "OUTBOUND_URL_BLOCKED" });
    expect(s.hits).toEqual([]);
  });

  it("checks every address a name resolves to", async () => {
    const resolve = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ];
    await expect(guardedFetch("http://rebind.example/", {}, PUBLIC, { resolve })).rejects.toMatchObject({
      code: "OUTBOUND_ADDRESS_BLOCKED",
      message: expect.stringContaining("10.0.0.5, a private address"),
    });
    const meta = async () => [{ address: "fd00:ec2::254", family: 6 }];
    await expect(guardedFetch("http://meta.example/", {}, PUBLIC, { resolve: meta })).rejects.toMatchObject({ code: "OUTBOUND_ADDRESS_BLOCKED" });
  });

  it("reaches an allow-listed host and returns a Response", async () => {
    const s = await server((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ method: req.method }));
    });
    const r = await guardedFetch(`http://127.0.0.1:${s.port}/ok`, { method: "POST", body: "{}" }, { publicOnly: true, allowHosts: [`127.0.0.1:${s.port}`] });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ method: "POST" });
  });

  it("re-checks redirects and never connects to a blocked hop", async () => {
    const inner = await server((_q, r) => r.end("secret"));
    const outer = await server((req, res) => {
      const to: Record<string, string> = {
        "/to-inner": `http://127.0.0.1:${inner.port}/admin`,
        "/to-metadata": "http://169.254.169.254/latest/meta-data/",
        "/to-v6-metadata": "http://[fd00:ec2::254]/latest/",
        "/to-self": "/final",
      };
      if (req.url && to[req.url]) {
        res.statusCode = 302;
        res.setHeader("location", to[req.url]!);
        return res.end();
      }
      res.end("final");
    });
    const policy: OutboundHttpPolicy = { publicOnly: true, allowHosts: [`127.0.0.1:${outer.port}`] };
    const base = `http://127.0.0.1:${outer.port}`;
    for (const p of ["/to-inner", "/to-metadata", "/to-v6-metadata"]) {
      await expect(guardedFetch(`${base}${p}`, {}, policy)).rejects.toMatchObject({
        code: "OUTBOUND_ADDRESS_BLOCKED",
        message: expect.stringContaining("after a redirect"),
      });
    }
    expect(inner.hits).toEqual([]);
    const r = await guardedFetch(`${base}/to-self`, {}, policy);
    expect(await r.text()).toBe("final");
  });

  it("keeps metadata blocked even when it is allow-listed", async () => {
    await expect(
      guardedFetch("http://169.254.169.254/latest/", {}, { publicOnly: true, allowHosts: ["169.254.169.254"] }),
    ).rejects.toMatchObject({ code: "OUTBOUND_ADDRESS_BLOCKED" });
  });

  it("drops credentials on a cross-origin redirect and turns a 303 into GET", async () => {
    const b = await server((_q, r) => r.end("b"));
    const a = await server((_q, res) => {
      res.statusCode = 303;
      res.setHeader("location", `http://127.0.0.1:${b.port}/landing`);
      res.end();
    });
    const policy: OutboundHttpPolicy = { publicOnly: true, allowHosts: [`127.0.0.1:${a.port}`, `127.0.0.1:${b.port}`] };
    const r = await guardedFetch(`http://127.0.0.1:${a.port}/`, { method: "POST", body: "x", headers: { Authorization: "Bearer t" } }, policy);
    expect(await r.text()).toBe("b");
    expect(a.hits[0]).toMatchObject({ method: "POST", auth: "Bearer t" });
    expect(b.hits[0]).toEqual({ url: "/landing", method: "GET" });
  });

  it("caps the response size, declared or streamed", async () => {
    const big = "x".repeat(4096);
    const s = await server((q, res) => {
      if (q.url === "/declared") {
        res.setHeader("content-length", String(big.length));
        res.end(big);
        return;
      }
      // Chunked, no length up front.
      res.write(big.slice(0, 2048));
      res.end(big.slice(2048));
    });
    const policy = { publicOnly: true, allowHosts: [`127.0.0.1:${s.port}`], maxResponseBytes: 1000 };
    await expect(guardedFetch(`http://127.0.0.1:${s.port}/declared`, {}, policy)).rejects.toMatchObject({ code: "OUTBOUND_RESPONSE_TOO_LARGE" });
    await expect(guardedFetch(`http://127.0.0.1:${s.port}/chunked`, {}, policy)).rejects.toMatchObject({ code: "OUTBOUND_RESPONSE_TOO_LARGE" });
    const ok = await guardedFetch(`http://127.0.0.1:${s.port}/chunked`, {}, { ...policy, maxResponseBytes: 4096 });
    expect((await ok.text()).length).toBe(4096);
  });

  it("times out a server that never finishes the response", async () => {
    const s = await server((_q, res) => {
      res.write("partial");
    });
    const policy = { publicOnly: true, allowHosts: [`127.0.0.1:${s.port}`], timeoutMs: 150 };
    const t0 = Date.now();
    await expect(guardedFetch(`http://127.0.0.1:${s.port}/`, {}, policy)).rejects.toMatchObject({ code: "OUTBOUND_TIMEOUT" });
    expect(Date.now() - t0).toBeLessThan(2_000);
    // A caller's own abort is reported as that abort, not as a timeout.
    const ac = new AbortController();
    const p = guardedFetch(`http://127.0.0.1:${s.port}/`, { signal: ac.signal }, { ...policy, timeoutMs: 5_000 });
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.not.toMatchObject({ code: "OUTBOUND_TIMEOUT" });
  });

  it("stops after too many redirects", async () => {
    const s = await server((_q, res) => {
      res.statusCode = 307;
      res.setHeader("location", "/again");
      res.end();
    });
    await expect(
      guardedFetch(`http://127.0.0.1:${s.port}/`, {}, { publicOnly: true, allowHosts: [`127.0.0.1:${s.port}`], maxRedirects: 2 }),
    ).rejects.toThrow(/more than 2 redirects/);
    expect(s.hits).toHaveLength(3);
  });
});

function oneNode(node: unknown): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "outbound" },
    state: { channels: { out: { type: "object" } } },
    nodes: [node],
    edges: [
      { from: "START", to: (node as { id: string }).id },
      { from: (node as { id: string }).id, to: "END" },
    ],
  } as unknown as GraphSpec;
}

describe("http and webhook nodes under an outbound policy", () => {
  it("refuse a loopback target the node would otherwise reach", async () => {
    const s = await server((_q, r) => r.end("hi"));
    for (const node of [
      { id: "h", type: "http", with: { url: `http://127.0.0.1:${s.port}/`, output: { to: "out" } } },
      { id: "w", type: "webhook", with: { url: `http://127.0.0.1:${s.port}/`, output: { to: "out" } } },
    ]) {
      const g = await compileGraph(oneNode(node), { checkpointer: "memory", nodePolicy: { outboundHttp: PUBLIC } });
      const r = await g.run({ input: {} });
      expect(r.status).toBe("error");
      expect(String((r.error as Error)?.message ?? r.error)).toMatch(/127\.0\.0\.1, a loopback address/);
    }
    expect(s.hits).toEqual([]);
    const open = await compileGraph(oneNode({ id: "h", type: "http", with: { url: `http://127.0.0.1:${s.port}/`, output: { to: "out" } } }), {
      checkpointer: "memory",
    });
    expect((await open.run({ input: {} })).status).toBe("completed");
    expect(s.hits).toHaveLength(1);
  });

  it("follow an allow-listed host", async () => {
    const s = await server((_q, res) => {
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
    });
    const g = await compileGraph(oneNode({ id: "h", type: "http", with: { url: `http://127.0.0.1:${s.port}/`, output: { to: "out" } } }), {
      checkpointer: "memory",
      nodePolicy: { outboundHttp: { publicOnly: true, allowHosts: [`127.0.0.1:${s.port}`] } },
    });
    const r = await g.run({ input: {} });
    expect(r.status).toBe("completed");
    expect(r.state?.out).toMatchObject({ status: 200, body: { ok: true } });
  });
});
