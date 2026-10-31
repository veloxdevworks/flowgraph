import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { SignJWT } from "jose";
import {
  checkStartupAuth,
  createAuthenticator,
  OidcAuthenticator,
  principalFromClaims,
  singleUserPrincipal,
  type AuthOutcome,
  type OidcAuthConfig,
} from "./identity.js";
import { authConfigFromEnv, defaultServerConfig, type ServerConfig } from "./types.js";
import { RunService } from "./run-service.js";
import { createHttpServer } from "./http/app.js";
import { startTestIssuer, TEST_AUDIENCE, unsecuredToken, type TestIssuer, type TestKey } from "./testing/oidc-issuer.js";

let iss: TestIssuer;
let rsa: TestKey;
let ec: TestKey;

beforeAll(async () => {
  iss = await startTestIssuer();
  rsa = await iss.newKey("RS256");
  ec = await iss.newKey("ES256");
  iss.published.push(rsa, ec);
});
afterAll(async () => {
  await iss.close();
});

function oidcConfig(over: Partial<OidcAuthConfig> = {}): OidcAuthConfig {
  return {
    issuer: iss.issuer,
    audience: [TEST_AUDIENCE],
    algorithms: ["RS256", "ES256"],
    clockToleranceSec: 60,
    claims: { org: "org_id", roles: "roles", teams: "groups", displayName: ["name", "preferred_username", "email"] },
    trust: { roles: ["flowgraph:author"], teams: ["platform"] },
    defaultProject: "local",
    jwksCooldownMs: 0,
    ...over,
  };
}

const bearer = (t: string) => `Bearer ${t}`;
const now = () => Math.floor(Date.now() / 1000);

function failure(r: AuthOutcome): { status: number; code: string } {
  expect(r.ok).toBe(false);
  return r.ok ? { status: 200, code: "" } : { status: r.status, code: r.code };
}

