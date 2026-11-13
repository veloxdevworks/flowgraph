import type * as http from "node:http";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import * as path from "node:path";
import {
  FileWebhookDeliveryJournal,
  type WebhookDeliveryReceipt,
  type WebhookDeliveryResponse,
} from "./webhook-delivery-journal.js";
import { webhookCorrelation } from "./webhook-correlation.js";
import { parseWebhookPayload } from "./webhook-payload.js";

export interface WebhookIngressConfig {
  /** Stable integration namespace: POST /webhook-events/:id. */
  id: string;
  /** Environment variable holding an HMAC-SHA256 key (at least 16 bytes). */
  signingSecretEnv: string;
  /** Durable receipt directory; graph-directory-relative in graph YAML. */
  journalPath: string;
}

export interface CorrelatedWebhookRoute {
  threadId: string;
  nodeId: string;
  interruptId?: string;
  correlation?: Record<string, string>;
  ingressId?: string;
  listenerKey?: string;
  schema?: Record<string, unknown>;
  afterDelivery?: () => Promise<void>;
}

interface Ingress {
  secret: string;
  token?: string;
  directory: string;
  journal: FileWebhookDeliveryJournal;
  pending: Map<string, Promise<WebhookDeliveryResponse>>;
}

const ingresses = new Map<string, Ingress>();
const SIGNATURE_WINDOW_SECONDS = 300;

