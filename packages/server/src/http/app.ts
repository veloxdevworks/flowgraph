import * as http from "node:http";
import { checkBearerAuth, isAgentCorePath, writeUnauthorized } from "../auth.js";
import { credentialStatus } from "../credentials.js";
import { log } from "../metrics.js";
import type { RunService } from "../run-service.js";
import type { ServerConfig } from "../types.js";
import { handleAgentCore } from "./agentcore.js";
import { handleRest } from "./rest.js";
import { sendJson } from "./util.js";

export function createHttpServer(service: RunService, config: ServerConfig): http.Server {
  return http.createServer(async (req, res) => {
    const host = req.headers.host ?? `localhost:${config.port}`;
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${host}`);
    } catch {
      sendJson(res, 400, { error: "Bad request URL" });
      return;
    }

    // CORS for desktop / browser clients talking to ECS ALB
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Last-Event-ID");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (isAgentCorePath(url.pathname)) {
        const handled = await handleAgentCore(req, res, service, url.pathname);
        if (handled) return;
      } else {
        const auth = checkBearerAuth(req, config.authToken);
        if (!auth.ok) {
          writeUnauthorized(res, auth.message);
          return;
        }
        const handled = await handleRest(req, res, service, url);
        if (handled) return;
      }

      if (url.pathname === "/" && (req.method === "GET" || req.method === "HEAD")) {
        sendJson(res, 200, {
          name: "flowgraph-server",
          version: "0.1.0",
          endpoints: {
            rest: [
              "GET /healthz",
              "POST /runs",
              "GET /runs/:threadId/events",
              "POST /runs/:threadId/resume",
              "POST /runs/:threadId/cancel",
              "POST /runs/:threadId/pause",
              "POST /runs/:threadId/continue",
              "GET /runs/:threadId/state",
              "GET /runs/:threadId/history",
            ],
            agentcore: ["GET /ping", "POST /invocations"],
          },
          credentials: credentialStatus(),
        });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      log("error", "request.error", {
        path: url.pathname,
        message: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });
}

export async function listen(
  service: RunService,
  config: ServerConfig,
): Promise<http.Server> {
  await service.init();
  const server = createHttpServer(service, config);
  await new Promise<void>((resolve, reject) => {
    server.listen(config.port, config.host, () => resolve());
    server.on("error", reject);
  });
  log("info", "server listening", {
    host: config.host,
    port: config.port,
    auth: Boolean(config.authToken),
  });
  return server;
}
