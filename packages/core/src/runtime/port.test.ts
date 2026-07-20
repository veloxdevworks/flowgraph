import { afterEach, describe, expect, it } from "vitest";
import * as net from "node:net";
import { findFreePorts } from "./port.js";

const held: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    held.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
});

async function occupy(port: number, host = "127.0.0.1"): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(port, host, () => {
      held.push(s);
      resolve(s);
    });
  });
}

describe("findFreePorts", () => {
  it("allocates a single free port by default", async () => {
    const ports = await findFreePorts();
    expect(ports).toHaveLength(1);
    expect(ports[0]).toBeGreaterThan(0);
  });

  it("allocates distinct ports within a batch", async () => {
    const ports = await findFreePorts({ count: 5 });
    expect(ports).toHaveLength(5);
    expect(new Set(ports).size).toBe(5);
  });

  it("honors a free preferred port", async () => {
    // Grab an ephemeral port, release it, then prefer it (best-effort).
    const [probe] = await findFreePorts();
    const ports = await findFreePorts({ preferred: probe });
    expect(ports[0]).toBe(probe);
  });

  it("falls back when preferred is taken", async () => {
    const [preferred] = await findFreePorts();
    await occupy(preferred!);
    const ports = await findFreePorts({ preferred });
    expect(ports).toHaveLength(1);
    expect(ports[0]).not.toBe(preferred);
    expect(ports[0]).toBeGreaterThan(0);
  });

  it("falls back per preferred slot in a multi-port batch", async () => {
    const [a, b] = await findFreePorts({ count: 2 });
    await occupy(a!);
    const ports = await findFreePorts({ count: 2, preferred: [a!, b!] });
    expect(ports).toHaveLength(2);
    expect(ports[0]).not.toBe(a);
    expect(ports[1]).toBe(b);
    expect(new Set(ports).size).toBe(2);
  });

  it("rejects count < 1", async () => {
    await expect(findFreePorts({ count: 0 })).rejects.toThrow(/count must be >= 1/);
  });
});