export function webhookBaseUrl(host: string, port: number): string {
  return `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
}

export function validateWebhookServerConfig(config: {
  host?: string | undefined;
  token?: string | undefined;
  ingress?: WebhookIngressConfig | undefined;
}): void {
  const host = config.host ?? "127.0.0.1";
  const loopback =
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(host);
  if (!loopback && !config.token && !config.ingress) {
    throw new Error(
      "A non-loopback webhook listener requires a token or signed ingress configuration",
    );
  }
  if (config.ingress) {
    const { id, journalPath, signingSecretEnv } = config.ingress;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id) || !journalPath || !signingSecretEnv) {
      throw new Error("Webhook ingress requires a valid id, journalPath, and signingSecretEnv");
    }
    const secret = process.env[signingSecretEnv];
    if (!secret || Buffer.byteLength(secret) < 16) {
      throw new Error(
        `Webhook ingress requires an HMAC key of at least 16 bytes in ${signingSecretEnv}`,
      );
    }
  }
}

export function registerWebhookIngress(
  listenerKey: string,
  config: WebhookIngressConfig,
  token?: string,
): void {
  validateWebhookServerConfig({ ingress: config });
  const secret = process.env[config.signingSecretEnv]!;
  const directory = path.resolve(config.journalPath);
  const normalizedToken = token || undefined;
  const key = JSON.stringify([listenerKey, config.id]);
  const existing = ingresses.get(key);
  if (existing) {
    if (
      existing.directory !== directory ||
      existing.secret !== secret ||
      existing.token !== normalizedToken
    ) {
      throw new Error(
        `Webhook ingress "${config.id}" is already configured differently on this listener`,
      );
    }
    return;
  }
  ingresses.set(key, {
    secret,
    ...(normalizedToken ? { token: normalizedToken } : {}),
    directory,
    journal: new FileWebhookDeliveryJournal(config.journalPath, config.id),
    pending: new Map(),
  });
}

export function clearWebhookIngresses(): void {
  ingresses.clear();
}

function send(res: http.ServerResponse, response: WebhookDeliveryResponse): void {
  const json = JSON.stringify(response.body);
  res.writeHead(response.http, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function response(http: number, error: string, message: string): WebhookDeliveryResponse {
  return { http, body: { error, message } };
}

function replay(receipt: WebhookDeliveryReceipt, fingerprint: string): WebhookDeliveryResponse {
  if (receipt.fingerprint !== fingerprint) {
    return response(
      409,
      "delivery_conflict",
      "Delivery id was already used for a different request",
    );
  }
  return receipt.response
    ? { http: receipt.response.http, body: { ...receipt.response.body, duplicate: true } }
    : response(
        409,
        "delivery_in_doubt",
        "Delivery was claimed but has no recorded outcome; inspect its thread before reconciliation",
      );
}

/** Constant-time comparison, including secrets/tokens of different lengths. */
function equal(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

function authenticated(
  req: http.IncomingMessage,
  raw: Buffer,
  pathname: string,
  ingress: Ingress,
): string | undefined {
  const delivery = req.headers["x-flowgraph-delivery-id"];
  const timestamp = req.headers["x-flowgraph-timestamp"];
  const signature = req.headers["x-flowgraph-signature"];
  if (
    typeof delivery !== "string" ||
    !delivery.length ||
    delivery.length > 200 ||
    /[\x00-\x20\x7f]/.test(delivery)
  )
    return undefined;
  if (typeof timestamp !== "string" || !/^\d{10,12}$/.test(timestamp)) return undefined;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > SIGNATURE_WINDOW_SECONDS) return undefined;
  if (typeof signature !== "string" || !/^sha256=[0-9a-f]{64}$/i.test(signature)) return undefined;
  const expected = createHmac("sha256", ingress.secret)
    .update(`${timestamp}.${delivery}.${pathname}.`)
    .update(raw)
    .digest("hex");
  if (!equal(signature.slice(7).toLowerCase(), expected)) return undefined;
  if (ingress.token) {
    const auth = req.headers["authorization"];
    const bearer = typeof auth === "string" ? /^Bearer\s+(.+)$/i.exec(auth)?.[1] : undefined;
    const header = req.headers["x-flowgraph-token"];
    if (
      !(bearer && equal(bearer, ingress.token)) &&
      !(typeof header === "string" && equal(header, ingress.token))
    )
      return undefined;
  }
  return delivery;
}

/** Returns false only when this is not a correlation endpoint path. */
export async function handleWebhookIngress<R extends CorrelatedWebhookRoute>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  listenerKey: string,
  routes: () => R[],
  readBody: (req: http.IncomingMessage) => Promise<Buffer>,
  dispatch: (route: R, payload: unknown) => Promise<WebhookDeliveryResponse>,
): Promise<boolean> {
  const pathname = (req.url ?? "").split("?")[0]!;
  const match = /^\/webhook-events\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\/?$/.exec(pathname);
  if (!match) return false;
  const ingress = ingresses.get(JSON.stringify([listenerKey, match[1]]));
  if (!ingress) {
    send(res, response(404, "not_found", "Unknown webhook ingress"));
    return true;
  }
  if (req.method !== "POST") {
    send(res, response(405, "method_not_allowed", "Use a signed POST"));
    return true;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    send(res, response(400, "invalid_body", "Cannot read webhook request body"));
    return true;
  }
  const deliveryId = authenticated(req, raw, pathname, ingress);
  if (!deliveryId) {
    console.warn("[flowgraph] webhook authentication rejected");
    send(
      res,
      response(
        401,
        "unauthorized",
        "Missing, expired, or invalid webhook signature/authentication",
      ),
    );
    return true;
  }
  const fingerprint = createHash("sha256").update(pathname).update("\0").update(raw).digest("hex");
  let envelope: {
    correlation: Record<string, string>;
    nodeId?: string;
    interruptId?: string;
    payload: unknown;
  };
  try {
    const input = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    if (!input || typeof input !== "object" || Array.isArray(input) || !("payload" in input))
      throw new Error();
    const correlation = webhookCorrelation(input["correlation"], true);
    if (
      input["nodeId"] !== undefined &&
      (typeof input["nodeId"] !== "string" || !input["nodeId"].length)
    )
      throw new Error();
    if (
      input["interruptId"] !== undefined &&
      (typeof input["interruptId"] !== "string" || !input["interruptId"].length)
    )
      throw new Error();
    envelope = {
      correlation,
      payload: input["payload"],
      ...(typeof input["nodeId"] === "string" ? { nodeId: input["nodeId"] } : {}),
      ...(typeof input["interruptId"] === "string" ? { interruptId: input["interruptId"] } : {}),
    };
  } catch {
    send(
      res,
      response(
        400,
        "invalid_envelope",
        "Expected correlation string pairs, payload, and optional nodeId/interruptId",
      ),
    );
    return true;
  }
  try {
    const previous = await ingress.journal.get(deliveryId);
    if (previous) {
      const active = ingress.pending.get(deliveryId);
      if (active && previous.fingerprint === fingerprint) {
        const done = await active;
        send(res, { http: done.http, body: { ...done.body, duplicate: true } });
      } else send(res, replay(previous, fingerprint));
      return true;
    }
    const candidates = routes().filter(
      (route) =>
        route.listenerKey === listenerKey &&
        route.ingressId === match[1] &&
        (envelope.nodeId === undefined || route.nodeId === envelope.nodeId) &&
        (envelope.interruptId === undefined || route.interruptId === envelope.interruptId) &&
        Object.entries(envelope.correlation).every(
          ([k, v]) => Object.hasOwn(route.correlation ?? {}, k) && route.correlation?.[k] === v,
        ),
    );
    if (candidates.length > 1) {
      send(
        res,
        response(
          409,
          "ambiguous_correlation",
          "Correlation matches multiple waiting gates; add correlation keys or a nodeId/interruptId",
        ),
      );
      return true;
    }
    const route = candidates[0];
    if (!route) {
      send(res, response(404, "not_waiting", "No waiting gate matches this correlation"));
      return true;
    }
    try {
      parseWebhookPayload(envelope.payload, route.schema, route.nodeId);
    } catch (err) {
      send(res, {
        http: 422,
        body: {
          error: "invalid_payload",
          status: "interrupted",
          message: err instanceof Error ? err.message : "Invalid payload",
        },
      });
      return true;
    }
    const claim = await ingress.journal.claim(deliveryId, fingerprint, {
      threadId: route.threadId,
      ...(route.interruptId ? { interruptId: route.interruptId } : {}),
    });
    if (claim.kind === "duplicate") {
      send(res, replay(claim.receipt, fingerprint));
      return true;
    }
    if (claim.kind === "conflict") {
      send(
        res,
        response(409, "delivery_conflict", "Delivery id was already used for a different request"),
      );
      return true;
    }
    if (claim.kind === "busy") {
      send(
        res,
        response(
          409,
          "thread_busy",
          "Another delivery holds this thread; retry after it completes or inspect a crash-left claim",
        ),
      );
      return true;
    }
    const running = (async () => {
      let result: WebhookDeliveryResponse;
      try {
        result = await dispatch(route, envelope.payload);
      } catch {
        result = response(500, "resume_error", "Webhook resume failed; inspect the thread");
      }
      await ingress.journal.complete(claim.claim, result);
      try {
        await route.afterDelivery?.();
      } catch {
        console.warn("[flowgraph] webhook deadline refresh failed; inspect the thread");
      }
      return result;
    })();
    ingress.pending.set(deliveryId, running);
    try {
      send(res, await running);
    } finally {
      if (ingress.pending.get(deliveryId) === running) ingress.pending.delete(deliveryId);
    }
  } catch {
    console.warn("[flowgraph] webhook delivery journal unavailable; request failed closed");
    send(
      res,
      response(
        503,
        "delivery_store_unavailable",
        "Cannot safely claim or record this delivery; inspect the thread before retrying",
      ),
    );
  }
  return true;
}
