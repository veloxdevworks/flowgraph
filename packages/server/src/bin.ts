import { RunService } from "./run-service.js";
import { listen } from "./http/app.js";
import { defaultServerConfig } from "./types.js";
import { log } from "./metrics.js";

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
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
