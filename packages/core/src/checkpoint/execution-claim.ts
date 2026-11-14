export interface ThreadRunClaim {
  /** Release only the claim acquired by this invocation. */
  release(): void | Promise<void>;
}
export interface ThreadRunCoordinator {
  acquireThreadRun(threadId: string): ThreadRunClaim | null | Promise<ThreadRunClaim | null>;
}

const local = new WeakMap<object, Map<string, symbol>>();
export function threadAdmissionError(code: string, threadId: string, detail: string): Error & { code: string; retryable: false } {
  return Object.assign(new Error(`${code}: Thread "${threadId}" ${detail}`), { code, retryable: false as const });
}

/** Durable savers coordinate across processes; other savers coordinate by instance. */
export async function acquireThreadRun(saver: object, threadId: string): Promise<ThreadRunClaim> {
  const coordinator = saver as Partial<ThreadRunCoordinator>;
  let claim: ThreadRunClaim | null;
  if (typeof coordinator.acquireThreadRun === "function") {
    claim = await coordinator.acquireThreadRun(threadId);
  } else {
    let owners = local.get(saver);
    if (!owners) { owners = new Map(); local.set(saver, owners); }
    if (owners.has(threadId)) claim = null;
    else {
      const token = Symbol(threadId);
      owners.set(threadId, token);
      claim = { release() { if (owners.get(threadId) === token) owners.delete(threadId); } };
    }
  }
  if (!claim) throw threadAdmissionError("THREAD_BUSY", threadId, "is owned by another invocation or has an unresolved crash claim. Inspect the owner and checkpoint before retrying.");
  return claim;
}
