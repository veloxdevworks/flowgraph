/**
 * Small helpers shared by the vendor adapters. Adapters use `ctx.fetch` (never
 * a global) so tests can inject responses, and read credentials through
 * `ctx.secrets` at call time so the run's secret provider and redaction apply.
 */

import type { MediaCallContext } from "@flowgraph/core";

/** A vendor returned a non-2xx response. `message` never contains credentials. */
export class VendorHttpError extends Error {
  constructor(
    readonly vendor: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${vendor}: HTTP ${status}${body ? `: ${body}` : ""}`);
    this.name = "VendorHttpError";
  }
}

/** First of `envNames` that the run's secret provider can resolve. */
export async function resolveApiKey(vendor: string, ctx: MediaCallContext, envNames: readonly (string | undefined)[]): Promise<string> {
  const names = envNames.filter((n): n is string => !!n);
  for (const name of names) {
    const v = (await ctx.secrets.get(name))?.trim();
    if (v) return v;
  }
  throw new Error(`${vendor}: no API key. Set ${names.join(" or ")} (or apiKeyEnv on the provider entry).`);
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function clip(text: string, max = 500): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export interface RequestOptions {
  vendor: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Header map; set the auth header here. */
  headers?: Record<string, string>;
  /** JSON-serialized when it is a plain object; passed through when FormData/Uint8Array/string. */
  body?: unknown;
}

/** Fetch `url`, parse JSON, throw {@link VendorHttpError} on non-2xx. */
export async function requestJson<T>(ctx: MediaCallContext, url: string, opts: RequestOptions): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: string | Uint8Array | FormData | undefined;
  const b = opts.body;
  if (b === undefined) body = undefined;
  else if (typeof b === "string" || b instanceof Uint8Array || b instanceof FormData) body = b;
  else {
    body = JSON.stringify(b);
    headers["Content-Type"] ??= "application/json";
  }
  const res = await ctx.fetch(url, {
    method: opts.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    ...(body !== undefined ? { body } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new VendorHttpError(opts.vendor, res.status, clip(text));
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${opts.vendor}: expected JSON from ${new URL(url).pathname} but got: ${clip(text, 120)}`);
  }
}

export function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}
