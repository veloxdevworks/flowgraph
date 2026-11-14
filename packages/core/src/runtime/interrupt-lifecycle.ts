import { replayNodeKey, type ReplayStore, type RunScope } from "../providers/replay-cache.js";

const DEADLINE = "interrupt.deadline";
export function preserveInterruptDeadline(scope: RunScope | undefined, nodeId: string, data: Record<string, unknown>): void {
  if (!scope || typeof data.deadlineAt !== "string") return;
  const key = replayNodeKey(scope.path, nodeId);
  const saved = scope.replay.get(key, DEADLINE);
  if (typeof saved === "string") data.deadlineAt = saved;
  else scope.replay.set(key, DEADLINE, data.deadlineAt);
}

export function finishInterruptDeadline(scope: RunScope | undefined, nodeId: string): void {
  if (scope) scope.replay.delete(replayNodeKey(scope.path, nodeId), DEADLINE);
}

/** Preserve deadlines from older top-level checkpoints without replay entries. */
export function seedInterruptDeadlines(replay: ReplayStore, values: unknown[], roots: Array<((id: string) => boolean) | undefined>): void {
  values.forEach((value, i) => {
    const data = (value as { data?: Record<string, unknown> } | undefined)?.data;
    if (typeof data?.__nodeId !== "string" || typeof data.deadlineAt !== "string" || !roots[i]?.(data.__nodeId)) return;
    const key = replayNodeKey([], data.__nodeId);
    if (replay.get(key, DEADLINE) === undefined) replay.set(key, DEADLINE, data.deadlineAt);
  });
}

export function interruptFingerprint(info: { id?: string; reason?: string; payload?: unknown }): string {
  return JSON.stringify([info.id, info.reason, info.payload], (key, value) => key.startsWith("__") || key === "webhookUrl" ? undefined : value);
}
