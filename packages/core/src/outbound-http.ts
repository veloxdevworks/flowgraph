/**
 * Outbound HTTP for graphs a host does not trust. With an OutboundHttpPolicy
 * on the node policy, http and webhook nodes may only reach public addresses:
 * every hostname is resolved and each resolved address is checked before the
 * connection is made (the check runs inside the socket's DNS lookup, so a name
 * cannot resolve to one address for the check and another for the connect),
 * and every redirect hop is checked the same way before it is followed.
 */

import * as dns from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { NodePolicyError } from "./node-policy.js";

export interface OutboundHttpPolicy {
  /** Refuse loopback, private, link-local, CGNAT, cloud metadata and other non-public addresses. */
  publicOnly: boolean;
  /**
   * Hosts that may be reached even when they resolve to a non-public address,
   * e.g. an internal API the operator vouches for. Entries are `host`,
   * `host:port` or `*.domain`. Cloud metadata and link-local addresses stay
   * blocked whatever this says.
   */
  allowHosts?: readonly string[] | undefined;
  /** Redirect hops to follow (default 5). */
  maxRedirects?: number | undefined;
  /** Largest response body read, in bytes (default 10 MiB). Larger bodies fail OUTBOUND_RESPONSE_TOO_LARGE. */
  maxResponseBytes?: number | undefined;
  /** Whole-request time limit across redirects and the body, in ms (default 30000). Fails OUTBOUND_TIMEOUT. */
  timeoutMs?: number | undefined;
}

export const DEFAULT_OUTBOUND_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_OUTBOUND_TIMEOUT_MS = 30_000;

export interface AddressVerdict {
  blocked: boolean;
  /** Why it is blocked, e.g. "loopback", "private", "metadata". */
  reason?: string;
  /** Blocked even for allow-listed hosts (cloud metadata, link-local). */
  always?: boolean;
}

type Range = { reason: string; always?: boolean; list: net.BlockList };

function range(reason: string, family: "ipv4" | "ipv6", subnets: Array<[string, number]>, always = false): Range {
  const list = new net.BlockList();
  for (const [addr, prefix] of subnets) list.addSubnet(addr, prefix, family);
  return { reason, always, list };
}

// Order matters: the first match names the reason.
const V4_RANGES: Range[] = [
  range("metadata", "ipv4", [["169.254.169.254", 32], ["169.254.170.2", 32], ["100.100.100.200", 32]], true),
  range("link-local", "ipv4", [["169.254.0.0", 16]], true),
  range("unspecified", "ipv4", [["0.0.0.0", 8]]),
  range("loopback", "ipv4", [["127.0.0.0", 8]]),
  range("private", "ipv4", [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16]]),
  range("cgnat", "ipv4", [["100.64.0.0", 10]]),
  range("reserved", "ipv4", [
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["240.0.0.0", 4],
  ]),
  range("multicast", "ipv4", [["224.0.0.0", 4]]),
];

const V6_RANGES: Range[] = [
  range("metadata", "ipv6", [["fd00:ec2::254", 128]], true),
  range("link-local", "ipv6", [["fe80::", 10]], true),
  range("unspecified", "ipv6", [["::", 128]]),
  range("loopback", "ipv6", [["::1", 128]]),
  range("private", "ipv6", [["fc00::", 7], ["fec0::", 10]]),
  range("reserved", "ipv6", [
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["64:ff9b:1::", 48],
    ["::", 96],
  ]),
  range("multicast", "ipv6", [["ff00::", 8]]),
];

