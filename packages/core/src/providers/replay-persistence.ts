import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { NodeRunContext } from "../context.js";
import { acquireThreadRun } from "../checkpoint/execution-claim.js";
import { recordedToolResult, runScopeOf } from "./replay-cache.js";
export interface ReplayCheckpointStore {
  /** Atomically seed an absent task record; leave an existing record unchanged. */
  initializeThreadReplay(
    threadId: string,
    task: string,
    entries: Record<string, unknown>,
  ): void | Promise<void>;
  readThreadReplay(
    threadId: string,
    task: string,
  ): Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
  compareThreadReplay(
    threadId: string,
    task: string,
    index: string,
    expected: unknown,
    value: unknown,
  ): boolean | Promise<boolean>;
  listThreadReplay(
    threadId: string,
  ):
    | Array<{ task: string; entries: Record<string, unknown> }>
    | Promise<Array<{ task: string; entries: Record<string, unknown> }>>;
}
const local = new WeakMap<object, Map<string, Map<string, Record<string, unknown>>>>();
function storage(saver: object): ReplayCheckpointStore {
  const store = saver as Partial<ReplayCheckpointStore>;
  if (
    store.initializeThreadReplay &&
    store.readThreadReplay &&
    store.compareThreadReplay &&
    store.listThreadReplay
  )
    return store as ReplayCheckpointStore;
  let threads = local.get(saver);
  if (!threads) {
    threads = new Map();
    local.set(saver, threads);
  }
  return {
    initializeThreadReplay(thread, task, entries) {
      let tasks = threads.get(thread);
      if (!tasks) {
        tasks = new Map();
        threads.set(thread, tasks);
      }
      if (!tasks.has(task)) tasks.set(task, JSON.parse(JSON.stringify(entries)));
    },
    readThreadReplay: (thread, task) => {
      const entries = threads.get(thread)?.get(task);
      return entries === undefined
        ? undefined
        : (JSON.parse(JSON.stringify(entries)) as Record<string, unknown>);
    },
    compareThreadReplay(thread, task, index, expected, value) {
      let tasks = threads.get(thread);
      if (!tasks) {
        tasks = new Map();
        threads.set(thread, tasks);
      }
      const entries = { ...tasks.get(task) };
      if (JSON.stringify(entries[index]) !== JSON.stringify(expected)) return false;
      if (value === undefined) delete entries[index];
      else entries[index] = value;
      tasks.set(task, JSON.parse(JSON.stringify(entries)));
      return true;
    },
    listThreadReplay: (thread) =>
      [...(threads.get(thread) ?? new Map())].map(([task, entries]) => ({
        task,
        entries: JSON.parse(JSON.stringify(entries)) as Record<string, unknown>,
      })),
  };
}
export async function bindNodeReplay(ctx: NodeRunContext, key: string): Promise<void> {
  const config = (
    ctx as NodeRunContext & { _lgConfig?: { configurable?: Record<string, unknown> } }
  )._lgConfig;
  const scope = runScopeOf(config),
    thread = scope?.meta?.threadId,
    task = config?.configurable?.["__pregel_task_id"];
  if (!scope?.checkpointer || !thread || typeof task !== "string") return;
  const durableKey = JSON.stringify([
    scope.meta?.graph,
    config?.configurable?.["checkpoint_ns"] ?? "",
    task,
    key,
    scope.replayWorkspace ?? null,
  ]);
  const store = storage(scope.checkpointer);
  await scope.replay.bind(
    key,
    durableKey,
    () => store.readThreadReplay(thread, durableKey),
    async (entries, index, expected) => {
      if (!(await store.compareThreadReplay(thread, durableKey, index, expected, entries[index])))
        throw Object.assign(
          new Error("Replay step changed concurrently; inspect/reconcile before retrying"),
          { code: "REPLAY_WRITE_CONFLICT", retryable: false },
        );
    },
    (entries) => store.initializeThreadReplay(thread, durableKey, entries),
  );
}
export interface PendingStep {
  __fg: "PendingStep";
  id: string;
  kind: "tool" | "shell";
  owner: { host: string; pid: number };
  tool?: string;
  args?: unknown;
  identity?: string;
  startedAt: string;
}
export function pendingStep(
  kind: PendingStep["kind"],
  extra: Partial<PendingStep> = {},
): PendingStep {
  return {
    __fg: "PendingStep",
    id: randomUUID(),
    kind,
    owner: { host: hostname(), pid: process.pid },
    startedAt: new Date().toISOString(),
    ...extra,
  };
}
export function isPendingStep(value: unknown): value is PendingStep {
  return !!value && typeof value === "object" && (value as PendingStep).__fg === "PendingStep";
}
export function uncertainStep(step: PendingStep): Error {
  return Object.assign(
    new Error(
      `${step.kind} operation ${step.id} has an uncertain outcome (owner ${step.owner.host}:${step.owner.pid}). Stop/reconcile its external work, then use 'flowgraph replay inspect/resolve' before retrying.`,
    ),
    {
      code: step.kind === "shell" ? "SHELL_OUTCOME_UNCERTAIN" : "TOOL_OUTCOME_UNCERTAIN",
      retryable: false,
    },
  );
}
export async function inspectThreadReplay(saver: object, thread: string) {
  return storage(saver).listThreadReplay(thread);
}
export async function resolveThreadReplay(
  saver: object,
  thread: string,
  task: string,
  slot: string,
  receipt: string,
  resolution: { notApplied: true } | { result: unknown },
) {
  const claim = await acquireThreadRun(saver, thread);
  try {
    const store = storage(saver),
      entries = await store.readThreadReplay(thread, task),
      step = entries?.[slot];
    if (!entries || !isPendingStep(step) || step.id !== receipt)
      throw new Error("No matching unresolved replay receipt; inspect again");
    if (step.kind === "shell" && "result" in resolution) {
      const result = resolution.result as {
        stdout?: unknown;
        stderr?: unknown;
        exitCode?: unknown;
      } | null;
      if (
        !result ||
        typeof result.stdout !== "string" ||
        typeof result.stderr !== "string" ||
        !Number.isInteger(result.exitCode)
      )
        throw new Error(
          "Recovered shell result needs string stdout/stderr and an integer exitCode",
        );
    }
    const value =
      "notApplied" in resolution
        ? undefined
        : step.kind === "tool"
          ? recordedToolResult(step.tool!, step.args, resolution.result)
          : { identity: step.identity, result: resolution.result };
    if (!(await store.compareThreadReplay(thread, task, slot, step, value)))
      throw new Error("Replay receipt changed before reconciliation; inspect again");
  } finally {
    await claim.release();
  }
}
