/**
 * Who is calling the server. Every authenticated request resolves to a
 * Principal; memory identity, thread ownership, graph-name ownership and the
 * upload policy all key off it.
 *
 * Modes:
 * - `oidc`  — bearer JWTs from an OpenID Connect issuer (multi-user; the
 *             production mode). Keys come from the issuer's JWKS.
 * - `token` — one shared FLOWGRAPH_AUTH_TOKEN for a single-user server
 *             (legacy / dev). Every caller is the same principal, built from
 *             FLOWGRAPH_ORG / FLOWGRAPH_PROJECT / FLOWGRAPH_USER.
 * - `none`  — FLOWGRAPH_AUTH_DISABLED=1 (local dev). Every caller is the same
 *             anonymous principal.
 *
 * Local CLI use never goes through any of this.
 */

import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { tokensEqual } from "./auth.js";
import type { ServerConfig } from "./types.js";

export type AuthMode = "oidc" | "token" | "none";

export interface Principal {
  /** Stable, unique id: `<issuer>|<sub>` for OIDC, `token:<user>` or `anonymous` for single-user modes. */
  id: string;
  subject: string;
  issuer?: string;
  org: string;
  project?: string;
  teams: readonly string[];
  roles: readonly string[];
  displayName?: string;
  /** May upload graphs with host-command nodes, env placeholders and secret references. */
  trusted: boolean;
  via: AuthMode;
}

export type AuthOutcome =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 403 | 503; code: string; message: string };

export interface Authenticator {
  readonly mode: AuthMode;
  /** Resolve the principal for an `Authorization` header value. */
  authenticate(authorization: string | undefined): Promise<AuthOutcome>;
}

/** Claim names (exact key first, then a dotted path such as `realm_access.roles`). */
export interface OidcClaimMapping {
  /** Org claim. Default `org_id`. Env: FLOWGRAPH_OIDC_ORG_CLAIM. */
  org: string;
  /** Project claim. Default unset (project comes from `defaultProject`). Env: FLOWGRAPH_OIDC_PROJECT_CLAIM. */
  project?: string;
  /** Roles claim (string array or one string). Default `roles`. Env: FLOWGRAPH_OIDC_ROLES_CLAIM. */
  roles: string;
  /** Teams/groups claim (string array or one string). Default `groups`. Env: FLOWGRAPH_OIDC_TEAMS_CLAIM. */
  teams: string;
  /** Display name claims, first present wins. Default name, preferred_username, email. Env: FLOWGRAPH_OIDC_NAME_CLAIMS. */
  displayName: string[];
}

export interface TrustRule {
  /** Principals holding any of these roles are trusted authors. Env: FLOWGRAPH_OIDC_TRUSTED_ROLES. */
  roles: string[];
  /** Principals in any of these teams are trusted authors. Env: FLOWGRAPH_OIDC_TRUSTED_TEAMS. */
  teams: string[];
}

export const DEFAULT_OIDC_ALGORITHMS: readonly string[] = ["RS256", "ES256"];
export const ASYMMETRIC_ALGORITHMS: readonly string[] = [
  "RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA", "Ed25519",
];
export const SHARED_SECRET_ALGORITHMS: readonly string[] = ["HS256", "HS384", "HS512"];
export const DEFAULT_CLOCK_TOLERANCE_SEC = 60;
export const MAX_CLOCK_TOLERANCE_SEC = 300;

export interface OidcAuthConfig {
  /** Env: FLOWGRAPH_OIDC_ISSUER. Must equal the token `iss` and the discovery document's `issuer`. */
  issuer: string;
  /** Accepted `aud` values (any match). Env: FLOWGRAPH_OIDC_AUDIENCE (comma-separated). */
  audience: string[];
  /** Accepted JWS algorithms. Default RS256, ES256. `none` is never accepted. Env: FLOWGRAPH_OIDC_ALGORITHMS. */
  algorithms: string[];
  /** Allowed clock skew for exp / nbf / iat, 0 to 300 s. Default 60. Env: FLOWGRAPH_OIDC_CLOCK_SKEW_SECONDS. */
  clockToleranceSec: number;
  /** Skip discovery and use this JWKS URL. Env: FLOWGRAPH_OIDC_JWKS_URI. */
  jwksUri?: string;
  /** HMAC key, required for (and only allowed with) HS256/384/512. Env: FLOWGRAPH_OIDC_SHARED_SECRET. */
  sharedSecret?: string;
  claims: OidcClaimMapping;
  trust: TrustRule;
  /** Org when the token has no org claim (single-tenant deployments). Env: FLOWGRAPH_ORG. */
  defaultOrg?: string;
  /** Project when the token has no project claim. Env: FLOWGRAPH_PROJECT, else `local`. */
  defaultProject: string;
  /** Minimum ms between JWKS refetches for an unknown `kid`. Default 30000. */
  jwksCooldownMs?: number;
  /** How long cached JWKS keys are used before a refetch. Default 600000. */
  jwksCacheMaxAgeMs?: number;
  /** How long a failed discovery is reused before the next request retries it. Default 5000. */
  discoveryRetryMs?: number;
  /** Discovery / JWKS request timeout. Default 5000. */
  httpTimeoutMs?: number;
}