/** Expand an IPv6 address (no zone) to eight 16-bit groups, or null when it does not parse. */
function ipv6Groups(addr: string): number[] | null {
  let text = addr.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const o = dotted.slice(1, 5).map(Number);
    if (o.some((x) => x > 255)) return null;
    text = `${text.slice(0, dotted.index)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s ? s.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)) : []);
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - rest.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...new Array<number>(halves.length === 2 ? fill : 0).fill(0), ...rest];
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
  return groups;
}

/** The IPv4 address an IPv6 address carries (mapped, translated or 6to4), if any. */
function embeddedIpv4(groups: number[]): string | null {
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const zero = (from: number, to: number) => groups.slice(from, to).every((g) => g === 0);
  // ::ffff:a.b.c.d (mapped) and ::ffff:0:a.b.c.d (translated)
  if (zero(0, 5) && groups[5] === 0xffff) return v4(groups[6]!, groups[7]!);
  if (zero(0, 4) && groups[4] === 0xffff && groups[5] === 0) return v4(groups[6]!, groups[7]!);
  // 64:ff9b::a.b.c.d (NAT64)
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zero(2, 6)) return v4(groups[6]!, groups[7]!);
  // 2002:aabb:ccdd::/48 (6to4)
  if (groups[0] === 0x2002) return v4(groups[1]!, groups[2]!);
  return null;
}

/** Whether `ip` (an IPv4 or IPv6 literal, optionally with an IPv6 zone) is outside the public internet. */
export function classifyAddress(ip: string): AddressVerdict {
  const bare = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = net.isIP(bare);
  if (family === 4) {
    for (const r of V4_RANGES) if (r.list.check(bare, "ipv4")) return { blocked: true, reason: r.reason, ...(r.always ? { always: true } : {}) };
    return { blocked: false };
  }
  if (family === 6) {
    const groups = ipv6Groups(bare);
    if (!groups) return { blocked: true, reason: "unparsable" };
    const inner = embeddedIpv4(groups);
    if (inner) {
      const v = classifyAddress(inner);
      if (v.blocked) return v;
    }
    for (const r of V6_RANGES) if (r.list.check(bare, "ipv6")) return { blocked: true, reason: r.reason, ...(r.always ? { always: true } : {}) };
    return { blocked: false };
  }
  return { blocked: true, reason: "not an IP address" };
}

/** Whether `url`'s host is on the allow list. */
export function hostIsAllowListed(url: URL, allowHosts: readonly string[] | undefined): boolean {
  if (!allowHosts?.length) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return allowHosts.some((raw) => {
    let entry = raw.trim().toLowerCase();
    if (!entry) return false;
    let entryPort: string | undefined;
    const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
    if (v6) {
      entry = v6[1]!;
      entryPort = v6[2];
    } else {
      const m = /^([^:]+):(\d+)$/.exec(entry);
      if (m) {
        entry = m[1]!;
        entryPort = m[2];
      }
    }
    if (entryPort && entryPort !== port) return false;
    if (entry.startsWith("*.")) return host.endsWith(entry.slice(1)) && host.length > entry.length - 1;
    return host === entry;
  });
}

export type OutboundResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultResolver: OutboundResolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

function blockedError(url: URL, address: string, verdict: AddressVerdict, hop: number): NodePolicyError {
  const via = hop > 0 ? " (after a redirect)" : "";
  return new NodePolicyError(
    "OUTBOUND_ADDRESS_BLOCKED",
    `${url.protocol}//${url.host}${via} resolves to ${address}, a ${verdict.reason} address; only public addresses may be reached here`,
  );
}

/** Refuse a URL before connecting: scheme, credentials and IP-literal hosts. */
function checkTarget(url: URL, policy: OutboundHttpPolicy, hop: number): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new NodePolicyError("OUTBOUND_URL_BLOCKED", `${url.protocol} URLs may not be fetched here; use http or https`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    const v = classifyAddress(host);
    if (v.blocked && (v.always || !hostIsAllowListed(url, policy.allowHosts))) throw blockedError(url, host, v, hop);
  }
}

function guardedLookup(url: URL, policy: OutboundHttpPolicy, hop: number, resolve: OutboundResolver): net.LookupFunction {
  const exempt = hostIsAllowListed(url, policy.allowHosts);
  return ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    resolve(hostname).then(
      (all) => {
        const family = typeof options.family === "number" && options.family ? options.family : 0;
        const addrs = family ? all.filter((a) => a.family === family) : all;
        if (addrs.length === 0) return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }));
        for (const a of addrs) {
          const v = classifyAddress(a.address);
          if (v.blocked && (v.always || !exempt)) return callback(blockedError(url, a.address, v, hop));
        }
        if (options.all) return callback(null, addrs);
        return callback(null, addrs[0]!.address, addrs[0]!.family);
      },
      (err: unknown) => callback(err),
    );
  }) as unknown as net.LookupFunction;
}

