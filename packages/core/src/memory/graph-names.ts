/**
 * Graph-name ownership for multi-user hosts: within an org, a graph name
 * belongs to the principal that registered it first. Hosts claim a name before
 * running an uploaded graph and refuse the upload when someone else owns it.
 * Durable implementations live next to the memory tables (sqlite, postgres).
 */
import { assertStorableText } from "./engine.js";
import { MemoryError } from "./types.js";

export interface GraphNameRecord {
  org: string;
  name: string;
  /** Stable principal id of the first registrant. */
  owner: string;
  /** Epoch ms of the first registration. */
  createdAt: number;
}

export interface GraphNameClaim extends GraphNameRecord {
  /** True when this call registered the name; false when it was already registered (by anyone). */
  created: boolean;
}

export interface GraphNameRegistry {
  /**
   * Register `name` in `org` for `owner` unless it is already registered, and
   * return the record of whoever owns it. Atomic: concurrent claims for one
   * name agree on a single owner.
   */
  claim(org: string, name: string, owner: string, now?: number): Promise<GraphNameClaim>;
  get(org: string, name: string): Promise<GraphNameRecord | undefined>;
}

/** Validate the arguments every implementation stores. */
export function checkGraphNameArgs(org: string, name: string, owner?: string): void {
  for (const [what, v] of [["org", org], ["graph name", name], ...(owner === undefined ? [] : [["owner", owner]])] as const) {
    if (typeof v !== "string" || v.length === 0) {
      throw new MemoryError("MEMORY_GRAPH_NAME_INVALID", `${what} must be a non-empty string`);
    }
    if (v.length > 512) throw new MemoryError("MEMORY_GRAPH_NAME_INVALID", `${what} is longer than 512 characters`);
  }
  assertStorableText("graph name registry", { org, name, owner });
}

/** Process-local registry (lost on restart; one process only). */
export function createInMemoryGraphNameRegistry(): GraphNameRegistry {
  const names = new Map<string, GraphNameRecord>();
  const k = (org: string, name: string) => JSON.stringify([org, name]);
  return {
    async claim(org, name, owner, now = Date.now()) {
      checkGraphNameArgs(org, name, owner);
      const existing = names.get(k(org, name));
      if (existing) return { ...existing, created: false };
      const rec = { org, name, owner, createdAt: now };
      names.set(k(org, name), rec);
      return { ...rec, created: true };
    },
    async get(org, name) {
      checkGraphNameArgs(org, name);
      const r = names.get(k(org, name));
      return r ? { ...r } : undefined;
    },
  };
}