export interface ServerAuthConfig {
  mode: AuthMode;
  /** True when FLOWGRAPH_AUTH_MODE named the mode (rather than it being inferred). */
  explicit: boolean;
  oidc?: OidcAuthConfig;
  /**
   * FLOWGRAPH_INSECURE_DEV=1: allow `none` with durable storage, plain-http
   * issuers, and treat the anonymous principal as a trusted author.
   */
  insecureDev: boolean;
}

/** The auth mode a config resolves to (configs built before `auth` existed use authToken / authDisabled). */
export function authModeOf(config: Pick<ServerConfig, "auth" | "authDisabled" | "authToken">): AuthMode {
  if (config.auth) return config.auth.mode;
  return config.authDisabled ? "none" : "token";
}

/** The one principal of a single-user server (token or none mode). */
export function singleUserPrincipal(config: ServerConfig): Principal {
  const mode = authModeOf(config);
  const id = config.memory?.identity;
  const org = id?.org ?? "local";
  const project = id?.project ?? "local";
  if (mode === "none") {
    return {
      id: "anonymous",
      subject: id?.user ?? "anonymous",
      org,
      project,
      teams: [],
      roles: [],
      trusted: Boolean(config.auth?.insecureDev) || config.auth === undefined,
      via: "none",
    };
  }
  const subject = id?.user ?? "token";
  return { id: `token:${subject}`, subject, org, project, teams: [], roles: [], trusted: true, via: "token" };
}

function bearer(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
  return m?.[1];
}

class StaticTokenAuthenticator implements Authenticator {
  readonly mode = "token" as const;
  constructor(
    private readonly token: string | undefined,
    private readonly principal: Principal,
  ) {}

  async authenticate(authorization: string | undefined): Promise<AuthOutcome> {
    if (!this.token) {
      return {
        ok: false,
        status: 401,
        code: "AUTH_REQUIRED",
        message: "Authentication required. Set FLOWGRAPH_OIDC_ISSUER (or FLOWGRAPH_AUTH_TOKEN for a single-user server), or FLOWGRAPH_AUTH_DISABLED=1 for local/dev.",
      };
    }
    if (!authorization) return { ok: false, status: 401, code: "AUTH_REQUIRED", message: "Missing Authorization header" };
    const t = bearer(authorization);
    if (!t || !tokensEqual(t, this.token)) return { ok: false, status: 401, code: "AUTH_INVALID_TOKEN", message: "Invalid bearer token" };
    return { ok: true, principal: this.principal };
  }
}

class NoAuthAuthenticator implements Authenticator {
  readonly mode = "none" as const;
  constructor(private readonly principal: Principal) {}
  async authenticate(): Promise<AuthOutcome> {
    return { ok: true, principal: this.principal };
  }
}

