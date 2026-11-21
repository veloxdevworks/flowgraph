/**
 * Shared outbound HTTP request helper used by the `http` and `demo` nodes.
 */

import {
  maskSensitiveHeaders,
  observeSensitiveHeaders,
  REDACTED,
  SecretRedaction,
  setCookieRedactions,
} from "../runtime/secret-redaction.js";
import { guardedFetch, type OutboundHttpPolicy } from "../outbound-http.js";

/** Mask sensitive header values, including names in `runtime.secrets.redact.headers`, before emitting them in events. */
export function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  return maskSensitiveHeaders(headers);
}

/** Field and query-parameter names whose values are masked in saved transcripts. */
const SENSITIVE_NAME =
  /pass(word|wd|phrase)?$|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|^auth$|authorization|credential|cookie|session|signature|^sig$|^code$/i;

/**
 * The response as an event shows it: headers that are sensitive by name (built-in, listed in
 * `runtime.secrets.redact.headers`, or auth/token-like) are masked, and their values and each
 * Set-Cookie (with the cookie rule) are masked in the body too. Nothing is registered run-wide, so
 * state keeps the real values and a later node can still forward a cookie.
 */
export function maskResponseForEvent(response: {
  headers: Record<string, string>;
  setCookies: string[];
  body: unknown;
}): { headers: Record<string, string>; body: unknown } {
  const local = new SecretRedaction();
  const byPolicy = maskSensitiveHeaders(response.headers);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers)) {
    const sensitive = byPolicy[key] === REDACTED || SENSITIVE_NAME.test(key);
    headers[key] = sensitive ? REDACTED : value;
    if (sensitive) local.observe(value);
  }
  for (const cookie of response.setCookies) {
    local.observe(cookie);
    for (const part of setCookieRedactions(cookie)) local.observe(part);
  }
  return { headers, body: local.redact(response.body) };
}

/** URL serialization percent-encodes the brackets in {@link REDACTED}; this stand-in survives it. */
const URL_PLACEHOLDER = "FLOWGRAPHREDACTEDURLPART";

/** Mask credentials in a URL (user info, sensitive query parameters), keeping the rest readable. */
export function redactUrlSecrets(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.username) u.username = URL_PLACEHOLDER;
  if (u.password) u.password = URL_PLACEHOLDER;
  for (const name of [...u.searchParams.keys()]) {
    if (SENSITIVE_NAME.test(name)) u.searchParams.set(name, URL_PLACEHOLDER);
  }
  return u.toString().replaceAll(URL_PLACEHOLDER, REDACTED);
}

/**
 * Mask string values stored under sensitive field names, at any depth.
 * Best effort: a secret under an innocent name stays visible.
 */
export function redactSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveFields);
  if (value != null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, v]) => [
        key,
        typeof v === "string" && SENSITIVE_NAME.test(key) ? REDACTED : redactSensitiveFields(v),
      ]),
    );
  }
  return value;
}

export type PerformHttpRequestOptions = {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  /**
   * Allowed status codes. Defaults to [200, 201, 202, 204].
   * Pass `"any"` to accept every status (used by demo capture transcripts).
   */
  expectStatus?: number[] | "any";
  signal?: AbortSignal | null;
  /** Host limits on where the request may connect (untrusted graphs). */
  outbound?: OutboundHttpPolicy | undefined;
};

export type PerformHttpRequestResult = {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  /** Each Set-Cookie header separately; `headers` joins several into one entry. */
  setCookies: string[];
  /** Full URL including query string. */
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  /** Body as rendered (object/string) before JSON.stringify, if any. */
  requestBody: unknown;
};

/**
 * Perform an outbound HTTP request with the same semantics as the `http` node:
 * JSON Content-Type by default, status expectation, JSON/text body parsing.
 */
export async function performHttpRequest(
  opts: PerformHttpRequestOptions,
): Promise<PerformHttpRequestResult> {
  const method = opts.method ?? "GET";
  const headers = opts.headers ?? {};
  observeSensitiveHeaders(headers);

  let fullUrl = opts.url;
  if (opts.query && Object.keys(opts.query).length > 0) {
    const params = new URLSearchParams(
      Object.entries(opts.query).map(([k, v]) => [k, String(v)]),
    ).toString();
    fullUrl = `${opts.url}?${params}`;
  }

  const requestHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...headers,
  };

  const body =
    opts.body !== undefined && opts.body !== null
      ? typeof opts.body === "string"
        ? opts.body
        : JSON.stringify(opts.body)
      : undefined;

  const requestInit: RequestInit = {
    method,
    headers: requestHeaders,
    ...(body !== undefined ? { body } : {}),
    signal: opts.signal ?? null,
  };

  const response = opts.outbound
    ? await guardedFetch(fullUrl, { method, headers: requestHeaders, body, signal: opts.signal ?? null }, opts.outbound)
    : await fetch(fullUrl, requestInit);

  if (opts.expectStatus !== "any") {
    const allowedStatuses = opts.expectStatus ?? [200, 201, 202, 204];
    if (!allowedStatuses.includes(response.status)) {
      throw new Error(
        `HTTP ${method} ${fullUrl} returned ${response.status} ${response.statusText}`,
      );
    }
  }

  let responseBody: unknown;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    responseBody = await response.json();
  } else {
    responseBody = await response.text();
  }

  const responseHeaders = Object.fromEntries(response.headers);

  return {
    status: response.status,
    body: responseBody,
    headers: responseHeaders,
    setCookies: response.headers.getSetCookie?.() ?? [],
    url: fullUrl,
    method,
    requestHeaders,
    requestBody: opts.body,
  };
}
