import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { ClientSecretsRejectedError, credentialStatus } from "../credentials.js";
import { processIdentity } from "../diagnostics.js";
import { authModeOf } from "../identity.js";
import { refusalOf, TooManyRunsError, unexpectedError } from "../errors.js";
import { errorFields, log } from "../metrics.js";
import type { Principal } from "../identity.js";
import type { RunService } from "../run-service.js";
import type { WorkerPreflightRequest } from "../types.js";
import { attachSse } from "./sse.js";
import { matchPath, PayloadTooLargeError, readJsonBody, sendJson } from "./util.js";
import { ArtifactTooLargeError } from "../artifact-store.js";
import { mintVoiceClientSecret, VoiceRequestError } from "../voice.js";

export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  service: RunService,
  url: URL,
  principal?: Principal,
): Promise<boolean> {
  const { pathname } = url;
  const method = req.method ?? "GET";
  const maxBodyBytes = service.config.maxBodyBytes ?? 2_000_000;

  if (method === "GET" && pathname === "/healthz") {
    sendJson(res, 200, {
      ok: true,
      activeRuns: service.registry.activeCount(),
      metrics: service.metrics.snapshot(),
      database: service.config.databaseUrl ? "postgres" : "memory",
      credentials: credentialStatus(),
      authRequired: authModeOf(service.config) !== "none",
      authMode: authModeOf(service.config),
      identity: processIdentity(service.config),
    });
    return true;
  }

  if (method === "POST" && pathname === "/voice/client-secrets") {
    try {
      const body = (await readJsonBody(req, maxBodyBytes)) as { provider?: string; model?: string };
      sendJson(res, 200, await mintVoiceClientSecret(body ?? {}, service.config));
    } catch (err) {
      sendError(res, err);
    }
    return true;
  }

  if (method === "GET" && pathname === "/worker/labels") {
    try {
      sendJson(res, 200, await service.workerLabels.snapshot());
    } catch (err) {
      sendError(res, err);
    }
    return true;
  }

  if (method === "POST" && pathname === "/worker/preflight") {
    try {
      const body = (await readJsonBody(req, maxBodyBytes)) as WorkerPreflightRequest;
      sendJson(res, 200, await service.preflight(body ?? {}, principal));
    } catch (err) {
      sendError(res, err);
    }
    return true;
  }

  // Artifact staging (ADR-0020 section 10). The routes sit behind the same auth as every other route.
  {
    const m = matchPath<"sha256">(pathname, "/worker/artifacts/:sha256");
    if (m && method === "HEAD") {
      try {
        const has = await service.hasArtifact(m.sha256, principal);
        res.writeHead(has ? 200 : 404, { "Content-Length": 0 });
        res.end();
      } catch (err) {
        sendError(res, err);
      }
      return true;
    }
    if (m && method === "PUT") {
      try {
        const max = service.artifactMaxBytes;
        const declared = Number(req.headers["content-length"]);
        if (max > 0 && Number.isFinite(declared) && declared > max) {
          throw new ArtifactTooLargeError(max);
        }
        sendJson(res, 200, await service.putArtifact(m.sha256, req, principal));
      } catch (err) {
        // The client may still be sending: answer, then close rather than read the rest.
        res.setHeader("Connection", "close");
        sendError(res, err);
      }
      return true;
    }
  }

  {
    const m = matchPath<"threadId" | "sha256">(pathname, "/worker/runs/:threadId/artifacts/:sha256");
    if (m && method === "GET") {
      try {
        const { file, sizeBytes } = await service.getArtifactFile(m.threadId, m.sha256, principal);
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": sizeBytes });
        await pipeline(createReadStream(file), res).catch(() => undefined);
      } catch (err) {
        sendError(res, err);
      }
      return true;
    }
  }

  if (method === "GET" && pathname === "/runs") {
    try {
      sendJson(res, 200, { runs: await service.listRuns(principal) });
    } catch (err) {
      sendError(res, err);
    }
    return true;
  }

  if (method === "POST" && pathname === "/runs") {
    try {
      const body = (await readJsonBody(req, maxBodyBytes)) as {
        threadId?: string;
        yaml?: string;
        input?: Record<string, unknown>;
        label?: string;
        env?: Record<string, string>;
        stream?: boolean;
        dryRun?: boolean;
      };
      const result = await service.startRun({
        threadId: body.threadId ?? "",
        yaml: body.yaml ?? "",
        ...(body.input ? { input: body.input } : {}),
        ...(body.label ? { label: body.label } : {}),
        ...(body.env ? { env: body.env } : {}),
        ...(body.dryRun ? { dryRun: true } : {}),
      }, principal);
      if (body.stream) {
        // Start already fired; attach SSE on the same response via redirect pattern —
        // clients should open GET /runs/:id/events separately. Return start result.
      }
      sendJson(res, 202, result);
    } catch (err) {
      sendError(res, err);
    }
    return true;
  }

  {
    const m = matchPath<"threadId">(pathname, "/runs/:threadId/events");
    if (m && method === "GET") {
      const lastEventId =
        (req.headers["last-event-id"] as string | undefined) ??
        url.searchParams.get("afterSeq") ??
        undefined;
      try {
        await service.authorizeEvents(m.threadId, principal);
      } catch (err) {
        sendError(res, err);
        return true;
      }
      attachSse(res, service.registry, m.threadId, lastEventId, req);
      return true;
    }
  }

  {
    const m = matchPath<"threadId">(pathname, "/runs/:threadId/resume");
    if (m && method === "POST") {
      try {
        const body = (await readJsonBody(req, maxBodyBytes)) as {
          resume?: unknown;
          yaml?: string;
        };
        if (!body || typeof body !== "object" || !("resume" in body)) {
          sendJson(res, 400, { error: "resume is required (use false or null to deny)", code: "RESUME_REQUIRED" });
          return true;
        }
        const result = await service.resumeRun({
          threadId: m.threadId,
          resume: body.resume,
          ...(body.yaml ? { yaml: body.yaml } : {}),
        }, principal);
        sendJson(res, 202, result);
      } catch (err) {
        sendError(res, err);
      }
      return true;
    }
  }

  {
    const m = matchPath<"threadId">(pathname, "/runs/:threadId/cancel");
    if (m && method === "POST") {
      try {
        sendJson(res, 200, await service.cancelRun(m.threadId, principal));
      } catch (err) {
        sendError(res, err);
      }
      return true;
    }
  }

  {
    const m = matchPath<"threadId">(pathname, "/runs/:threadId/pause");
    if (m && method === "POST") {
      try {
        sendJson(res, 200, await service.pauseRun(m.threadId, principal));
      } catch (err) {
        sendError(res, err);
      }
      return true;
    }
  }

  {
    const m = matchPath<"threadId">(pathname, "/runs/:threadId/continue");
    if (m && method === "POST") {
      try {
        const body = (await readJsonBody(req, maxBodyBytes)) as { yaml?: string };
        sendJson(
          res,
          202,
          await service.continueRun(m.threadId, body.yaml, principal),
        );
      } catch (err) {
        sendError(res, err);
      }
      return true;
    }
  }

  {
    const m = matchPath<"threadId">(pathname, "/runs/:threadId/journal");
    if (m && method === "GET") {
      try {
        sendJson(res, 200, { events: await service.getJournal(m.threadId, principal) });
      } catch (err) {
        sendError(res, err);
      }
      return true;
    }
  }

  {
    const m = matchPath<"threadId">(pathname, "/runs/:threadId/issues");
    if (m && method === "GET") {
      try {
        sendJson(res, 200, { issues: await service.listIssues(m.threadId, principal) });
      } catch (err) {
        sendError(res, err);
      }
      return true;
    }
  }

  {
    const m = matchPath<"threadId">(pathname, "/runs/:threadId/state");
    if (m && method === "GET") {
      try {
        const yaml = url.searchParams.get("yaml") ?? undefined;
        sendJson(res, 200, await service.getState(m.threadId, yaml, principal));
      } catch (err) {
        sendError(res, err);
      }
      return true;
    }
  }

  {
    const m = matchPath<"threadId">(pathname, "/runs/:threadId/history");
    if (m && method === "GET") {
      try {
        const yaml = url.searchParams.get("yaml") ?? undefined;
        sendJson(res, 200, await service.getHistory(m.threadId, yaml, principal));
      } catch (err) {
        sendError(res, err);
      }
      return true;
    }
  }

  {
    const m = matchPath<"threadId">(pathname, "/runs/:threadId");
    if (m && method === "GET") {
      try {
        const detail = await service.getRun(m.threadId, principal);
        if (!detail) {
          sendJson(res, 404, { error: `No run "${m.threadId}"` });
        } else {
          sendJson(res, 200, detail);
        }
      } catch (err) {
        sendError(res, err);
      }
      return true;
    }
  }

  return false;
}

export function sendError(res: ServerResponse, err: unknown): void {
  const refusal = refusalOf(err);
  if (refusal) {
    const { status, extra, ...body } = refusal;
    sendJson(res, status, { error: (err as Error).message, ...body, ...extra });
    return;
  }
  if (err instanceof VoiceRequestError) {
    sendJson(res, err.status, { error: err.message, code: err.code });
    return;
  }
  if (err instanceof ClientSecretsRejectedError) {
    sendJson(res, 400, { error: err.message, code: "CLIENT_SECRETS_REJECTED" });
    return;
  }
  if (err instanceof PayloadTooLargeError) {
    sendJson(res, 413, { error: err.message, code: "PAYLOAD_TOO_LARGE" });
    return;
  }
  if (err instanceof TooManyRunsError) {
    sendJson(res, 429, { error: err.message, code: "TOO_MANY_RUNS" });
    return;
  }
  const { status, body } = unexpectedError(err);
  if (status === 500) log("error", "request.failed", errorFields(err));
  sendJson(res, status, body);
}
