import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type { ServerConfig } from "./types.js";

export interface ProcessIdentity {
  name: "flowgraph-server";
  version: string;
  node: string;
  platform: NodeJS.Platform;
  arch: string;
  hostname: string;
  pid: number;
  uptimeSec: number;
  host: string;
  port: number;
  graphStoreDir: string;
  database: "postgres" | "memory";
  gitSha: string | null;
}

function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return typeof pkg.version === "string" && pkg.version.trim() ? pkg.version : "0.1.0";
  } catch {
    return "0.1.0";
  }
}

/** True when the graph store will vanish on reboot (Linux /tmp or macOS /private/tmp). */
export function isEphemeralGraphStore(dir: string): boolean {
  const resolved = path.resolve(dir);
  return (
    resolved === "/tmp" ||
    resolved.startsWith("/tmp/") ||
    resolved === "/private/tmp" ||
    resolved.startsWith("/private/tmp/")
  );
}

export function processIdentity(config: ServerConfig): ProcessIdentity {
  const gitSha = process.env.FLOWGRAPH_GIT_SHA?.trim() || null;
  return {
    name: "flowgraph-server",
    version: packageVersion(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    pid: process.pid,
    uptimeSec: Math.floor(process.uptime()),
    host: config.host,
    port: config.port,
    graphStoreDir: config.graphStoreDir,
    database: config.databaseUrl ? "postgres" : "memory",
    gitSha,
  };
}