/** Read a claim by exact key (namespaced URL claims), then by dotted path. */
export function readClaim(payload: Record<string, unknown>, name: string): unknown {
  if (Object.prototype.hasOwnProperty.call(payload, name)) return payload[name];
  let cur: unknown = payload;
  for (const part of name.split(".")) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function claimString(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

function claimList(v: unknown): string[] {
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
  return [];
}

function cleanIdPart(v: string | undefined): string | undefined {
  // Principal ids and orgs are stored as text keys; refuse control characters.
  if (v === undefined) return undefined;
  // eslint-disable-next-line no-control-regex
  if (v.length > 512 || /[\u0000-\u001f\u007f]/.test(v)) return undefined;
  return v;
}

/** Map verified JWT claims to a principal (exported for tests and custom hosts). */
export function principalFromClaims(payload: JWTPayload, cfg: OidcAuthConfig): AuthOutcome {
  const p = payload as Record<string, unknown>;
  const subject = cleanIdPart(claimString(p["sub"]));
  if (!subject) return { ok: false, status: 401, code: "AUTH_INVALID_TOKEN", message: "token has no usable sub claim" };
  const orgClaim = claimString(readClaim(p, cfg.claims.org));
  const org = cleanIdPart(orgClaim ?? cfg.defaultOrg);
  if (!org) {
    return {
      ok: false,
      status: 403,
      code: "AUTH_NO_ORG",
      message: `token has no usable "${cfg.claims.org}" claim and the server has no default org (FLOWGRAPH_ORG)`,
    };
  }
  const projectClaim = cfg.claims.project ? claimString(readClaim(p, cfg.claims.project)) : undefined;
  const project = cleanIdPart(projectClaim ?? cfg.defaultProject);
  if (!project) return { ok: false, status: 403, code: "AUTH_NO_ORG", message: "token project claim is not usable" };
  const roles = claimList(readClaim(p, cfg.claims.roles));
  const teams = claimList(readClaim(p, cfg.claims.teams));
  let displayName: string | undefined;
  for (const c of cfg.claims.displayName) {
    displayName = claimString(readClaim(p, c));
    if (displayName) break;
  }
  const trusted = roles.some((r) => cfg.trust.roles.includes(r)) || teams.some((t) => cfg.trust.teams.includes(t));
  return {
    ok: true,
    principal: {
      id: `${cfg.issuer}|${subject}`,
      subject,
      issuer: cfg.issuer,
      org,
      project,
      teams,
      roles,
      ...(displayName ? { displayName } : {}),
      trusted,
      via: "oidc",
    },
  };
}

/** Thrown when the issuer's discovery document or JWKS cannot be fetched. */
class IssuerUnavailableError extends Error {}

export class OidcAuthenticator implements Authenticator {
  readonly mode = "oidc" as const;
  private keys: Promise<JWTVerifyGetKey | Uint8Array> | undefined;

  constructor(
    readonly config: OidcAuthConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async discoverJwksUri(): Promise<string> {
    const base = this.config.issuer.replace(/\/+$/, "");
    const url = `${base}/.well-known/openid-configuration`;
    let doc: { issuer?: unknown; jwks_uri?: unknown };
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.config.httpTimeoutMs ?? 5_000), redirect: "error" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      doc = (await res.json()) as typeof doc;
    } catch (err) {
      throw new IssuerUnavailableError(`OIDC discovery failed at ${url}: ${(err as Error).message}`);
    }
    if (doc.issuer !== this.config.issuer) {
      throw new IssuerUnavailableError(
        `OIDC discovery at ${url} names issuer ${JSON.stringify(doc.issuer)}, not the configured ${JSON.stringify(this.config.issuer)}`,
      );
    }
    if (typeof doc.jwks_uri !== "string" || !doc.jwks_uri) throw new IssuerUnavailableError(`OIDC discovery at ${url} has no jwks_uri`);
    // Keys must come over https; plain http only from the issuer's own origin
    // (a local development issuer), never redirected elsewhere by the document.
    let jwks: URL;
    try {
      jwks = new URL(doc.jwks_uri);
    } catch {
      throw new IssuerUnavailableError(`OIDC discovery at ${url} has an invalid jwks_uri`);
    }
    if (jwks.protocol !== "https:" && jwks.origin !== new URL(base).origin) {
      throw new IssuerUnavailableError(
        `OIDC discovery at ${url} names jwks_uri ${JSON.stringify(doc.jwks_uri)}; it must use https or the issuer's origin`,
      );
    }
    return doc.jwks_uri;
  }

  /**
   * Discovery runs once. A failure is remembered for a short while
   * (`discoveryRetryMs`, default 5 s) so requests during an issuer outage do
   * not each refetch it; the next request after that retries.
   */
  private getKeys(): Promise<JWTVerifyGetKey | Uint8Array> {
    if (this.config.sharedSecret) return Promise.resolve(new TextEncoder().encode(this.config.sharedSecret));
    this.keys ??= (async () => {
      const jwksUri = this.config.jwksUri ?? (await this.discoverJwksUri());
      return createRemoteJWKSet(new URL(jwksUri), {
        timeoutDuration: this.config.httpTimeoutMs ?? 5_000,
        cooldownDuration: this.config.jwksCooldownMs ?? 30_000,
        cacheMaxAge: this.config.jwksCacheMaxAgeMs ?? 600_000,
      });
    })();
    const keys = this.keys;
    keys.catch(() => {
      const retry = setTimeout(() => {
        if (this.keys === keys) this.keys = undefined;
      }, this.config.discoveryRetryMs ?? 5_000);
      retry.unref?.();
    });
    return this.keys;
  }

  /** Fetch discovery (and so fail fast on a wrong issuer) without a token. */
  async warmUp(): Promise<void> {
    await this.getKeys();
  }

  async authenticate(authorization: string | undefined): Promise<AuthOutcome> {
    if (!authorization) return { ok: false, status: 401, code: "AUTH_REQUIRED", message: "Missing Authorization header" };
    const token = bearer(authorization);
    if (!token) return { ok: false, status: 401, code: "AUTH_INVALID_TOKEN", message: "Authorization must be Bearer <jwt>" };
    let payload: JWTPayload;
    try {
      const keys = await this.getKeys();
      const opts = {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: this.config.algorithms,
        clockTolerance: this.config.clockToleranceSec,
        requiredClaims: ["exp", "sub"],
      };
      const verified =
        keys instanceof Uint8Array ? await jwtVerify(token, keys, opts) : await jwtVerify(token, keys, opts);
      payload = verified.payload;
    } catch (err) {
      return this.failure(err);
    }
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.iat === "number" && payload.iat > now + this.config.clockToleranceSec) {
      return { ok: false, status: 401, code: "AUTH_INVALID_TOKEN", message: "token iat is in the future" };
    }
    return principalFromClaims(payload, this.config);
  }

  private failure(err: unknown): AuthOutcome {
    if (err instanceof IssuerUnavailableError || err instanceof joseErrors.JWKSTimeout) {
      return { ok: false, status: 503, code: "AUTH_PROVIDER_UNAVAILABLE", message: `identity provider unavailable: ${(err as Error).message}` };
    }
    if (err instanceof joseErrors.JWTExpired) return { ok: false, status: 401, code: "AUTH_TOKEN_EXPIRED", message: "token has expired" };
    if (err instanceof joseErrors.JWTClaimValidationFailed) {
      return { ok: false, status: 401, code: "AUTH_INVALID_TOKEN", message: `token ${err.claim} check failed: ${err.reason}` };
    }
    if (err instanceof joseErrors.JOSEAlgNotAllowed || err instanceof joseErrors.JOSENotSupported) {
      return { ok: false, status: 401, code: "AUTH_INVALID_TOKEN", message: "token algorithm is not allowed" };
    }
    if (err instanceof joseErrors.JWKSNoMatchingKey) {
      return { ok: false, status: 401, code: "AUTH_INVALID_TOKEN", message: "token key id is not in the issuer's key set" };
    }
    if (err instanceof joseErrors.JOSEError) {
      return { ok: false, status: 401, code: "AUTH_INVALID_TOKEN", message: "token could not be verified" };
    }
    // Network failure while (re)fetching the JWKS.
    return { ok: false, status: 503, code: "AUTH_PROVIDER_UNAVAILABLE", message: `identity provider unavailable: ${(err as Error)?.message ?? String(err)}` };
  }
}

