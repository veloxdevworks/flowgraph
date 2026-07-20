import type { IncomingMessage, ServerResponse } from "node:http";
import { ClientSecretsRejectedError } from "../credentials.js";
import type { RunService } from "../run-service.js";
import { streamEventsUntilTerminal } from "./sse.js";
import { readJsonBody, sendJson } from "./util.js";

/**
 * Bedrock AgentCore Runtime HTTP contract:
 * - GET /ping → Healthy | HealthyBusy
 * - POST /invocations → dispatch on action field
 *
 * @see https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html
 */
export async function handleAgentCore(
  req: IncomingMessage,
  res: ServerResponse,
  service: RunService,
  pathname: string,
): Promise<boolean> {
  const method = req.method ?? "GET";

  if (method === "GET" && pathname === "/ping") {
    const busy = service.registry.hasActiveWork();
    sendJson(res, 200, {
      status: busy ? "HealthyBusy" : "Healthy",
      time_of_last_update: Math.floor(Date.now() / 1000),
    });
    return true;
  }

  if (method === "POST" && pathname === "/invocations") {
    try {
      const body = (await readJsonBody(req)) as {
        action?: string;
        threadId?: string;
        yaml?: string;
        input?: Record<string, unknown>;
        label?: string;
        resume?: unknown;
        env?: Record<string, string>;
        afterSeq?: number;
        stream?: boolean;
      };

      const action = body.action ?? "start";

      switch (action) {
        case "start": {
          const result = await service.startRun({
            threadId: body.threadId ?? "",
            yaml: body.yaml ?? "",
            ...(body.input ? { input: body.input } : {}),
            ...(body.label ? { label: body.label } : {}),
            ...(body.env ? { env: body.env } : {}),
          });
          if (body.stream !== false) {
            await streamEventsUntilTerminal(
              res,
              service.registry,
              result.threadId,
              body.afterSeq,
            );
            return true;
          }
          sendJson(res, 200, result);
          return true;
        }
        case "resume": {
          const result = await service.resumeRun({
            threadId: body.threadId ?? "",
            resume: body.resume,
            ...(body.yaml ? { yaml: body.yaml } : {}),
          });
          if (body.stream !== false) {
            await streamEventsUntilTerminal(
              res,
              service.registry,
              result.threadId,
              body.afterSeq,
            );
            return true;
          }
          sendJson(res, 200, result);
          return true;
        }
        case "state": {
          const result = await service.getState(body.threadId ?? "", body.yaml);
          sendJson(res, 200, result);
          return true;
        }
        case "history": {
          const result = await service.getHistory(body.threadId ?? "", body.yaml);
          sendJson(res, 200, result);
          return true;
        }
        case "cancel": {
          sendJson(res, 200, await service.cancelRun(body.threadId ?? ""));
          return true;
        }
        case "pause": {
          sendJson(res, 200, await service.pauseRun(body.threadId ?? ""));
          return true;
        }
        case "continue": {
          sendJson(
            res,
            200,
            await service.continueRun(body.threadId ?? "", body.yaml),
          );
          return true;
        }
        case "events": {
          await streamEventsUntilTerminal(
            res,
            service.registry,
            body.threadId ?? "",
            body.afterSeq,
          );
          return true;
        }
        default:
          sendJson(res, 400, {
            error: `Unknown action "${action}". Expected start|resume|state|history|cancel|pause|continue|events.`,
          });
          return true;
      }
    } catch (err) {
      if (err instanceof ClientSecretsRejectedError) {
        sendJson(res, 400, { error: err.message, code: "CLIENT_SECRETS_REJECTED" });
        return true;
      }
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
      return true;
    }
  }

  return false;
}
