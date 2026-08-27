/**
 * Run-scoped filesystem key. Prefers `threadId` so HITL resume cycles
 * accumulate in the same file as the original start.
 */
export function runScopedKey(meta: { threadId?: string | undefined; runId?: string | undefined }): string {
  return meta.threadId || meta.runId || "anonymous";
}

export function sanitizeRunKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]+/g, "_") || "run";
}
