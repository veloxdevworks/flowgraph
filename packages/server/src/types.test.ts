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

  it("reads FLOWGRAPH_UNTRUSTED_HTTP_ALLOW_HOSTS", () => {
    expect(defaultServerConfig({}).untrustedHttpAllowHosts).toBeUndefined();
    expect(defaultServerConfig({ FLOWGRAPH_UNTRUSTED_HTTP_ALLOW_HOSTS: " hooks.internal:8443, *.corp.example ,[fd00::1]:80" }).untrustedHttpAllowHosts).toEqual([
      "hooks.internal:8443",
      "*.corp.example",
      "[fd00::1]:80",
    ]);
    expect(() => defaultServerConfig({ FLOWGRAPH_UNTRUSTED_HTTP_ALLOW_HOSTS: "http://x/" })).toThrow(/FLOWGRAPH_UNTRUSTED_HTTP_ALLOW_HOSTS/);
  });

  it("reads FLOWGRAPH_SETUP_LOCK_TIMEOUT_MS", () => {
    expect(defaultServerConfig({}).setupLockTimeoutMs).toBeUndefined();
    expect(defaultServerConfig({ FLOWGRAPH_SETUP_LOCK_TIMEOUT_MS: "0" }).setupLockTimeoutMs).toBe(0);
    expect(defaultServerConfig({ FLOWGRAPH_SETUP_LOCK_TIMEOUT_MS: "120000" }).setupLockTimeoutMs).toBe(120_000);
    for (const bad of ["-1", "1.5", "soon"]) {
      expect(() => defaultServerConfig({ FLOWGRAPH_SETUP_LOCK_TIMEOUT_MS: bad })).toThrow(/FLOWGRAPH_SETUP_LOCK_TIMEOUT_MS/);
    }
  });

  it("parses voice policy env (default: no unauthenticated minting)", () => {
    expect(defaultServerConfig({}).voice).toEqual({ allowUnauthenticated: false });
    const cfg = defaultServerConfig({
      FLOWGRAPH_VOICE_ALLOW_UNAUTHENTICATED: "1",
      FLOWGRAPH_VOICE_ALLOWED_MODELS: " gpt-realtime , grok-voice-latest,, ",
    });
    expect(cfg.voice).toEqual({ allowUnauthenticated: true, allowedModels: ["gpt-realtime", "grok-voice-latest"] });
  });
});
