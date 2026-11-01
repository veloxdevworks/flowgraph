import * as http from "node:http";
import { isAgentCorePath } from "../auth.js";
import { checkStartupAuth, OidcAuthenticator, type AuthOutcome, type Principal } from "../identity.js";
import { credentialStatus } from "../credentials.js";
import { isEphemeralGraphStore, processIdentity } from "../diagnostics.js";
import { INTERNAL_ERROR_BODY } from "../errors.js";
import { errorFields, log } from "../metrics.js";
import type { RunService } from "../run-service.js";
import type { ServerConfig } from "../types.js";
import { handleAgentCore } from "./agentcore.js";
import { handleRest } from "./rest.js";
import { sendJson } from "./util.js";
import { logVoicePolicy } from "../voice.js";
import { startConnectClient, type ConnectClient } from "../connect/client.js";

function attachAccessLog(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
  const started = Date.now();
  let logged = false;
  const done = () => {
    if (logged) return;
    logged = true;
    const method = req.method ?? "GET";
    const status = res.statusCode || 0;
    const level = method === "GET" && pathname === "/ping" ? "debug" : "info";
    log(level, "http.access", {
      method,
      path: pathname,
      status,
      durationMs: Date.now() - started,
      remote: req.socket.remoteAddress,
    });
  };
  res.on("finish", done);
  res.on("close", done);
}

export function createHttpServer(service: RunService, config: ServerConfig): http.Server {
  return http.createServer(async (req, res) => {
    const host = req.headers.host ?? `localhost:${config.port}`;
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${host}`);
    } catch {
      attachAccessLog(req, res, req.url ?? "/");
      sendJson(res, 400, { error: "Bad request URL" });
      return;
    }

    attachAccessLog(req, res, url.pathname);

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
      const authenticator = service.authenticator;
      if (isAgentCorePath(url.pathname)) {
        // Outside OIDC mode AgentCore authenticates at the edge (SigV4); with
        // OIDC, /invocations carries the caller's bearer JWT like REST does.
        let principal: Principal | undefined;
        if (url.pathname === "/invocations" && authenticator.mode === "oidc") {
          const auth = await authenticator.authenticate(req.headers.authorization);
          if (!auth.ok) return writeAuthFailure(res, auth);
          principal = auth.principal;
        }
        const handled = await handleAgentCore(req, res, service, url.pathname, principal);
        if (handled) return;
      } else {
        const auth = await authenticator.authenticate(req.headers.authorization);
        if (!auth.ok) return writeAuthFailure(res, auth);
        const handled = await handleRest(req, res, service, url, auth.principal);
        if (handled) return;
      }

      if (url.pathname === "/" && (req.method === "GET" || req.method === "HEAD")) {
        const identity = processIdentity(config);
        sendJson(res, 200, {
          name: identity.name,
          version: identity.version,
          identity,
          endpoints: {
            rest: [
              "GET /healthz",
              "GET /runs",
              "POST /runs",
              "GET /runs/:threadId",
              "GET /runs/:threadId/events",
              "GET /runs/:threadId/journal",
              "POST /runs/:threadId/resume",
              "POST /runs/:threadId/cancel",
              "POST /runs/:threadId/pause",
              "POST /runs/:threadId/continue",
              "GET /runs/:threadId/state",
              "GET /runs/:threadId/history",
              "GET /runs/:threadId/issues",
              "POST /voice/client-secrets",
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
        ...errorFields(err),
      });
      if (!res.headersSent) {
        sendJson(res, 500, { ...INTERNAL_ERROR_BODY });
      }
    }
  });
}

function writeAuthFailure(res: http.ServerResponse, auth: Extract<AuthOutcome, { ok: false }>): void {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth.status === 401) headers["WWW-Authenticate"] = 'Bearer realm="flowgraph"';
  res.writeHead(auth.status, headers);
  res.end(JSON.stringify({ error: auth.message, code: auth.code }));
}

export async function listen(
  service: RunService,
  config: ServerConfig,
): Promise<http.Server> {
  for (const message of checkStartupAuth(config)) log("warn", "auth.legacy", { message });
  await service.init();
  const authenticator = service.authenticator;
  if (authenticator instanceof OidcAuthenticator) {
    try {
      await authenticator.warmUp();
      log("info", "auth.oidc.ready", { issuer: authenticator.config.issuer });
    } catch (err) {
      // Requests retry discovery; a down issuer at boot should not crash-loop the task.
      log("warn", "auth.oidc.discovery-failed", { issuer: authenticator.config.issuer, ...errorFields(err) });
    }
  }
  const server = createHttpServer(service, config);
  await new Promise<void>((resolve, reject) => {
    server.listen(config.port, config.host, () => resolve());
    server.on("error", reject);
  });
  log("info", "server listening", {
    host: config.host,
    port: config.port,
    auth: service.authenticator.mode,
  });
  if (isEphemeralGraphStore(config.graphStoreDir)) {
    log("warn", "graph-store.tmp", {
      graphStoreDir: config.graphStoreDir,
      message:
        "FLOWGRAPH_GRAPH_STORE is under /tmp and will be lost on reboot. Set it to a durable path (e.g. ~/flowgraph-graphs).",
    });
  }
  logVoicePolicy(config);
  if (service.authenticator.mode === "token" && !config.authToken) {
    log("warn", "auth.required", {
      message:
        "REST refuses every request: set FLOWGRAPH_OIDC_ISSUER and FLOWGRAPH_OIDC_AUDIENCE (or FLOWGRAPH_AUTH_TOKEN for a single-user server, or FLOWGRAPH_AUTH_DISABLED=1 for local/dev).",
    });
  }

  let connect: ConnectClient | undefined;
  if (config.connectUrl) {
    try {
      connect = startConnectClient({
        url: config.connectUrl,
        ...(config.connectToken ? { token: config.connectToken } : {}),
        service,
      });
      log("info", "connect.starting", { url: config.connectUrl });
    } catch (err) {
      log("error", "connect.start.failed", {
        url: config.connectUrl,
        ...errorFields(err),
      });
    }
  }
  server.on("close", () => {
    connect?.stop();
  });
  return server;
}
