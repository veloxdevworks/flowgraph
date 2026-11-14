import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

export interface ThreadRunOwner {
  host: string;
  pid: number;
  invocationId: string;
  runId?: string;
  graph?: string;
}
export interface ThreadRunInfo {
  threadId: string;
  token: string;
  createdAt: number;
  /** null for claims created before owner identity was recorded. */
  owner: ThreadRunOwner | null;
}
export interface ThreadRunClaim {
  release(): void | Promise<void>;
}
export interface ThreadRunCoordinator {
  acquireThreadRun(threadId: string, owner?: ThreadRunOwner): ThreadRunClaim | null | Promise<ThreadRunClaim | null>;
  inspectThreadRun?(threadId: string): ThreadRunInfo | undefined | Promise<ThreadRunInfo | undefined>;
  /** Explicit recovery only, after quiescing the owner and reconciling external work. */
  releaseThreadRun?(threadId: string, token: string): boolean | Promise<boolean>;
}
const local = new WeakMap<object, Map<string, ThreadRunInfo>>();
const claims = new WeakMap<ThreadRunClaim, { saver: object; threadId: string; consumed: boolean; released: boolean }>();
export function defaultThreadRunOwner(extra: { runId?: string; graph?: string } = {}): ThreadRunOwner {
  return { host: hostname(), pid: process.pid, invocationId: randomUUID(), ...extra };
}
export function threadAdmissionError(code: string, threadId: string, detail: string): Error & { code: string; retryable: false } {
  return Object.assign(new Error(`${code}: Thread "${threadId}" ${detail}`), { code, retryable: false as const });
}
export async function inspectThreadRun(saver: object, threadId: string): Promise<ThreadRunInfo | undefined> {
  const coordinator = saver as Partial<ThreadRunCoordinator>;
  if (coordinator.inspectThreadRun) return coordinator.inspectThreadRun(threadId);
  return local.get(saver)?.get(threadId);
}
export async function releaseThreadRun(saver: object, threadId: string, token: string): Promise<boolean> {
  const coordinator = saver as Partial<ThreadRunCoordinator>;
  if (coordinator.releaseThreadRun) return coordinator.releaseThreadRun(threadId, token);
  if (coordinator.acquireThreadRun) throw threadAdmissionError("THREAD_RECOVERY_UNSUPPORTED", threadId, "uses a coordinator without a recovery API.");
  const owners = local.get(saver);
  if (owners?.get(threadId)?.token !== token) return false;
  return owners.delete(threadId);
}
/** Consume only a claim minted for this saver and thread, once. */
export function adoptThreadRunClaim(saver: object, threadId: string, claim: ThreadRunClaim): void {
  const proof = claims.get(claim);
  if (!proof || proof.saver !== saver || proof.threadId !== threadId || proof.consumed || proof.released) {
    throw threadAdmissionError("THREAD_CLAIM_INVALID", threadId, "needs a fresh claim acquired for this checkpointer and thread.");
  }
  proof.consumed = true;
}

/** Durable savers coordinate across processes; other savers coordinate by instance. */
export async function acquireThreadRun(saver: object, threadId: string, owner = defaultThreadRunOwner()): Promise<ThreadRunClaim> {
  const coordinator = saver as Partial<ThreadRunCoordinator>;
  let raw: ThreadRunClaim | null;
  if (typeof coordinator.acquireThreadRun === "function") raw = await coordinator.acquireThreadRun(threadId, owner);
  else {
    let owners = local.get(saver);
    if (!owners) { owners = new Map(); local.set(saver, owners); }
    if (owners.has(threadId)) raw = null;
    else {
      const info = { threadId, token: randomUUID(), createdAt: Date.now(), owner };
      owners.set(threadId, info);
      raw = { release() { if (owners.get(threadId)?.token === info.token) owners.delete(threadId); } };
    }
  }
  if (!raw) {
    const info = await inspectThreadRun(saver, threadId);
    const detail = info?.owner ? ` Owner: ${info.owner.host} pid=${info.owner.pid}, invocation=${info.owner.invocationId}.` : "";
    throw Object.assign(threadAdmissionError("THREAD_BUSY", threadId, `is owned by another invocation or has an unresolved crash claim.${detail} Inspect with 'flowgraph thread inspect <graph> --thread ${threadId}'. After stopping/reconciling the owner and external work, use 'flowgraph thread release <graph> --thread ${threadId} --token <token> --owner-stopped'.`), { claim: info });
  }
  const proof = { saver, threadId, consumed: false, released: false };
  const claim: ThreadRunClaim = { async release() { if (proof.released) return; proof.released = true; await raw!.release(); } };
  claims.set(claim, proof);
  return claim;
}
