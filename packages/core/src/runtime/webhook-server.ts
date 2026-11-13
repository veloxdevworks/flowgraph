/**
 * Embedded HTTP ingress for `wait` nodes with `webhook: true`.
 *
 * Process-scoped: one listener per host:port. Routes are one-shot and live
 * in memory, so a process restart loses pending registrations. Optional
 * shared-secret auth via `runtime.webhookServer.token`, enforced per route
 * (each graph's token guards only its own routes).
 */

import * as http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { parseWebhookPayload } from "./webhook-payload.js";
import {
  clearWebhookIngresses,
  handleWebhookIngress,
  registerWebhookIngress,
  validateWebhookServerConfig,
  webhookBaseUrl,
  type WebhookIngressConfig,
} from "./webhook-ingress.js";
import type { WebhookDeliveryResponse } from "./webhook-delivery-journal.js";
export { validateWebhookServerConfig } from "./webhook-ingress.js";
export type { WebhookIngressConfig } from "./webhook-ingress.js";

export const DEFAULT_WEBHOOK_HOST = "127.0.0.1";
export const DEFAULT_WEBHOOK_PORT = 8878;
const MAX_BODY_BYTES = 1_048_576; // 1 MiB

export interface WebhookServerConfig {
  host?: string | undefined;
  port?: number | undefined;
  /** Shared secret; required on POST when set. */
  token?: string | undefined;
  ingress?: WebhookIngressConfig | undefined;
}

export interface WebhookServerInfo {
  host: string;
  port: number;
}

export type WebhookResumeFn = (
  body: unknown,
) => Promise<{ status: string; error?: string; code?: string }>;

export interface WebhookRoute {
  threadId: string;
  nodeId: string;
  /** Durable LangGraph interrupt id; isolates siblings and repeated node instances. */
  interruptId?: string;
  resume: WebhookResumeFn;
  /** Generated listening URL (set by the engine when registering). */
  url?: string;
  /** Shared secret required on GET/POST for this route (from the graph's `webhookServer.token`). */
  token?: string;
  /** Required keys and primitive property types, checked before claiming the route. */
  schema?: Record<string, unknown>;
  /** Opaque external keys, scoped to the configured listener and ingress. */
  correlation?: Record<string, string>;
  ingressId?: string;
  listenerKey?: string;
  /** Refresh deadline timers only after the delivery receipt releases its lock. */
  afterDelivery?: () => Promise<void>;
}

interface PendingRoute extends WebhookRoute {
  claimed: boolean;
  settle: (result: { status: string; error?: string }) => void;
  done: Promise<{ status: string; error?: string }>;
}

interface ServerEntry {
  server: http.Server;
  host: string;
  port: number;
  key: string;
  token?: string;
}

const servers = new Map<string, ServerEntry>();
const routes = new Map<string, Map<string, PendingRoute>>();
const resumeTails = new Map<string, Promise<void>>();

function routeKey(nodeId: string, interruptId?: string): string {
  return JSON.stringify([nodeId, interruptId ?? null]);
}

function matchingRoutes(threadId: string, nodeId?: string, interruptId?: string): PendingRoute[] {
  return [...(routes.get(threadId)?.values() ?? [])].filter(
    (route) =>
      (nodeId === undefined || route.nodeId === nodeId) &&
      (interruptId === undefined || route.interruptId === interruptId),
  );
}

function currentRoute(route: WebhookRoute): PendingRoute | undefined {
  return routes.get(route.threadId)?.get(routeKey(route.nodeId, route.interruptId));
}

function removeRoute(route: PendingRoute): void {
  const thread = routes.get(route.threadId);
  if (currentRoute(route) !== route) return;
  thread?.delete(routeKey(route.nodeId, route.interruptId));
  if (thread?.size === 0) routes.delete(route.threadId);
}

