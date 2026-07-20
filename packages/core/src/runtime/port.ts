/**
 * Allocate free TCP ports for use by `service` (and other) nodes.
 *
 * Probe-and-release: we bind ephemeral listeners, record the ports, then
 * close them before returning. There is an inherent (small) TOCTOU race
 * before the real process binds — same class of caveat as the webhook
 * server's ephemeral-port fallback.
 */

import * as net from "node:net";
import type { AddressInfo } from "node:net";

export interface FindFreePortsOptions {
  count?: number;
  /** Preferred port(s). A taken preferred port falls back to an OS-assigned one. */
  preferred?: number | number[];
  /** Bind host for the probe. Default 127.0.0.1. */
  host?: string;
}

function preferredList(preferred: number | number[] | undefined, count: number): (number | undefined)[] {
  if (preferred === undefined) return Array.from({ length: count }, () => undefined);
  const arr = Array.isArray(preferred) ? preferred : [preferred];
  const out: (number | undefined)[] = [];
  for (let i = 0; i < count; i++) {
    out.push(arr[i]);
  }
  return out;
}

function listenOnce(host: string, port: number): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

async function acquireOne(
  host: string,
  preferred: number | undefined,
): Promise<{ server: net.Server; port: number }> {
  if (preferred !== undefined && preferred > 0) {
    try {
      return await listenOnce(host, preferred);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE") throw err;
      // fall through to ephemeral
    }
  }
  return listenOnce(host, 0);
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Allocate `count` distinct free ports on `host`.
 * Keeps earlier listeners open while acquiring later ones so a single batch
 * never returns duplicate ports, then closes all listeners and returns the
 * port numbers.
 */
export async function findFreePorts(opts: FindFreePortsOptions = {}): Promise<number[]> {
  const count = opts.count ?? 1;
  if (count < 1) throw new Error(`findFreePorts: count must be >= 1 (got ${count})`);
  const host = opts.host ?? "127.0.0.1";
  const preferred = preferredList(opts.preferred, count);

  const held: { server: net.Server; port: number }[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const acquired = await acquireOne(host, preferred[i]);
      held.push(acquired);
    }
    return held.map((h) => h.port);
  } finally {
    await Promise.all(held.map((h) => closeServer(h.server).catch(() => undefined)));
  }
}