describe("OIDC authenticator", () => {
  it("accepts a valid RS256 token and maps its claims to a principal", async () => {
    const auth = new OidcAuthenticator(oidcConfig());
    const t = await iss.sign(rsa, { sub: "u-1", org_id: "acme", roles: ["viewer"], groups: ["platform"], name: "Alice A" });
    const r = await auth.authenticate(bearer(t));
    expect(r).toEqual({
      ok: true,
      principal: {
        id: `${iss.issuer}|u-1`,
        subject: "u-1",
        issuer: iss.issuer,
        org: "acme",
        project: "local",
        teams: ["platform"],
        roles: ["viewer"],
        displayName: "Alice A",
        trusted: true,
        via: "oidc",
      },
    });
  });

  it("accepts ES256 and reports untrusted principals", async () => {
    const auth = new OidcAuthenticator(oidcConfig());
    const r = await auth.authenticate(bearer(await iss.sign(ec, { org_id: "acme", email: "bob@example.com" })));
    expect(r.ok && r.principal).toMatchObject({ subject: "alice", displayName: "bob@example.com", trusted: false });
  });

  it("rejects expired tokens, and allows exp inside the clock skew", async () => {
    const auth = new OidcAuthenticator(oidcConfig({ clockToleranceSec: 60 }));
    expect(failure(await auth.authenticate(bearer(await iss.sign(rsa, { org_id: "a", iat: now() - 600, exp: now() - 120 }))))).toEqual({
      status: 401,
      code: "AUTH_TOKEN_EXPIRED",
    });
    const r = await auth.authenticate(bearer(await iss.sign(rsa, { org_id: "a", iat: now() - 600, exp: now() - 30 })));
    expect(r.ok).toBe(true);
  });

  it("rejects nbf and iat beyond the clock skew", async () => {
    const auth = new OidcAuthenticator(oidcConfig({ clockToleranceSec: 5 }));
    expect(failure(await auth.authenticate(bearer(await iss.sign(rsa, { org_id: "a", nbf: now() + 120 }))))).toMatchObject({
      code: "AUTH_INVALID_TOKEN",
    });
    expect(failure(await auth.authenticate(bearer(await iss.sign(rsa, { org_id: "a", iat: now() + 120 }))))).toMatchObject({
      code: "AUTH_INVALID_TOKEN",
    });
  });

  it("rejects a wrong audience and a wrong issuer", async () => {
    const auth = new OidcAuthenticator(oidcConfig());
    const wrongAud = await auth.authenticate(bearer(await iss.sign(rsa, { org_id: "a" }, { audience: "someone-else" })));
    expect(wrongAud).toMatchObject({ ok: false, status: 401, code: "AUTH_INVALID_TOKEN", message: expect.stringContaining("aud") });
    const wrongIss = await auth.authenticate(bearer(await iss.sign(rsa, { org_id: "a", iss: "https://evil.example" })));
    expect(wrongIss).toMatchObject({ ok: false, status: 401, code: "AUTH_INVALID_TOKEN", message: expect.stringContaining("iss") });
  });

  it("rejects alg none and HS256 when only asymmetric algorithms are configured", async () => {
    const auth = new OidcAuthenticator(oidcConfig());
    const none = unsecuredToken({ iss: iss.issuer, aud: TEST_AUDIENCE, sub: "alice", org_id: "a", exp: now() + 300 });
    expect(failure(await auth.authenticate(bearer(none)))).toEqual({ status: 401, code: "AUTH_INVALID_TOKEN" });
    const hs = await new SignJWT({ iss: iss.issuer, aud: TEST_AUDIENCE, sub: "alice", org_id: "a", exp: now() + 300 })
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode("x".repeat(32)));
    expect(failure(await auth.authenticate(bearer(hs)))).toEqual({ status: 401, code: "AUTH_INVALID_TOKEN" });
  });

  it("accepts HS256 only when a shared secret is configured", async () => {
    const secret = "s".repeat(40);
    const auth = new OidcAuthenticator(oidcConfig({ algorithms: ["HS256"], sharedSecret: secret }));
    const hs = await new SignJWT({ iss: iss.issuer, aud: TEST_AUDIENCE, sub: "svc", org_id: "a", exp: now() + 300 })
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode(secret));
    expect((await auth.authenticate(bearer(hs))).ok).toBe(true);
    expect(failure(await auth.authenticate(bearer(await iss.sign(rsa, { org_id: "a" }))))).toMatchObject({ status: 401 });
  });

  it("refetches the JWKS for an unknown kid, and follows key rotation", async () => {
    const auth = new OidcAuthenticator(oidcConfig());
    expect((await auth.authenticate(bearer(await iss.sign(rsa, { org_id: "a" })))).ok).toBe(true);
    const before = iss.jwksFetches;
    // The issuer rotates: a new key is published and the old one retired.
    const next = await iss.newKey("RS256");
    iss.published = [next, ec];
    try {
      expect((await auth.authenticate(bearer(await iss.sign(next, { org_id: "a" })))).ok).toBe(true);
      expect(iss.jwksFetches).toBe(before + 1);
      // Cached keys keep working without another fetch.
      expect((await auth.authenticate(bearer(await iss.sign(next, { org_id: "a" })))).ok).toBe(true);
      expect(iss.jwksFetches).toBe(before + 1);
      // A fresh verifier (or one whose cache aged out) no longer accepts the retired key.
      const fresh = new OidcAuthenticator(oidcConfig());
      expect(failure(await fresh.authenticate(bearer(await iss.sign(rsa, { org_id: "a" }))))).toEqual({
        status: 401,
        code: "AUTH_INVALID_TOKEN",
      });
      // A kid the issuer never published fails cleanly too.
      const stranger = await iss.newKey("RS256");
      expect(failure(await auth.authenticate(bearer(await iss.sign(stranger, { org_id: "a" }))))).toEqual({
        status: 401,
        code: "AUTH_INVALID_TOKEN",
      });
    } finally {
      iss.published = [rsa, ec];
    }
  });

  it("refuses to trust a discovery document for another issuer", async () => {
    iss.discoveryIssuer = "https://other.example";
    try {
      const auth = new OidcAuthenticator(oidcConfig());
      expect(failure(await auth.authenticate(bearer(await iss.sign(rsa, { org_id: "a" }))))).toEqual({
        status: 503,
        code: "AUTH_PROVIDER_UNAVAILABLE",
      });
    } finally {
      delete iss.discoveryIssuer;
    }
  });

  it("refuses a discovery document that sends keys to plain http elsewhere", async () => {
    iss.discoveryJwksUri = "http://keys.attacker.example/jwks.json";
    try {
      const auth = new OidcAuthenticator(oidcConfig());
      expect(failure(await auth.authenticate(bearer(await iss.sign(rsa, { org_id: "a" }))))).toEqual({
        status: 503,
        code: "AUTH_PROVIDER_UNAVAILABLE",
      });
    } finally {
      delete iss.discoveryJwksUri;
    }
  });

  it("remembers a failed discovery briefly instead of refetching on every request", async () => {
    iss.discoveryIssuer = "https://other.example";
    try {
      const auth = new OidcAuthenticator(oidcConfig({ discoveryRetryMs: 150 }));
      const token = bearer(await iss.sign(rsa, { org_id: "a" }));
      const before = iss.discoveryFetches;
      for (let i = 0; i < 5; i++) expect(failure(await auth.authenticate(token)).status).toBe(503);
      expect(iss.discoveryFetches).toBe(before + 1);
      delete iss.discoveryIssuer;
      await new Promise((r) => setTimeout(r, 200));
      expect((await auth.authenticate(token)).ok).toBe(true);
      expect(iss.discoveryFetches).toBe(before + 2);
    } finally {
      delete iss.discoveryIssuer;
    }
  });

  it("reports a missing or malformed Authorization header", async () => {
    const auth = new OidcAuthenticator(oidcConfig());
    expect(failure(await auth.authenticate(undefined))).toEqual({ status: 401, code: "AUTH_REQUIRED" });
    expect(failure(await auth.authenticate("Basic abc"))).toEqual({ status: 401, code: "AUTH_INVALID_TOKEN" });
    expect(failure(await auth.authenticate("Bearer not.a.jwt"))).toEqual({ status: 401, code: "AUTH_INVALID_TOKEN" });
  });
});

