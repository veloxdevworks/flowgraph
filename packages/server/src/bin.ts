import { RunService } from "./run-service.js";
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

  const shutdown = () => {
    log("info", "shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
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
