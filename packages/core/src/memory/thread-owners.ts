/**
 * Thread ownership for multi-user hosts: a thread id belongs to the principal
 * that started it first. Hosts claim the id before the first run and check it
 * on every later call, from any replica. Durable implementations live next to
 * the checkpoints and memory tables (sqlite, postgres), so ownership is as
 * durable and as shared as the thread's own state.
 */
import { assertStorableText } from "./engine.js";
import { MemoryError } from "./types.js";

export interface ThreadOwnerRecord {
  threadId: string;
  /** Stable principal id of the principal that started the thread. */
  owner: string;
  /** That principal's org ("" when it has none). */
  org: string;
  /** Epoch ms of the claim. */
  createdAt: number;
}

export interface ThreadOwnerClaim extends ThreadOwnerRecord {
  /** True when this call recorded the owner; false when the thread already had one. */
  created: boolean;
}

export interface ThreadOwnerRegistry {
  /**
   * Record `owner` for `threadId` unless the thread already has an owner, and
   * return the record of whoever owns it. Atomic: concurrent claims for one
   * thread, from any host sharing the store, agree on a single owner.
   */
  claim(threadId: string, owner: string, org: string, now?: number): Promise<ThreadOwnerClaim>;
  get(threadId: string): Promise<ThreadOwnerRecord | undefined>;
}

/** Validate the arguments every implementation stores. */
export function checkThreadOwnerArgs(threadId: string, owner?: string, org?: string): void {
  const required: Array<[string, unknown]> = [["thread id", threadId], ...(owner === undefined ? [] : [["owner", owner] as [string, unknown]])];
  for (const [what, v] of required) {
    if (typeof v !== "string" || v.length === 0) {
      throw new MemoryError("MEMORY_THREAD_OWNER_INVALID", `${what} must be a non-empty string`);
    }
  }
  if (org !== undefined && typeof org !== "string") throw new MemoryError("MEMORY_THREAD_OWNER_INVALID", "org must be a string");
  for (const [what, v] of [["thread id", threadId], ["owner", owner], ["org", org]] as const) {
    if (typeof v === "string" && v.length > 512) throw new MemoryError("MEMORY_THREAD_OWNER_INVALID", `${what} is longer than 512 characters`);
  }
  assertStorableText("thread owner registry", { threadId, owner, org });
}

/** Process-local registry (lost on restart; one process only, like an in-memory checkpointer). */
export function createInMemoryThreadOwnerRegistry(): ThreadOwnerRegistry {
  const owners = new Map<string, ThreadOwnerRecord>();
  return {
    async claim(threadId, owner, org, now = Date.now()) {
      checkThreadOwnerArgs(threadId, owner, org);
      const existing = owners.get(threadId);
      if (existing) return { ...existing, created: false };
      const rec = { threadId, owner, org, createdAt: now };
      owners.set(threadId, rec);
      return { ...rec, created: true };
    },
    async get(threadId) {
      checkThreadOwnerArgs(threadId);
      const r = owners.get(threadId);
      return r ? { ...r } : undefined;
    },
  };
}