describe("claim mapping", () => {
  const base = oidcConfig;
  it("reads namespaced and dotted claims, and falls back to the default org", () => {
    const cfg = base({
      claims: {
        org: "https://flowgraph.dev/org",
        project: "https://flowgraph.dev/project",
        roles: "realm_access.roles",
        teams: "teams",
        displayName: ["nickname"],
      },
    });
    const r = principalFromClaims(
      {
        sub: "s",
        "https://flowgraph.dev/org": "globex",
        "https://flowgraph.dev/project": "web",
        realm_access: { roles: ["flowgraph:author", 7] },
        teams: "solo",
        nickname: "Sam",
      },
      cfg,
    );
    expect(r).toMatchObject({
      ok: true,
      principal: { org: "globex", project: "web", roles: ["flowgraph:author"], teams: ["solo"], displayName: "Sam", trusted: true },
    });
    expect(principalFromClaims({ sub: "s" }, base({ defaultOrg: "single" }))).toMatchObject({ ok: true, principal: { org: "single" } });
  });

  it("refuses a token with no org and no default org", () => {
    expect(principalFromClaims({ sub: "s" }, base())).toMatchObject({ ok: false, status: 403, code: "AUTH_NO_ORG" });
    expect(principalFromClaims({ sub: "s", org_id: "a\u0000b" }, base())).toMatchObject({ ok: false, code: "AUTH_NO_ORG" });
  });

  it("trusts nobody unless a role or team rule matches", () => {
    const cfg = base({ trust: { roles: [], teams: [] } });
    expect(principalFromClaims({ sub: "s", org_id: "a", roles: ["admin"], groups: ["platform"] }, cfg)).toMatchObject({
      principal: { trusted: false },
    });
  });
});

describe("auth config from env", () => {
  const oidcEnv = { FLOWGRAPH_OIDC_ISSUER: "https://id.example.com", FLOWGRAPH_OIDC_AUDIENCE: "api" };

  it("infers the mode and fills claim defaults", () => {
    expect(authConfigFromEnv({}).mode).toBe("token");
    expect(authConfigFromEnv({ FLOWGRAPH_AUTH_DISABLED: "1" }).mode).toBe("none");
    const a = authConfigFromEnv({ ...oidcEnv, FLOWGRAPH_OIDC_TRUSTED_ROLES: "author, admin", FLOWGRAPH_ORG: "acme" });
    expect(a).toMatchObject({
      mode: "oidc",
      explicit: false,
      oidc: {
        issuer: "https://id.example.com",
        audience: ["api"],
        algorithms: ["RS256", "ES256"],
        clockToleranceSec: 60,
        claims: { org: "org_id", roles: "roles", teams: "groups", displayName: ["name", "preferred_username", "email"] },
        trust: { roles: ["author", "admin"], teams: [] },
        defaultOrg: "acme",
        defaultProject: "local",
      },
    });
  });

  it("rejects unsafe or contradictory settings", () => {
    const bad: Array<[Record<string, string>, RegExp]> = [
      [{ ...oidcEnv, FLOWGRAPH_OIDC_ALGORITHMS: "none" }, /may not include none/],
      [{ ...oidcEnv, FLOWGRAPH_OIDC_ALGORITHMS: "HS256" }, /needs FLOWGRAPH_OIDC_SHARED_SECRET/],
      [{ ...oidcEnv, FLOWGRAPH_OIDC_ALGORITHMS: "HS256,RS256", FLOWGRAPH_OIDC_SHARED_SECRET: "x".repeat(32) }, /cannot mix/],
      [{ ...oidcEnv, FLOWGRAPH_OIDC_SHARED_SECRET: "x".repeat(32) }, /only used with/],
      [{ ...oidcEnv, FLOWGRAPH_OIDC_ALGORITHMS: "HS256", FLOWGRAPH_OIDC_SHARED_SECRET: "short" }, /at least 32 bytes/],
      [{ FLOWGRAPH_OIDC_ISSUER: "https://id.example.com" }, /FLOWGRAPH_OIDC_AUDIENCE is required/],
      [{ ...oidcEnv, FLOWGRAPH_OIDC_ISSUER: "http://id.example.com" }, /must use https/],
      [{ ...oidcEnv, FLOWGRAPH_AUTH_TOKEN: "t" }, /cannot be combined/],
      [{ ...oidcEnv, FLOWGRAPH_OIDC_CLOCK_SKEW_SECONDS: "900" }, /0 to 300/],
      [{ FLOWGRAPH_AUTH_MODE: "oidc" }, /needs FLOWGRAPH_OIDC_ISSUER/],
      [{ FLOWGRAPH_AUTH_MODE: "magic" }, /must be one of/],
    ];
    for (const [env, re] of bad) expect(() => authConfigFromEnv(env), JSON.stringify(env)).toThrow(re);
    expect(authConfigFromEnv({ ...oidcEnv, FLOWGRAPH_OIDC_ISSUER: "http://localhost:9000" }).mode).toBe("oidc");
    expect(authConfigFromEnv({ ...oidcEnv, FLOWGRAPH_OIDC_ISSUER: "http://id.internal", FLOWGRAPH_INSECURE_DEV: "1" }).mode).toBe("oidc");
  });
});

