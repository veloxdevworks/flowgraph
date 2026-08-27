import { describe, expect, it } from "vitest";
import { defaultServerConfig } from "./types.js";

describe("defaultServerConfig", () => {
  it("requires auth unless FLOWGRAPH_AUTH_DISABLED is set", () => {
    const cfg = defaultServerConfig({});
    expect(cfg.authDisabled).toBe(false);
    expect(cfg.authToken).toBeUndefined();
    expect(cfg.maxBodyBytes).toBe(2_000_000);
    expect(cfg.maxConcurrentRuns).toBe(16);
  });

  it("reads connect and limit env vars", () => {
    const cfg = defaultServerConfig({
      FLOWGRAPH_AUTH_TOKEN: "secret",
      FLOWGRAPH_AUTH_DISABLED: "1",
      FLOWGRAPH_MAX_BODY_BYTES: "1000",
      FLOWGRAPH_MAX_CONCURRENT_RUNS: "3",
      FLOWGRAPH_CONNECT_URL: "wss://platform.example/connect",
      FLOWGRAPH_CONNECT_TOKEN: "ctok",
    });
    expect(cfg.authToken).toBe("secret");
    expect(cfg.authDisabled).toBe(true);
    expect(cfg.maxBodyBytes).toBe(1000);
    expect(cfg.maxConcurrentRuns).toBe(3);
    expect(cfg.connectUrl).toBe("wss://platform.example/connect");
    expect(cfg.connectToken).toBe("ctok");
  });
});
