import type { IncomingMessage, ServerResponse } from "node:http";
import { ClientSecretsRejectedError, credentialStatus } from "../credentials.js";
import type { RunService } from "../run-service.js";
import { attachSse } from "./sse.js";
import { readJsonBody, sendJson, matchPath } from "./util.js";

export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  service: RunService,
  url: URL,
): Promise<boolean> {
  const { pathname } = url;
  const method = req.method ?? "GET";

  if (method === "GET" && pathname === "/healthz") {
    sendJson(res, 200, {
      ok: true,
      activeRuns: service.registry.activeCount(),
      metrics: service.metrics.snapshot(),
      database: service.config.databaseUrl ? "postgres" : "memory",
      credentials: credentialStatus(),
    });
    return true;
  }

  if (method === "POST" && pathname === "/runs") {
    try {
      const body = (await readJsonBody(req)) as {
        threadId?: string;
        yaml?: string;
        input?: Record<string, unknown>;
        label?: string;
        env?: Record<string, string>;
        stream?: boolean;
      };
      const result = await service.startRun({
        threadId: body.threadId ?? "",
        yaml: body.yaml ?? "",
        ...(body.input ? { input: body.input } : {}),
        ...(body.label ? { label: body.label } : {}),
        ...(body.env ? { env: body.env } : {}),
      });
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
      attachSse(res, service.registry, m.threadId, lastEventId);
      return true;
    }
  }

  {
    const m = matchPath<"threadId">(pathname, "/runs/:threadId/resume");
    if (m && method === "POST") {
      try {
        const body = (await readJsonBody(req)) as {
          resume?: unknown;
          yaml?: string;
        };
        const result = await service.resumeRun({
          threadId: m.threadId,
          resume: body.resume,
          ...(body.yaml ? { yaml: body.yaml } : {}),
        });
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
        sendJson(res, 200, await service.cancelRun(m.threadId));
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
        sendJson(res, 200, await service.pauseRun(m.threadId));
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
        const body = (await readJsonBody(req)) as { yaml?: string };
        sendJson(
          res,
          202,
          await service.continueRun(m.threadId, body.yaml),
        );
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
        sendJson(res, 200, await service.getState(m.threadId, yaml));
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
        sendJson(res, 200, await service.getHistory(m.threadId, yaml));
      } catch (err) {
        sendError(res, err);
      }
      return true;
    }
  }

  return false;
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof ClientSecretsRejectedError) {
    sendJson(res, 400, { error: err.message, code: "CLIENT_SECRETS_REJECTED" });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  const status = /required|Invalid|No persisted|No active/i.test(message) ? 400 : 500;
  sendJson(res, status, { error: message });
}
