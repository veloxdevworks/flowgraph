/**
 * Shared outbound HTTP request helper used by the `http` and `demo` nodes.
 */

/** Header names whose values must never appear in event telemetry. */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "proxy-authorization",
  "x-auth-token",
]);

/** Mask sensitive header values before emitting them in events. */
export function redactHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? "***" : value;
  }
  return out;
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
};

export type PerformHttpRequestResult = {
  status: number;
  body: unknown;
  headers: Record<string, string>;
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

  const response = await fetch(fullUrl, requestInit);

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
    url: fullUrl,
    method,
    requestHeaders,
    requestBody: opts.body,
  };
}
