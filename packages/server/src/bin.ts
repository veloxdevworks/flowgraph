import { DEFAULT_SHUTDOWN_TIMEOUT_MS, RunService } from "./run-service.js";
import { listen } from "./http/app.js";
import { defaultServerConfig } from "./types.js";
import { errorFields, log } from "./metrics.js";

function crash(kind: string, err: unknown): void {
  log("error", kind, errorFields(err));
  setTimeout(() => process.exit(1), 100).unref();
}

async function main(): Promise<void> {
  const config = defaultServerConfig();
  const service = new RunService(config);
  const server = await listen(service, config);

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    log("info", "shutting down");
    // Stop taking connections, refuse new runs and wait for the ones in
    // flight, then drop idle and streaming (SSE) connections so the listener
    // can close. The hard exit is a backstop past the drain timeout.
    server.close();
    const drainMs = config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    setTimeout(() => process.exit(1), drainMs + 5_000).unref();
    service.close().then(
      () => {
        server.closeAllConnections?.();
        process.exit(0);
      },
      (err: unknown) => {
        log("error", "shutdown.failed", errorFields(err));
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("uncaughtException", (err) => {
    crash("uncaughtException", err);
  });
  process.on("unhandledRejection", (err) => {
    crash("unhandledRejection", err);
  });
}

main().catch((err: unknown) => {
  log("error", "startup.failed", errorFields(err));
  process.exit(1);
});
