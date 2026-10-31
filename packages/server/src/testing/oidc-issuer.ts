/**
 * A local OpenID Connect issuer for tests: keys generated in-process, the
 * discovery document and JWKS served from a loopback HTTP server.
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK, type JWTPayload } from "jose";

export interface TestKey {
  kid: string;
  alg: "RS256" | "ES256";
  privateKey: CryptoKey;
  jwk: JWK;
}

export interface TestIssuer {
  /** Issuer URL (`http://127.0.0.1:<port>`). */
  issuer: string;
  jwksUri: string;
  /** Requests served for the JWKS document. */
  jwksFetches: number;
  /** Requests served for the discovery document. */
  discoveryFetches: number;
  /** Keys currently published in the JWKS. */
  published: TestKey[];
  /** Overrides the `issuer` field of the discovery document. */
  discoveryIssuer?: string;
  /** Override the `jwks_uri` the discovery document names. */
  discoveryJwksUri?: string;
  newKey(alg?: "RS256" | "ES256"): Promise<TestKey>;
  /** Sign a token; `claims` override the defaults (iss, aud, sub, iat, exp in 5 minutes). */
  sign(key: TestKey, claims?: JWTPayload, opts?: { audience?: string | string[]; kid?: string | null }): Promise<string>;
  close(): Promise<void>;
}

export const TEST_AUDIENCE = "flowgraph-test-api";

export async function startTestIssuer(): Promise<TestIssuer> {
  let n = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/.well-known/openid-configuration") {
      state.discoveryFetches++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ issuer: state.discoveryIssuer ?? state.issuer, jwks_uri: state.discoveryJwksUri ?? state.jwksUri }));
      return;
    }
    if (req.url === "/jwks") {
      state.jwksFetches++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ keys: state.published.map((k) => k.jwk) }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const issuer = `http://127.0.0.1:${port}`;

  const state: TestIssuer = {
    issuer,
    jwksUri: `${issuer}/jwks`,
    jwksFetches: 0,
    discoveryFetches: 0,
    published: [],
    async newKey(alg = "RS256") {
      const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
      const kid = `k${++n}`;
      const jwk = { ...(await exportJWK(publicKey)), kid, alg, use: "sig" };
      return { kid, alg, privateKey, jwk };
    },
    async sign(key, claims = {}, opts = {}) {
      const now = Math.floor(Date.now() / 1000);
      const header: { alg: string; kid?: string } = { alg: key.alg };
      if (opts.kid !== null) header.kid = opts.kid ?? key.kid;
      return new SignJWT({ iss: issuer, aud: opts.audience ?? TEST_AUDIENCE, sub: "alice", iat: now, exp: now + 300, ...claims })
        .setProtectedHeader(header)
        .sign(key.privateKey);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  return state;
}

/** An unsigned (`alg: none`) token. */
export function unsecuredToken(claims: JWTPayload): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.`;
}