export interface GuardedFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | undefined;
  signal?: AbortSignal | null;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY = new Set([101, 204, 205, 304]);
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

/**
 * fetch() for untrusted graphs: refuses non-public addresses (see
 * OutboundHttpPolicy) on the first request and on every redirect, and never
 * connects to a refused address. The whole exchange is bounded in time
 * (`timeoutMs`) and in response size (`maxResponseBytes`). Returns a standard
 * Response.
 */
export async function guardedFetch(
  input: string,
  init: GuardedFetchInit,
  policy: OutboundHttpPolicy,
  deps: { resolve?: OutboundResolver } = {},
): Promise<Response> {
  const timeoutMs = policy.timeoutMs ?? DEFAULT_OUTBOUND_TIMEOUT_MS;
  const timer = new AbortController();
  const handle = setTimeout(() => timer.abort(), timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timer.signal]) : timer.signal;
  try {
    return await guardedFetchOnce(input, { ...init, signal }, policy, deps);
  } catch (err) {
    if (timer.signal.aborted && !init.signal?.aborted) {
      throw new NodePolicyError("OUTBOUND_TIMEOUT", `${(init.method ?? "GET").toUpperCase()} ${input}: no complete response within ${timeoutMs} ms`);
    }
    throw err;
  } finally {
    clearTimeout(handle);
  }
}

async function guardedFetchOnce(
  input: string,
  init: GuardedFetchInit,
  policy: OutboundHttpPolicy,
  deps: { resolve?: OutboundResolver },
): Promise<Response> {
  const resolve = deps.resolve ?? defaultResolver;
  const maxRedirects = policy.maxRedirects ?? 5;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new NodePolicyError("OUTBOUND_URL_BLOCKED", `"${input}" is not an absolute URL`);
  }
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;

  for (let hop = 0; ; hop++) {
    if (policy.publicOnly) checkTarget(url, policy, hop);
    const res = await requestOnce(url, { method, headers, body, signal: init.signal ?? null }, policy.publicOnly ? guardedLookup(url, policy, hop, resolve) : undefined);
    const location = res.headers.location;
    if (REDIRECTS.has(res.statusCode ?? 0) && location) {
      res.resume();
      if (hop >= maxRedirects) throw new Error(`${method} ${input}: more than ${maxRedirects} redirects`);
      const next = new URL(location, url);
      const status = res.statusCode!;
      if ((status === 303 && method !== "HEAD") || ((status === 301 || status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        delete headers["content-type"];
        delete headers["content-length"];
      }
      if (next.origin !== url.origin) for (const h of CREDENTIAL_HEADERS) delete headers[h];
      url = next;
      continue;
    }
    const maxBytes = policy.maxResponseBytes ?? DEFAULT_OUTBOUND_MAX_RESPONSE_BYTES;
    const tooLarge = () =>
      new NodePolicyError("OUTBOUND_RESPONSE_TOO_LARGE", `${method} ${input}: response is larger than ${maxBytes} bytes`);
    const declared = Number(res.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.destroy();
      throw tooLarge();
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of res) {
      size += (c as Buffer).length;
      if (size > maxBytes) {
        res.destroy();
        throw tooLarge();
      }
      chunks.push(c as Buffer);
    }
    const out = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (v === undefined) continue;
      for (const one of Array.isArray(v) ? v : [v]) out.append(k, one);
    }
    const status = res.statusCode ?? 0;
    return new Response(NULL_BODY.has(status) ? null : Buffer.concat(chunks), {
      status,
      statusText: res.statusMessage ?? "",
      headers: out,
    });
  }
}

function requestOnce(
  url: URL,
  init: { method: string; headers: Record<string, string>; body: string | undefined; signal: AbortSignal | null },
  lookup: net.LookupFunction | undefined,
): Promise<http.IncomingMessage> {
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method: init.method,
      headers: init.body !== undefined ? { ...init.headers, "content-length": String(Buffer.byteLength(init.body)) } : init.headers,
      // A fresh connection per request: a pooled socket could belong to another policy.
      agent: false,
      ...(lookup ? { lookup } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
    req.on("response", resolve);
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}