describe("startup refusal", () => {
  const cfg = (env: Record<string, string>): ServerConfig => defaultServerConfig({ FLOWGRAPH_GRAPH_STORE: os.tmpdir(), ...env });

  it("refuses durable storage without auth unless FLOWGRAPH_INSECURE_DEV is set", () => {
    expect(() => checkStartupAuth(cfg({ FLOWGRAPH_AUTH_DISABLED: "1", DATABASE_URL: "postgres://x" }))).toThrow(/Refusing to start: auth is disabled/);
    expect(() =>
      checkStartupAuth(cfg({ FLOWGRAPH_AUTH_DISABLED: "1", FLOWGRAPH_MEMORY_BACKEND: "sqlite", FLOWGRAPH_ORG: "a" })),
    ).toThrow(/Refusing to start/);
    expect(checkStartupAuth(cfg({ FLOWGRAPH_AUTH_DISABLED: "1", DATABASE_URL: "postgres://x", FLOWGRAPH_INSECURE_DEV: "1" }))).toHaveLength(1);
    expect(checkStartupAuth(cfg({ FLOWGRAPH_AUTH_DISABLED: "1" }))).toEqual([]);
  });

  it("keeps the legacy token for durable servers only when FLOWGRAPH_AUTH_MODE=token says so", () => {
    expect(() => checkStartupAuth(cfg({ FLOWGRAPH_AUTH_TOKEN: "t", DATABASE_URL: "postgres://x" }))).toThrow(/single-user legacy mode/);
    expect(checkStartupAuth(cfg({ FLOWGRAPH_AUTH_TOKEN: "t", DATABASE_URL: "postgres://x", FLOWGRAPH_AUTH_MODE: "token" }))).toHaveLength(1);
    expect(checkStartupAuth(cfg({ FLOWGRAPH_AUTH_TOKEN: "t" }))).toEqual([]);
  });
});

describe("single-user principals", () => {
  it("trusts the token holder, and the anonymous caller only in insecure dev", () => {
    const base = defaultServerConfig({ FLOWGRAPH_ORG: "acme", FLOWGRAPH_USER: "ryan", FLOWGRAPH_AUTH_TOKEN: "t" });
    expect(singleUserPrincipal(base)).toMatchObject({ id: "token:ryan", org: "acme", project: "local", trusted: true, via: "token" });
    expect(singleUserPrincipal(defaultServerConfig({ FLOWGRAPH_AUTH_DISABLED: "1" }))).toMatchObject({ id: "anonymous", trusted: false });
    expect(singleUserPrincipal(defaultServerConfig({ FLOWGRAPH_AUTH_DISABLED: "1", FLOWGRAPH_INSECURE_DEV: "1" })).trusted).toBe(true);
  });

  it("the token authenticator compares the shared token", async () => {
    const a = createAuthenticator(defaultServerConfig({ FLOWGRAPH_AUTH_TOKEN: "secret" }));
    expect(failure(await a.authenticate(undefined))).toEqual({ status: 401, code: "AUTH_REQUIRED" });
    expect(failure(await a.authenticate("Bearer nope"))).toEqual({ status: 401, code: "AUTH_INVALID_TOKEN" });
    expect((await a.authenticate("Bearer secret")).ok).toBe(true);
    expect(failure(await createAuthenticator(defaultServerConfig({})).authenticate("Bearer x"))).toEqual({ status: 401, code: "AUTH_REQUIRED" });
  });
});

