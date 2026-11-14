import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { NodeRunContext } from "../context.js";
import type { TokenUsage } from "../providers/types.js";

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Reported/estimated cost; unpriced or unresolved calls are counted separately. */
  costUSD: number;
  calls: number;
  unpricedCalls: number;
  unreportedTokenCalls: number;
  unknownCalls: number;
  pendingCalls: number;
}
export interface BudgetLimits { maxUSD?: number | undefined; maxTokens?: number | undefined; onExceed?: "warn" | "fail" | "interrupt" | undefined }

const active = new AsyncLocalStorage<UsageLedger>();
export const usageLedgerOf = (): UsageLedger | undefined => active.getStore();
export const withUsageLedger = <T>(ledger: UsageLedger, invoke: () => T): T => active.run(ledger, invoke);

export interface UsageRecord {
  version: 1;
  totals: Omit<RunUsage, "pendingCalls">;
  pending: Record<string, { nodeId: string; kind: string; startedAt: string }>;
}
export interface UsageCheckpointStore {
  readThreadUsage(threadId: string): UsageRecord | undefined | Promise<UsageRecord | undefined>;
  writeThreadUsage(threadId: string, record: UsageRecord): void | Promise<void>;
}
export interface MeteredCallOptions<T> {
  kind?: "model" | "provider" | "summary" | "media";
  estimateUSD?: number | undefined;
  usage(result: T): TokenUsage | undefined;
  /** Legacy providers may emit usage before throwing an interrupt. */
  errorUsage?(error: unknown): TokenUsage | undefined;
}
const local = new WeakMap<object, Map<string, UsageRecord>>();
export function emptyUsage(): RunUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0, calls: 0, unpricedCalls: 0, unreportedTokenCalls: 0, unknownCalls: 0, pendingCalls: 0 };
}
function error(code: string, message: string): Error & { code: string; retryable: false } {
  return Object.assign(new Error(`${code}: ${message}`), { code, retryable: false as const });
}
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export function normalizeUsage(usage: TokenUsage): TokenUsage {
  const out: TokenUsage = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "costUSD"] as const) {
    const n = usage[key];
    if (n === undefined) continue;
    if (!Number.isFinite(n) || n < 0) throw error("USAGE_INVALID", `Provider reported invalid ${key}: ${n}`);
    out[key] = n;
  }
  if (out.totalTokens === undefined && (out.inputTokens !== undefined || out.outputTokens !== undefined)) {
    out.totalTokens = (out.inputTokens ?? 0) + (out.outputTokens ?? 0);
  }
  return out;
}

/** One thread's durable spend, shared by all nodes in this invocation. */
export class UsageLedger {
  private updates: Promise<void> = Promise.resolve();
  private paid: Promise<void> = Promise.resolve();
  private readonly inheritedPending: string[];
  private constructor(
    private readonly threadId: string,
    private readonly record: UsageRecord,
    private readonly save: (record: UsageRecord) => void | Promise<void>,
    private readonly budget?: BudgetLimits,
  ) { this.inheritedPending = Object.keys(record.pending); }

  static async open(saver: object, threadId: string, budget?: BudgetLimits): Promise<UsageLedger> {
    const store = saver as Partial<UsageCheckpointStore>;
    let read: UsageRecord | undefined;
    let save: (r: UsageRecord) => void | Promise<void>;
    if (store.readThreadUsage && store.writeThreadUsage) {
      read = await store.readThreadUsage(threadId);
      save = record => store.writeThreadUsage!(threadId, copy(record));
    } else {
      let threads = local.get(saver);
      if (!threads) { threads = new Map(); local.set(saver, threads); }
      read = threads.get(threadId);
      save = record => { threads.set(threadId, copy(record)); };
    }
    const { pendingCalls: _, ...totals } = emptyUsage();
    if (read !== undefined && (!read || typeof read !== "object")) throw error("USAGE_SCHEMA_INVALID", `Invalid usage record for ${threadId}`);
    const record = read !== undefined ? copy(read) : { version: 1 as const, totals, pending: {} };
    if (record.version !== 1 || !record.totals || !record.pending || Object.keys(totals).some(key => !Number.isFinite(record.totals[key as keyof typeof totals]) || record.totals[key as keyof typeof totals] < 0)) throw error("USAGE_SCHEMA_INVALID", `Unsupported usage record for ${threadId}`);
    return new UsageLedger(threadId, record, save, budget);
  }