/** Build the authenticator for a server config. */
export function createAuthenticator(config: ServerConfig, opts: { fetchImpl?: typeof fetch } = {}): Authenticator {
  const mode = authModeOf(config);
  if (mode === "oidc") {
    if (!config.auth?.oidc) throw new Error("auth mode oidc needs auth.oidc (FLOWGRAPH_OIDC_ISSUER, FLOWGRAPH_OIDC_AUDIENCE)");
    return new OidcAuthenticator(config.auth.oidc, opts.fetchImpl);
  }
  if (mode === "none") return new NoAuthAuthenticator(singleUserPrincipal(config));
  return new StaticTokenAuthenticator(config.authToken, singleUserPrincipal(config));
}

/** True when the config stores runs or memory outside the process (Postgres checkpoints or durable memory). */
export function isDurableServer(config: Pick<ServerConfig, "databaseUrl" | "memory">): boolean {
  return Boolean(config.databaseUrl) || (config.memory?.backend ?? "memory") !== "memory";
}

/**
 * Refuse configs that would serve durable, shared state without real
 * identity. Returns warnings to log for configs that start but are legacy.
 */
export function checkStartupAuth(config: ServerConfig): string[] {
  const mode = authModeOf(config);
  const insecureDev = Boolean(config.auth?.insecureDev);
  const durable = isDurableServer(config);
  const warnings: string[] = [];
  if (mode === "none" && durable && !insecureDev) {
    throw new Error(
      "Refusing to start: auth is disabled (FLOWGRAPH_AUTH_DISABLED=1) but runs or memory are durable (DATABASE_URL / FLOWGRAPH_MEMORY_BACKEND). " +
        "Configure FLOWGRAPH_OIDC_ISSUER and FLOWGRAPH_OIDC_AUDIENCE, or set FLOWGRAPH_INSECURE_DEV=1 for a throwaway dev server.",
    );
  }
  if (mode === "token" && durable && config.authToken) {
    if (!config.auth?.explicit && !insecureDev) {
      throw new Error(
        "Refusing to start: FLOWGRAPH_AUTH_TOKEN is a single-user legacy mode, and this server keeps durable runs or memory. " +
          "Use OIDC (FLOWGRAPH_OIDC_ISSUER, FLOWGRAPH_OIDC_AUDIENCE) for a shared server, or set FLOWGRAPH_AUTH_MODE=token to keep one shared token on purpose.",
      );
    }
    warnings.push("FLOWGRAPH_AUTH_MODE=token: every caller is one principal; use OIDC for a shared server.");
  }
  if (mode === "none" && durable && insecureDev) {
    warnings.push("FLOWGRAPH_INSECURE_DEV=1 with auth disabled: anyone who can reach the port owns every run and memory.");
  }
  return warnings;
}
