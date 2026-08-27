import { describe, expect, it } from "vitest";
import { isEphemeralGraphStore, processIdentity } from "./diagnostics.js";
import type { ServerConfig } from "./types.js";

describe("isEphemeralGraphStore", () => {
  it("detects /tmp and macOS /private/tmp", () => {
    expect(isEphemeralGraphStore("/tmp/flowgraph-graphs")).toBe(true);
    expect(isEphemeralGraphStore("/tmp")).toBe(true);
    expect(isEphemeralGraphStore("/private/tmp/fg")).toBe(true);
    expect(isEphemeralGraphStore("/var/data/graphs")).toBe(false);
  });
});

describe("processIdentity", () => {
  it("reports package version, node, and config paths", () => {
    const config: ServerConfig = {
      host: "0.0.0.0",
      port: 8080,
      graphStoreDir: "/data/graphs",
      eventBufferSize: 10,
      databaseUrl: "postgres://localhost/fg",
    };
    const id = processIdentity(config);
    expect(id.name).toBe("flowgraph-server");
    expect(id.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(id.node).toMatch(/^v\d+/);
    expect(id.host).toBe("0.0.0.0");
    expect(id.port).toBe(8080);
    expect(id.graphStoreDir).toBe("/data/graphs");
    expect(id.database).toBe("postgres");
    expect(id.pid).toBe(process.pid);
    expect(typeof id.hostname).toBe("string");
    expect(id.gitSha === null || typeof id.gitSha === "string").toBe(true);
  });
});