  snapshot(): RunUsage { return { ...this.record.totals, pendingCalls: Object.keys(this.record.pending).length }; }
  private mutate(change: () => void): Promise<void> {
    const result = this.updates.then(async () => {
      const before = copy(this.record);
      try { change(); await this.save(this.record); }
      catch (cause) {
        Object.assign(this.record, before);
        throw Object.assign(error("USAGE_WRITE_FAILED", "Could not persist paid-call accounting; reconcile the receipt before retrying"), { cause });
      }
    });
    this.updates = result;
    return result;
  }
  /** Check actual spend after a provider completes (including its final call). */
  enforce(ctx: NodeRunContext, before = false, estimateUSD?: number): void {
    const usage = this.snapshot();
    if (estimateUSD !== undefined && (!Number.isFinite(estimateUSD) || estimateUSD < 0)) throw error("USAGE_ESTIMATE_INVALID", "Provider returned an invalid pre-call price estimate");
    if (before && this.inheritedPending.length) {
      throw error("USAGE_UNRESOLVED", `Thread ${this.threadId} has unfinished paid-call receipts (${this.inheritedPending.join(", ")}); reconcile the owner and provider outcome before another call.`);
    }
    if (!this.budget) return;
    if (this.budget.onExceed && this.budget.onExceed !== "warn" && (usage.unknownCalls > 0 || this.budget.maxTokens !== undefined && usage.unreportedTokenCalls > 0)) {
      throw error("USAGE_UNRESOLVED", `Thread ${this.threadId} has calls with unreported outcomes; reconcile their usage before another call under a hard budget.`);
    }
    const { maxTokens, maxUSD } = this.budget;
    const tokensOver = maxTokens !== undefined && (before ? usage.totalTokens >= maxTokens : usage.totalTokens > maxTokens);
    const dollarsOver = maxUSD !== undefined && (before ? usage.costUSD >= maxUSD || addUSD(usage.costUSD, estimateUSD ?? 0) > maxUSD : usage.costUSD > maxUSD);
    if (!tokensOver && !dollarsOver) return;
    const detail = `tokens=${usage.totalTokens}/${maxTokens ?? "∞"}, usd=${usage.costUSD}/${maxUSD ?? "∞"}${estimateUSD === undefined ? "" : `, nextEstimateUSD=${estimateUSD}`}`;
    const onExceed = this.budget.onExceed ?? "warn";
    ctx.emit("custom.budget.exceeded", { detail, onExceed, usage });
    if (onExceed === "fail") throw error("BUDGET_EXCEEDED", `Budget exceeded (${detail})`);
    if (onExceed === "interrupt") ctx.interrupt({ reason: `Budget exceeded (${detail})`, data: { usage } });
    else ctx.logger.warn(`Budget exceeded (${detail}); continuing (onExceed: warn).`);
  }

  async call<T>(ctx: NodeRunContext, invoke: () => Promise<T>, options: MeteredCallOptions<T>): Promise<T> {
    // With a hard cap, at most one unknown-cost paid call can be in flight.
    const previous = this.paid;
    let release!: () => void;
    const hard = this.budget && this.budget.onExceed !== "warn" && this.budget.onExceed !== undefined;
    if (hard) this.paid = new Promise<void>(resolve => { release = resolve; });
    if (hard) await previous;
    try {
      this.enforce(ctx, true, options.estimateUSD);
      ctx.signal?.throwIfAborted();
      const id = randomUUID(), kind = options.kind ?? "model";
      await this.mutate(() => { this.record.pending[id] = { nodeId: ctx.nodeId, kind, startedAt: new Date().toISOString() }; });
      let result: T;
      try { result = await invoke(); }
      catch (err) {
        await this.complete(ctx, id, kind, options.errorUsage?.(err));
        throw err;
      }
      await this.complete(ctx, id, kind, options.usage(result));
      return result;
    } finally { if (hard) release(); }
  }

  private async complete(ctx: NodeRunContext, id: string, kind: string, reported?: TokenUsage): Promise<void> {
    const usage = reported ? normalizeUsage(reported) : undefined;
    const known = usage && Object.keys(usage).length > 0;
    await this.mutate(() => {
      if (!this.record.pending[id]) throw error("USAGE_RECEIPT_MISSING", `Paid-call receipt ${id} disappeared`);
      delete this.record.pending[id];
      const totals = this.record.totals;
      totals.calls++;
      if (!known) totals.unknownCalls++;
      if (usage?.costUSD === undefined) totals.unpricedCalls++;
      if (kind !== "media" && usage?.totalTokens === undefined) totals.unreportedTokenCalls++;
      for (const key of ["inputTokens", "outputTokens", "totalTokens", "costUSD"] as const) totals[key] = key === "costUSD" ? addUSD(totals[key], usage?.[key] ?? 0) : totals[key] + (usage?.[key] ?? 0);
    });
    if (usage?.costUSD === undefined && this.budget?.maxUSD !== undefined) ctx.logger.warn("A paid call has no reported USD price; maxUSD only limits known costs. Use maxTokens or a priced provider.");
    if (kind !== "media") ctx.emit("agent.usage", { ...usage, callId: id, purpose: kind, ...(known ? {} : { outcome: "unknown" }), ...(usage?.costUSD === undefined ? { unpriced: true } : {}) });
  }
}

/** Suppress binary summation noise without rounding away sub-cent costs. */
function addUSD(a: number, b: number): number {
  const total = Number((a + b).toPrecision(15));
  if (!Number.isFinite(total)) throw error("USAGE_INVALID", "USD total overflowed");
  return total;
}