async function resumeRoute(
  route: PendingRoute,
  body: unknown,
): Promise<{ status: string; error?: string; code?: string }> {
  // Concurrent replies to different gates still write the same checkpoint.
  const previous = resumeTails.get(route.threadId) ?? Promise.resolve();
  const result = previous.then(() =>
    currentRoute(route) === route ? route.resume(body) : { status: "cancelled" },
  );
  const tail = result.then(
    () => {},
    () => {},
  );
  resumeTails.set(route.threadId, tail);
  try {
    return await result;
  } finally {
    if (resumeTails.get(route.threadId) === tail) resumeTails.delete(route.threadId);
  }
}

function serverKey(host: string, port: number): string {
  return `${host}:${port}`;
}

export function buildWebhookUrl(
  host: string,
  port: number,
  threadId: string,
  nodeId: string,
  interruptId?: string,
): string {
  const base = `${webhookBaseUrl(host, port)}/webhooks/${encodeURIComponent(threadId)}/${encodeURIComponent(nodeId)}`;
  return interruptId === undefined ? base : `${base}/${encodeURIComponent(interruptId)}`;
}

function parseWebhookPath(
  url: string | undefined,
): { threadId: string; nodeId: string; interruptId?: string } | null {
  if (!url) return null;
  const pathOnly = url.split("?")[0] ?? url;
  const match = /^\/webhooks\/([^/]+)\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathOnly);
  if (!match) return null;
  return {
    threadId: decodeURIComponent(match[1]!),
    nodeId: decodeURIComponent(match[2]!),
    ...(match[3] === undefined ? {} : { interruptId: decodeURIComponent(match[3]) }),
  };
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function dispatchCorrelatedRoute(
  route: PendingRoute,
  body: unknown,
): Promise<WebhookDeliveryResponse> {
  if (currentRoute(route) !== route || route.claimed) {
    return {
      http: 409,
      body: { error: "not_waiting", message: "Gate was already answered, cancelled, or replaced" },
    };
  }
  route.claimed = true;
  try {
    const result = await resumeRoute(route, body);
    route.settle(result);
    if (result.code === "WEBHOOK_INTERRUPT_NOT_WAITING") {
      return {
        http: 409,
        body: { error: "not_waiting", message: "This gate was already answered or cancelled" },
      };
    }
    return result.status === "error"
      ? {
          http: 422,
          body: {
            error: "resume_failed",
            status: result.status,
            message: "Webhook resume failed; inspect the thread",
          },
        }
      : { http: 200, body: { status: result.status } };
  } catch (err) {
    route.settle({ status: "error", error: err instanceof Error ? err.message : "Resume failed" });
    throw err;
  } finally {
    removeRoute(route);
  }
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  listenerKey: string,
): Promise<void> {
  if (
    await handleWebhookIngress(
      req,
      res,
      listenerKey,
      () => [...routes.values()].flatMap((thread) => [...thread.values()]),
      readBody,
      dispatchCorrelatedRoute,
    )
  )
    return;
  let parsed: ReturnType<typeof parseWebhookPath>;
  try {
    parsed = parseWebhookPath(req.url);
  } catch {
    sendJson(res, 400, {
      error: "invalid_path",
      message: "Webhook path contains invalid percent-encoding",
    });
    return;
  }
  if (!parsed) {
    sendJson(res, 404, {
      error: "not_found",
      message: "Expected /webhooks/:threadId/:nodeId[/:interruptId]",
    });
    return;
  }

  const matches = matchingRoutes(parsed.threadId, parsed.nodeId, parsed.interruptId).filter(
    (route) => route.listenerKey === undefined || route.listenerKey === listenerKey,
  );
  if (matches.length > 1) {
    sendJson(res, 409, {
      error: "ambiguous_interrupt",
      message: "Use the callback URL containing the intended interrupt id",
    });
    return;
  }
  const route = matches[0];
  if (!route || route.claimed) {
    sendJson(res, 404, {
      error: "not_waiting",
      message: `No run waiting on thread "${parsed.threadId}" node "${parsed.nodeId}"`,
    });
    return;
  }

  // Signed integrations cannot be bypassed via the legacy raw-payload endpoint.
  if (route.ingressId) {
    sendJson(res, 410, {
      error: "signed_ingress_required",
      message: "Use the configured signed correlation endpoint",
    });
    return;
  }

  if (route.token && !webhookAuthorized(req, route.token)) {
    sendJson(res, 401, { error: "unauthorized", message: "Missing or invalid webhook token" });
    return;
  }

  if (req.method === "GET") {
    sendJson(res, 200, {
      waiting: true,
      threadId: route.threadId,
      nodeId: route.nodeId,
      ...(route.interruptId === undefined ? {} : { interruptId: route.interruptId }),
    });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed", message: "Use GET or POST" });
    return;
  }

  let body: unknown = {};
  try {
    const raw = await readBody(req);
    if (raw.length > 0) {
      body = JSON.parse(raw.toString("utf8"));
    }
  } catch (err) {
    sendJson(res, 400, {
      error: "invalid_body",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // Body reading yields: another POST, cancellation, or a new registration may
  // have consumed/replaced this route. Claim only the registration we authorized,
  // with no await between the identity check and the claim.
  if (currentRoute(route) !== route || route.claimed) {
    sendJson(res, 404, {
      error: "not_waiting",
      message: "Webhook route was already consumed, cancelled, or replaced",
    });
    return;
  }

  // A rejected value must never reach LangGraph: it persists consumed resume
  // values, so validating in the node alone makes later corrections replay it.
  try {
    parseWebhookPayload(body, route.schema, route.nodeId);
  } catch (err) {
    sendJson(res, 422, {
      error: "invalid_payload",
      status: "interrupted",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  // Keep the claimed registration visible to checkpoint rehydration until resume
  // finishes; otherwise an observer could re-register the consumed interrupt.
  route.claimed = true;

  try {
    const result = await resumeRoute(route, body);
    route.settle(result);
    if (result.status === "error") {
      sendJson(res, 422, {
        error: "resume_failed",
        status: result.status,
        message: result.error ?? "Resume failed",
      });
      return;
    }
    sendJson(res, 200, { status: result.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    route.settle({ status: "error", error: message });
    sendJson(res, 500, {
      error: "resume_error",
      message,
    });
  } finally {
    removeRoute(route);
  }
}

function sameSecret(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

function webhookAuthorized(req: http.IncomingMessage, token: string): boolean {
  const auth = req.headers["authorization"];
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m?.[1] && sameSecret(m[1], token)) return true;
  }
  const header = req.headers["x-flowgraph-token"];
  if (typeof header === "string" && sameSecret(header, token)) return true;
  return false;
}

function listenOnce(host: string, port: number): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    let listenerKey = serverKey(host, port);
    const server = http.createServer((req, res) => {
      // Keep-alive requests can arrive while close() drains an active socket,
      // after server.address() has already become null.
      void handleRequest(req, res, listenerKey).catch(() => {
        if (res.headersSent || res.destroyed) {
          res.destroy();
          return;
        }
        sendJson(res, 500, { error: "internal_error", message: "Webhook request failed" });
      });
    });
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const addr = server.address() as AddressInfo;
      listenerKey = serverKey(host, addr.port);
      resolve({ server, port: addr.port });
    });
  });
}

/**
 * Get-or-create a listener for host:port.
 * On EADDRINUSE for a non-zero port, falls back to an OS-assigned ephemeral port.
 */
export async function ensureWebhookServer(
  config: WebhookServerConfig = {},
): Promise<WebhookServerInfo> {
  const host = config.host ?? DEFAULT_WEBHOOK_HOST;
  validateWebhookServerConfig(config);
  const preferredPort = config.port ?? DEFAULT_WEBHOOK_PORT;
  const preferredKey = serverKey(host, preferredPort);

  const existing = servers.get(preferredKey);
  if (existing) {
    if (config.ingress)
      registerWebhookIngress(serverKey(existing.host, existing.port), config.ingress, config.token);
    return { host: existing.host, port: existing.port };
  }

  // Also reuse any already-bound server for this host that fell back from the same preferred port.
  for (const entry of servers.values()) {
    if (entry.host === host && preferredPort !== 0 && entry.key === preferredKey) {
      if (config.ingress)
        registerWebhookIngress(serverKey(entry.host, entry.port), config.ingress, config.token);
      return { host: entry.host, port: entry.port };
    }
  }

  try {
    const { server, port } = await listenOnce(host, preferredPort);
    const key = serverKey(host, preferredPort);
    const entry: ServerEntry = { server, host, port, key };
    servers.set(key, entry);
    if (config.ingress) registerWebhookIngress(serverKey(host, port), config.ingress, config.token);
    if (port !== preferredPort) {
      // ephemeral listen with preferredPort===0
      servers.set(serverKey(host, port), entry);
      if (config.ingress)
        registerWebhookIngress(serverKey(host, port), config.ingress, config.token);
    }
    return { host, port };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE" && preferredPort !== 0 && !config.ingress) {
      console.warn(
        `[flowgraph] webhook server port ${preferredPort} in use; falling back to an ephemeral port`,
      );
      const { server, port } = await listenOnce(host, 0);
      // Keep the preferred key so subsequent ensureWebhookServer({port: preferred}) reuses this.
      const entry: ServerEntry = { server, host, port, key: preferredKey };
      servers.set(preferredKey, entry);
      servers.set(serverKey(host, port), entry);
      return { host, port };
    }
    throw err;
  }
}

export function registerWebhookRoute(
  route: WebhookRoute,
): Promise<{ status: string; error?: string }> {
  let thread = routes.get(route.threadId);
  if (!thread) {
    thread = new Map();
    routes.set(route.threadId, thread);
  }
  const key = routeKey(route.nodeId, route.interruptId);
  const prev = thread.get(key);
  if (prev) prev.settle({ status: "cancelled" });

  let settle!: (result: { status: string; error?: string }) => void;
  const done = new Promise<{ status: string; error?: string }>((resolve) => {
    settle = resolve;
  });
  thread.set(key, { ...route, claimed: false, settle, done });
  return done;
}

export function unregisterWebhookRoute(
  threadId: string,
  nodeId?: string,
  interruptId?: string,
): void {
  for (const pending of matchingRoutes(threadId, nodeId, interruptId)) {
    removeRoute(pending);
    pending.settle({ status: "cancelled" });
  }
}

/** @internal Settle an automatically expired gate without cancelling its siblings. */
export function settleWebhookInterrupt(
  threadId: string,
  interruptId: string,
  result: { status: string; error?: string },
): void {
  for (const pending of matchingRoutes(threadId, undefined, interruptId)) {
    removeRoute(pending);
    pending.settle(result);
  }
}

/** Return one unambiguous registration, including a claimed one being resumed. */
export function getWebhookRoute(
  threadId: string,
  nodeId?: string,
  interruptId?: string,
): WebhookRoute | undefined {
  const matches = matchingRoutes(threadId, nodeId, interruptId);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Await one gate; without selectors, await the first registration (CLI / tests). */
export function waitForWebhookResume(
  threadId: string,
  nodeId?: string,
  interruptId?: string,
): Promise<{ status: string; error?: string }> | null {
  return matchingRoutes(threadId, nodeId, interruptId)[0]?.done ?? null;
}

/** Close all servers and clear routes — for tests / graceful shutdown. */
export async function closeWebhookServers(): Promise<void> {
  for (const threadId of routes.keys()) unregisterWebhookRoute(threadId);
  const closing = [...new Set(servers.values())].map(
    (entry) =>
      new Promise<void>((resolve, reject) => {
        entry.server.close((err) => (err ? reject(err) : resolve()));
      }),
  );
  servers.clear();
  clearWebhookIngresses();
  await Promise.all(closing);
}

/** @deprecated Prefer closeWebhookServers */
export async function closeWebhookServer(): Promise<void> {
  await closeWebhookServers();
}
