import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import {
  startService,
  stopService,
  statusService,
  restartService,
  terminateThreadServices,
  resetServiceManager,
  listThreadServices,
} from "./service-manager.js";

const THREAD = "test-thread-svc";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") {
        s.close();
        reject(new Error("no port"));
        return;
      }
      const port = addr.port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

afterEach(async () => {
  await resetServiceManager();
});

describe("service-manager", () => {
  it("starts a process and reports status", async () => {
    const info = await startService(THREAD, {
      name: "sleeper",
      command: "node",
      args: ["-e", "setInterval(() => {}, 1000)"],
    });
    expect(info.status).toBe("running");
    expect(info.pid).toBeTypeOf("number");
    expect(statusService(THREAD, "sleeper").status).toBe("running");
  });

  it("dedupes start by (threadId, name)", async () => {
    const a = await startService(THREAD, {
      name: "dup",
      command: "node",
      args: ["-e", "setInterval(() => {}, 1000)"],
    });
    const b = await startService(THREAD, {
      name: "dup",
      command: "node",
      args: ["-e", "setInterval(() => {}, 1000)"],
    });
    expect(b.pid).toBe(a.pid);
    expect(listThreadServices(THREAD)).toHaveLength(1);
  });

  it("waits for port readiness", async () => {
    const port = await freePort();
    const info = await startService(THREAD, {
      name: "http-port",
      command: "node",
      args: [
        "-e",
        `require('http').createServer((q,s)=>s.end('ok')).listen(${port}, '127.0.0.1')`,
      ],
      ready: { port },
      readyTimeout: "5s",
      readyInterval: "50ms",
    });
    expect(info.status).toBe("running");
    expect(info.port).toBe(port);
  });

  it("waits for url readiness", async () => {
    const port = await freePort();
    const info = await startService(THREAD, {
      name: "http-url",
      command: "node",
      args: [
        "-e",
        `require('http').createServer((q,s)=>{s.writeHead(200);s.end('ok')}).listen(${port}, '127.0.0.1')`,
      ],
      ready: { url: `http://127.0.0.1:${port}/`, status: [200] },
      readyTimeout: "5s",
      readyInterval: "50ms",
    });
    expect(info.status).toBe("running");
    expect(info.url).toBe(`http://127.0.0.1:${port}/`);
  });

  it("waits for log readiness", async () => {
    const info = await startService(THREAD, {
      name: "logger",
      command: "node",
      args: [
        "-e",
        `console.log('booting'); setTimeout(() => console.log('READY'), 100); setInterval(()=>{},1000)`,
      ],
      ready: { log: "READY" },
      readyTimeout: "5s",
      readyInterval: "50ms",
    });
    expect(info.status).toBe("running");
  });

  it("fails when readiness times out", async () => {
    await expect(
      startService(THREAD, {
        name: "never-ready",
        command: "node",
        args: ["-e", "setInterval(() => {}, 1000)"],
        ready: { port: 1 }, // almost certainly closed
        readyTimeout: "200ms",
        readyInterval: "50ms",
      }),
    ).rejects.toThrow(/did not become ready/);
    expect(statusService(THREAD, "never-ready").status).toBe("not_found");
  });

  it("stops a running service", async () => {
    await startService(THREAD, {
      name: "to-stop",
      command: "node",
      args: ["-e", "setInterval(() => {}, 1000)"],
    });
    const stopped = await stopService(THREAD, "to-stop");
    expect(stopped.status).toBe("stopped");
    expect(statusService(THREAD, "to-stop").status).toBe("not_found");
  });

  it("restarts a service with a new pid", async () => {
    const first = await startService(THREAD, {
      name: "restart-me",
      command: "node",
      args: ["-e", "setInterval(() => {}, 1000)"],
    });
    const second = await restartService(THREAD, {
      name: "restart-me",
      command: "node",
      args: ["-e", "setInterval(() => {}, 1000)"],
    });
    expect(second.status).toBe("running");
    expect(second.pid).not.toBe(first.pid);
  });

  it("terminateThreadServices skips keepAlive unless force", async () => {
    await startService(THREAD, {
      name: "ephemeral",
      command: "node",
      args: ["-e", "setInterval(() => {}, 1000)"],
    });
    await startService(THREAD, {
      name: "persistent",
      command: "node",
      args: ["-e", "setInterval(() => {}, 1000)"],
      keepAlive: true,
    });

    await terminateThreadServices(THREAD);
    expect(statusService(THREAD, "ephemeral").status).toBe("not_found");
    expect(statusService(THREAD, "persistent").status).toBe("running");

    await terminateThreadServices(THREAD, { force: true });
    expect(statusService(THREAD, "persistent").status).toBe("not_found");
  });

  it("status returns not_found for unknown names", () => {
    expect(statusService(THREAD, "missing")).toEqual({
      name: "missing",
      status: "not_found",
      keepAlive: false,
    });
  });
});

describe("service-manager url readiness (live server)", () => {
  it("accepts custom status codes", async () => {
    const port = await freePort();
    const server = http.createServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    try {
      // Service that just stays alive; readiness probes the external server.
      const info = await startService(THREAD, {
        name: "probe-external",
        command: "node",
        args: ["-e", "setInterval(() => {}, 1000)"],
        ready: { url: `http://127.0.0.1:${port}/`, status: [204] },
        readyTimeout: "3s",
        readyInterval: "50ms",
      });
      expect(info.status).toBe("running");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
