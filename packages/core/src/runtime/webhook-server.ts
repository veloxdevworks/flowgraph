/**
 * Embedded HTTP ingress for `wait` nodes with `webhook: true`.
 *
 * Process-scoped: one listener per host:port. Routes are one-shot and live
 * only in memory — a process restart loses pending registrations.
 * No auth in v1 (local / trusted-network only).
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";

export const DEFAULT_WEBHOOK_HOST = "127.0.0.1";
export const DEFAULT_WEBHOOK_PORT = 8878;
const MAX_BODY_BYTES = 1_048_576; // 1 MiB

export interface WebhookServerConfig {
  host?: string;
  port?: number;
}

export interface WebhookServerInfo {
  host: string;
  port: number;
}

export type WebhookResumeFn = (body: unknown) => Promise<{ status: string; error?: string }>;

export interface WebhookRoute {
  threadId: string;
  nodeId: string;
  resume: WebhookResumeFn;
  /** Generated listening URL (set by the engine when registering). */
  url?: string;
}

interface PendingRoute extends WebhookRoute {
  settle: (result: { status: string; error?: string }) => void;
  done: Promise<{ status: string; error?: string }>;
}

interface ServerEntry {
  server: http.Server;
  host: string;
  port: number;
  key: string;
}

const servers = new Map<string, ServerEntry>();
const routes = new Map<string, PendingRoute>();

function serverKey(host: string, port: number): string {
  return `${host}:${port}`;
}

export function buildWebhookUrl(
  host: string,
  port: number,
  threadId: string,
  nodeId: string,
): string {
  return `http://${host}:${port}/webhooks/${encodeURIComponent(threadId)}/${encodeURIComponent(nodeId)}`;
}

function parseWebhookPath(url: string | undefined): { threadId: string; nodeId: string } | null {
  if (!url) return null;
  const pathOnly = url.split("?")[0] ?? url;
  const match = /^\/webhooks\/([^/]+)\/([^/]+)\/?$/.exec(pathOnly);
  if (!match) return null;
  return {
    threadId: decodeURIComponent(match[1]!),
    nodeId: decodeURIComponent(match[2]!),
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

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = parseWebhookPath(req.url);
  if (!parsed) {
    sendJson(res, 404, { error: "not_found", message: "Expected /webhooks/:threadId/:nodeId" });
    return;
  }

  const route = routes.get(parsed.threadId);
  if (!route || route.nodeId !== parsed.nodeId) {
    sendJson(res, 404, {
      error: "not_waiting",
      message: `No run waiting on thread "${parsed.threadId}" node "${parsed.nodeId}"`,
    });
    return;
  }

  if (req.method === "GET") {
    sendJson(res, 200, {
      waiting: true,
      threadId: route.threadId,
      nodeId: route.nodeId,
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

  // One-shot: drop from the map before resume so concurrent POSTs get 404,
  // but settle the waiter only after resume completes.
  routes.delete(parsed.threadId);

  try {
    const result = await route.resume(body);
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
  }
}

function listenOnce(
  host: string,
  port: number,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void handleRequest(req, res);
    });
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const addr = server.address() as AddressInfo;
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
  const preferredPort = config.port ?? DEFAULT_WEBHOOK_PORT;
  const preferredKey = serverKey(host, preferredPort);

  const existing = servers.get(preferredKey);
  if (existing) {
    return { host: existing.host, port: existing.port };
  }

  // Also reuse any already-bound server for this host that fell back from the same preferred port.
  for (const entry of servers.values()) {
    if (entry.host === host && preferredPort !== 0 && entry.key === preferredKey) {
      return { host: entry.host, port: entry.port };
    }
  }

  try {
    const { server, port } = await listenOnce(host, preferredPort);
    const key = serverKey(host, preferredPort);
    const entry: ServerEntry = { server, host, port, key };
    servers.set(key, entry);
    if (port !== preferredPort) {
      // ephemeral listen with preferredPort===0
      servers.set(serverKey(host, port), entry);
    }
    return { host, port };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE" && preferredPort !== 0) {
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

export function registerWebhookRoute(route: WebhookRoute): Promise<{ status: string; error?: string }> {
  const prev = routes.get(route.threadId);
  if (prev) prev.settle({ status: "cancelled" });

  let settle!: (result: { status: string; error?: string }) => void;
  const done = new Promise<{ status: string; error?: string }>((resolve) => {
    settle = resolve;
  });
  routes.set(route.threadId, { ...route, settle, done });
  return done;
}

export function unregisterWebhookRoute(threadId: string): void {
  const pending = routes.get(threadId);
  routes.delete(threadId);
  // If unregistered without a resume (cancel / abort), settle as cancelled.
  pending?.settle({ status: "cancelled" });
}

export function getWebhookRoute(threadId: string): WebhookRoute | undefined {
  return routes.get(threadId);
}

/** Await the in-flight webhook resume for a thread (CLI / tests). */
export function waitForWebhookResume(
  threadId: string,
): Promise<{ status: string; error?: string }> | null {
  return routes.get(threadId)?.done ?? null;
}

/** Close all servers and clear routes — for tests / graceful shutdown. */
export async function closeWebhookServers(): Promise<void> {
  routes.clear();
  const closing = [...new Set(servers.values())].map(
    (entry) =>
      new Promise<void>((resolve, reject) => {
        entry.server.close((err) => (err ? reject(err) : resolve()));
      }),
  );
  servers.clear();
  await Promise.all(closing);
}

/** @deprecated Prefer closeWebhookServers */
export async function closeWebhookServer(): Promise<void> {
  await closeWebhookServers();
}