describe("HTTP with OIDC", () => {
  it("requires a valid JWT on REST and on AgentCore /invocations, not on /ping", async () => {
    const config = defaultServerConfig({
      FLOWGRAPH_GRAPH_STORE: path.join(os.tmpdir(), `fg-oidc-http-${process.pid}`),
      FLOWGRAPH_OIDC_ISSUER: iss.issuer,
      FLOWGRAPH_OIDC_AUDIENCE: TEST_AUDIENCE,
    });
    const service = new RunService(config);
    const server = createHttpServer(service, config);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const anon = await fetch(`${base}/runs`);
      expect(anon.status).toBe(401);
      expect(anon.headers.get("www-authenticate")).toMatch(/^Bearer/);
      expect(await anon.json()).toMatchObject({ code: "AUTH_REQUIRED" });
      const token = await iss.sign(rsa, { org_id: "acme" });
      const ok = await fetch(`${base}/runs`, { headers: { authorization: `Bearer ${token}` } });
      expect(ok.status).toBe(200);
      const noOrg = await fetch(`${base}/runs`, { headers: { authorization: `Bearer ${await iss.sign(rsa)}` } });
      expect(noOrg.status).toBe(403);
      // Threads belong to whoever started them.
      const yaml = [
        "apiVersion: flowgraph/v1",
        "kind: Graph",
        "metadata: { name: http-owned }",
        "state: { channels: { approval: { type: object } } }",
        "nodes:",
        "  - { id: gate, type: hitl, with: { mode: approve, message: ok, output: { to: approval } } }",
        "edges: [{ from: START, to: gate }, { from: gate, to: END }]",
        "runtime: { checkpoint: { enabled: true, backend: memory }, hitl: { onInterrupt: fail } }",
      ].join("\n");
      const started = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ threadId: "http-t1", yaml }),
      });
      expect(started.status).toBe(202);
      const bobToken = await iss.sign(rsa, { sub: "bob", org_id: "acme" });
      const peek = await fetch(`${base}/runs/http-t1`, { headers: { authorization: `Bearer ${bobToken}` } });
      expect(peek.status).toBe(403);
      expect(await peek.json()).toMatchObject({ code: "THREAD_NOT_OWNED" });
      const events = await fetch(`${base}/runs/http-t1/events`, { headers: { authorization: `Bearer ${bobToken}` } });
      expect(events.status).toBe(403);
      const taken = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${bobToken}`, "content-type": "application/json" },
        body: JSON.stringify({ threadId: "http-t2", yaml }),
      });
      expect(taken.status).toBe(409);
      expect(await taken.json()).toMatchObject({ code: "GRAPH_NAME_TAKEN" });
      const mine = await fetch(`${base}/runs/http-t1`, { headers: { authorization: `Bearer ${token}` } });
      expect(mine.status).toBe(200);
      const inv = await fetch(`${base}/invocations`, { method: "POST", body: JSON.stringify({ action: "list" }) });
      expect(inv.status).toBe(401);
      // /invocations takes the same JWT as REST: none, a bad one, or a forged one is refused.
      const invoke = (body: unknown, authorization?: string) =>
        fetch(`${base}/invocations`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
          body: JSON.stringify(body),
        });
      expect((await invoke({ action: "start", threadId: "inv-anon", yaml: yaml.replace("http-owned", "inv-anon") })).status).toBe(401);
      expect((await invoke({ action: "state", threadId: "http-t1" }, "Bearer not-a-jwt")).status).toBe(401);
      expect((await invoke({ action: "state", threadId: "http-t1" }, `Bearer ${token.slice(0, -4)}AAAA`)).status).toBe(401);
      expect(service.registry.get("inv-anon")).toBeUndefined();
      // With a valid JWT it acts as that caller, so threads stay with their owner.
      const bobState = await invoke({ action: "state", threadId: "http-t1" }, `Bearer ${bobToken}`);
      expect(bobState.status).toBe(403);
      expect(await bobState.json()).toMatchObject({ code: "THREAD_NOT_OWNED" });
      expect((await invoke({ action: "state", threadId: "http-t1" }, `Bearer ${token}`)).status).toBe(200);
      expect((await fetch(`${base}/ping`)).status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await service.close();
    }
  });
});
