import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { NodeRunContext } from "../context.js";
import type { TokenUsage } from "../providers/types.js";
import { acquireThreadRun } from "../checkpoint/execution-claim.js";

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Reported/estimated cost; incomplete dimensions are counted separately. */
  costUSD: number;
  calls: number;
  unpricedCalls: number;
  unreportedTokenCalls: number;
  unknownCalls: number;
  pendingCalls: number;
}
export interface BudgetLimits {
  maxUSD?: number | undefined;
  maxTokens?: number | undefined;
  onExceed?: "warn" | "fail" | "interrupt" | undefined;
}
export interface UsageReceipt {
  nodeId: string;
  kind: string;
  startedAt: string;
}
export interface UnresolvedUsageReceipt extends UsageReceipt {
  usage: TokenUsage;
  unknown: boolean;
  /** Older draft ledgers recorded uncertainty counters without receipt ids. */
  legacy?: Pick<RunUsage, "unknownCalls" | "unpricedCalls" | "unreportedTokenCalls">;
}
export interface UsageRecord {
  version: 1;
  revision?: number;
  totals: Omit<RunUsage, "pendingCalls">;
  pending: Record<string, UsageReceipt>;
  unresolved?: Record<string, UnresolvedUsageReceipt>;
  /** Explicit reconciliation audit; also prevents a late response charging twice. */
  resolved?: Record<string, { usage: TokenUsage; at: string }>;
}
type RecordState = UsageRecord & Required<Pick<UsageRecord, "revision" | "unresolved" | "resolved">>;
export interface UsageCheckpointStore {
  readThreadUsage(threadId: string): UsageRecord | undefined | Promise<UsageRecord | undefined>;
  writeThreadUsage(threadId: string, record: UsageRecord): void | Promise<void>;
  /** Atomic revision comparison, required to merge late responses across processes. */
  compareThreadUsage?(threadId: string, revision: number, record: UsageRecord): boolean | Promise<boolean>;
}
export interface MeteredCallOptions<T> {
  kind?: "model" | "provider" | "summary" | "media";
  estimateUSD?: number | undefined;
  usage(result: T): TokenUsage | undefined;
  errorUsage?(error: unknown): TokenUsage | undefined;
  errorOutcomeUnknown?(error: unknown): boolean;
}
const active = new AsyncLocalStorage<UsageLedger>();
export const usageLedgerOf = (): UsageLedger | undefined => active.getStore();
export const withUsageLedger = <T>(ledger: UsageLedger, invoke: () => T): T => active.run(ledger, invoke);
const local = new WeakMap<object, Map<string, UsageRecord>>();
const updates = new WeakMap<object, Map<string, Promise<void>>>();
function serialized<T>(saver: object, threadId: string, fn: () => Promise<T>): Promise<T> {
  let queue = updates.get(saver);
  if (!queue) { queue = new Map(); updates.set(saver, queue); }
  const work = (queue.get(threadId) ?? Promise.resolve()).then(fn);
  const tail = work.then(() => undefined, () => undefined);
  queue.set(threadId, tail);
  void tail.then(() => { if (queue.get(threadId) === tail) queue.delete(threadId); });
  return work;
}
export function emptyUsage(): RunUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0, calls: 0, unpricedCalls: 0, unreportedTokenCalls: 0, unknownCalls: 0, pendingCalls: 0 };
}
function error(code: string, message: string): Error & { code: string; retryable: false } {
  return Object.assign(new Error(`${code}: ${message}`), { code, retryable: false as const });
}
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function recordState(value?: UsageRecord): RecordState {
  const { pendingCalls: _, ...totals } = emptyUsage();
  if (value === undefined) return { version: 1, revision: 0, totals, pending: {}, unresolved: {}, resolved: {} };
  if (!value || value.version !== 1 || !value.totals || !value.pending || Array.isArray(value.totals) || Array.isArray(value.pending) || Array.isArray(value.unresolved) || Array.isArray(value.resolved)) throw error("USAGE_SCHEMA_INVALID", "Unsupported usage record");
  const record = copy({ ...value, revision: value.revision ?? 0, totals: { ...totals, ...value.totals }, unresolved: value.unresolved ?? {}, resolved: value.resolved ?? {} });
  if (!Number.isSafeInteger(record.revision) || record.revision < 0 || Object.values(record.totals).some(n => !Number.isFinite(n) || n < 0)) throw error("USAGE_SCHEMA_INVALID", "Invalid usage totals or revision");
  if (value.unresolved === undefined && (record.totals.unknownCalls > 0 || record.totals.unreportedTokenCalls > 0)) {
    record.unresolved["legacy-unreported"] = {
      nodeId: "legacy", kind: "legacy", startedAt: "", usage: {}, unknown: record.totals.unknownCalls > 0,
      legacy: { unknownCalls: record.totals.unknownCalls, unpricedCalls: record.totals.unpricedCalls, unreportedTokenCalls: record.totals.unreportedTokenCalls },
    };
  }
  return record;
}
export function normalizeUsage(usage: TokenUsage): TokenUsage {
  const out: TokenUsage = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "costUSD"] as const) {
    const n = usage[key];
    if (n === undefined) continue;
    if (!Number.isFinite(n) || n < 0) throw error("USAGE_INVALID", `Provider reported invalid ${key}: ${n}`);
    out[key] = n;
  }
  if (out.totalTokens === undefined && (out.inputTokens !== undefined || out.outputTokens !== undefined)) out.totalTokens = (out.inputTokens ?? 0) + (out.outputTokens ?? 0);
  if (out.totalTokens !== undefined && !Number.isFinite(out.totalTokens)) throw error("USAGE_INVALID", "Token total overflowed");
  return out;
}

export class UsageLedger {
  private pendingUpdates: Promise<void> = Promise.resolve();
  private paid: Promise<void> = Promise.resolve();
  private readonly inheritedPending: Set<string>;
  private warned = false;
  private constructor(
    private readonly saver: object,
    private readonly threadId: string,
    private readonly record: RecordState,
    private readonly read: () => UsageRecord | undefined | Promise<UsageRecord | undefined>,
    private readonly save: (record: UsageRecord) => void | Promise<void>,
    private readonly compare: ((revision: number, record: UsageRecord) => boolean | Promise<boolean>) | undefined,
    private readonly budget?: BudgetLimits,
  ) { this.inheritedPending = new Set(Object.keys(record.pending)); }

  static async open(saver: object, threadId: string, budget?: BudgetLimits): Promise<UsageLedger> {
    const store = saver as Partial<UsageCheckpointStore>;
    let read: () => UsageRecord | undefined | Promise<UsageRecord | undefined>;
    let save: (r: UsageRecord) => void | Promise<void>;
    let compare: ((revision: number, record: UsageRecord) => boolean | Promise<boolean>) | undefined;
    if (store.readThreadUsage && store.writeThreadUsage) {
      read = () => store.readThreadUsage!(threadId);
      save = record => store.writeThreadUsage!(threadId, copy(record));
      if (store.compareThreadUsage) compare = (revision, record) => store.compareThreadUsage!(threadId, revision, copy(record));
    } else {
      let threads = local.get(saver);
      if (!threads) { threads = new Map(); local.set(saver, threads); }
      read = () => threads.get(threadId);
      save = record => { threads.set(threadId, copy(record)); };
      compare = (revision, record) => {
        if ((threads.get(threadId)?.revision ?? 0) !== revision) return false;
        threads.set(threadId, copy(record)); return true;
      };
    }
    return new UsageLedger(saver, threadId, recordState(await read()), read, save, compare, budget);
  }

  snapshot(): RunUsage { return { ...this.record.totals, pendingCalls: Object.keys(this.record.pending).length }; }
  inspect(): UsageRecord { return copy(this.record); }
  private mutate(change: () => void): Promise<void> {
    const result = this.pendingUpdates.then(() => serialized(this.saver, this.threadId, async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const before = recordState(await this.read());
        Object.assign(this.record, copy(before));
        try {
          change();
          this.record.revision = before.revision + 1;
          if (this.compare) { if (!await this.compare(before.revision, this.record)) continue; }
          else await this.save(this.record);
          return;
        } catch (cause) {
          Object.assign(this.record, before);
          if ((cause as { code?: string }).code?.startsWith("USAGE_RECEIPT")) throw cause;
          throw Object.assign(error("USAGE_WRITE_FAILED", "Could not persist accounting. Inspect with 'flowgraph usage inspect <graph> --thread <id>' and reconcile its receipt before retrying."), { cause });
        }
      }
      throw error("USAGE_WRITE_CONFLICT", "Usage changed repeatedly; retry after the other writer finishes");
    }));
    this.pendingUpdates = result;
    return result;
  }
  private get hard(): boolean { return this.budget?.onExceed === "fail" || this.budget?.onExceed === "interrupt"; }
  enforce(ctx: NodeRunContext, before = false, estimateUSD?: number): void {
    const usage = this.snapshot();
    if (estimateUSD !== undefined && (!Number.isFinite(estimateUSD) || estimateUSD < 0)) throw error("USAGE_ESTIMATE_INVALID", "Invalid provider estimate");
    const inherited = Object.keys(this.record.pending).some(id => this.inheritedPending.has(id));
    const uncertain = inherited || usage.unknownCalls > 0 || this.budget?.maxTokens !== undefined && usage.unreportedTokenCalls > 0;
    if (uncertain && this.hard) {
      throw error("USAGE_UNRESOLVED", `Thread ${this.threadId} has uncertain usage. Inspect 'flowgraph usage inspect <graph> --thread ${this.threadId}', stop/reconcile the old owner, then use 'flowgraph usage resolve <graph> --thread ${this.threadId} --receipt <id> --not-billed|--tokens <n> --cost-usd <n> --owner-stopped'.`);
    }
    if (before && inherited && !this.compare) throw error("USAGE_UNRESOLVED", "This custom saver cannot atomically merge late receipts; reconcile the pending receipt or implement compareThreadUsage");
    if (before && (inherited || usage.unknownCalls > 0) && !this.warned) {
      this.warned = true;
      ctx.logger.warn("Continuing without a hard cap while earlier usage is uncertain; pending/unknown counts remain visible and late receipts are merged atomically.");
    }
    if (!this.budget) return;
    const { maxTokens, maxUSD } = this.budget;
    const tokensOver = maxTokens !== undefined && (before ? usage.totalTokens >= maxTokens : usage.totalTokens > maxTokens);
    const dollarsOver = maxUSD !== undefined && (before ? usage.costUSD >= maxUSD || addUSD(usage.costUSD, estimateUSD ?? 0) > maxUSD : usage.costUSD > maxUSD);
    if (!tokensOver && !dollarsOver) return;
    const detail = `tokens=${usage.totalTokens}/${maxTokens ?? "∞"}, usd=${usage.costUSD}/${maxUSD ?? "∞"}${estimateUSD === undefined ? "" : `, nextEstimateUSD=${estimateUSD}`}`;
    const onExceed = this.budget.onExceed ?? "warn";
    ctx.emit("custom.budget.exceeded", { detail, onExceed, usage });
    if (onExceed === "fail") throw error("BUDGET_EXCEEDED", `Budget exceeded (${detail})`);
    if (onExceed === "interrupt") {
      const answer = ctx.interrupt({ reason: `Budget exceeded (${detail}). Approve this continuation?`, kind: "approval", data: { usage } });
      if (answer !== true && !(answer && typeof answer === "object" && (answer as { approved?: unknown }).approved === true)) throw error("BUDGET_DENIED", "Budget continuation was denied; no further paid call was admitted");
    } else ctx.logger.warn(`Budget exceeded (${detail}); continuing (onExceed: warn).`);
  }

  async call<T>(ctx: NodeRunContext, invoke: () => Promise<T>, options: MeteredCallOptions<T>): Promise<T> {
    // All paid calls are serialized under a hard cap, including known estimates.
    const previous = this.paid;
    let release!: () => void;
    if (this.hard) this.paid = new Promise<void>(resolve => { release = resolve; });
    if (this.hard) await previous;
    try {
      Object.assign(this.record, recordState(await this.read()));
      this.enforce(ctx, true, options.estimateUSD);
      ctx.signal?.throwIfAborted();
      const id = randomUUID(), kind = options.kind ?? "model";
      await this.mutate(() => { this.record.pending[id] = { nodeId: ctx.nodeId, kind, startedAt: new Date().toISOString() }; });
      let result: T;
      try { result = await invoke(); }
      catch (err) { await this.complete(ctx, id, kind, options.errorUsage?.(err), options.errorOutcomeUnknown?.(err)); throw err; }
      await this.complete(ctx, id, kind, options.usage(result));
      return result;
    } finally { if (this.hard) release(); }
  }

  private applyUsage(kind: string, usage: TokenUsage, sign: 1 | -1, unknown = !Object.keys(usage).length): void {
    const totals = this.record.totals;
    if (unknown) totals.unknownCalls += sign;
    if (usage.costUSD === undefined) totals.unpricedCalls += sign;
    if (kind !== "media" && usage.totalTokens === undefined) totals.unreportedTokenCalls += sign;
    for (const key of ["inputTokens", "outputTokens", "totalTokens", "costUSD"] as const) {
      totals[key] = key === "costUSD" ? addUSD(totals[key], sign * (usage[key] ?? 0)) : totals[key] + sign * (usage[key] ?? 0);
    }
  }
  private async complete(ctx: NodeRunContext, id: string, kind: string, reported?: TokenUsage, outcomeUnknown?: boolean): Promise<void> {
    const usage = reported ? normalizeUsage(reported) : {};
    const unknown = outcomeUnknown === true || !Object.keys(usage).length;
    let reconciled = false;
    await this.mutate(() => {
      if (this.record.resolved[id]) { reconciled = true; return; }
      const receipt = this.record.pending[id];
      if (!receipt) throw error("USAGE_RECEIPT_MISSING", `Receipt ${id} disappeared; inspect/reconcile its provider outcome`);
      delete this.record.pending[id]; this.record.totals.calls++;
      this.applyUsage(kind, usage, 1, unknown);
      if (unknown || kind !== "media" && usage.totalTokens === undefined) this.record.unresolved[id] = { ...receipt, usage, unknown };
    });
    if (reconciled) return;
    if (usage.costUSD === undefined && this.budget?.maxUSD !== undefined) ctx.logger.warn("A paid call has no USD price; maxUSD limits known costs only. Use maxTokens or a priced provider.");
    if (kind !== "media") ctx.emit("agent.usage", { ...usage, callId: id, purpose: kind, ...(unknown ? { outcome: "unknown" } : {}), ...(usage.costUSD === undefined ? { unpriced: true } : {}) });
  }

  /** Explicit reconciliation after the caller has stopped/reconciled the owner. */
  async resolve(receiptId: string, reported: TokenUsage): Promise<void> {
    const supplied = normalizeUsage(reported);
    if (!Object.keys(supplied).length) throw error("USAGE_INVALID", "Report usage or explicitly report known zero usage");
    await this.mutate(() => {
      if (this.record.resolved[receiptId]) throw error("USAGE_RECEIPT_RESOLVED", `Receipt ${receiptId} was already reconciled`);
      const pending = this.record.pending[receiptId], unresolved = this.record.unresolved[receiptId];
      if (!pending && !unresolved) throw error("USAGE_RECEIPT_NOT_FOUND", `No unresolved receipt ${receiptId}`);
      const receipt = pending ?? unresolved!;
      if (unresolved?.legacy) {
        // This group is an adjustment to previously unreported usage, not a
        // replacement for the known totals already in an older ledger.
        const usage = normalizeUsage({ ...unresolved.usage, ...supplied });
        for (const key of ["inputTokens", "outputTokens", "totalTokens", "costUSD"] as const) {
          const delta = (usage[key] ?? 0) - (unresolved.usage[key] ?? 0);
          this.record.totals[key] = key === "costUSD" ? addUSD(this.record.totals[key], delta) : this.record.totals[key] + delta;
        }
        const remaining = { ...unresolved.legacy };
        this.record.totals.unknownCalls -= remaining.unknownCalls; remaining.unknownCalls = 0;
        if (usage.costUSD !== undefined) { this.record.totals.unpricedCalls -= remaining.unpricedCalls; remaining.unpricedCalls = 0; }
        if (usage.totalTokens !== undefined) { this.record.totals.unreportedTokenCalls -= remaining.unreportedTokenCalls; remaining.unreportedTokenCalls = 0; }
        delete this.record.unresolved[receiptId];
        if (remaining.unpricedCalls || remaining.unreportedTokenCalls) this.record.unresolved[receiptId] = { ...unresolved, usage, unknown: false, legacy: remaining };
        else this.record.resolved[receiptId] = { usage, at: new Date().toISOString() };
        return;
      }
      const old = unresolved?.usage ?? {};
      const usage = normalizeUsage({ ...old, ...supplied });
      if (unresolved) this.applyUsage(receipt.kind, old, -1, unresolved.unknown); else this.record.totals.calls++;
      delete this.record.pending[receiptId]; delete this.record.unresolved[receiptId];
      this.applyUsage(receipt.kind, usage, 1);
      if (receipt.kind !== "media" && usage.totalTokens === undefined) this.record.unresolved[receiptId] = { ...receipt, usage, unknown: false };
      else this.record.resolved[receiptId] = { usage, at: new Date().toISOString() };
    });
  }
}
export async function inspectThreadUsage(saver: object, threadId: string): Promise<UsageRecord> { return (await UsageLedger.open(saver, threadId)).inspect(); }
export async function resolveThreadUsage(saver: object, threadId: string, receiptId: string, usage: TokenUsage): Promise<UsageRecord> {
  const claim = await acquireThreadRun(saver, threadId);
  try { const ledger = await UsageLedger.open(saver, threadId); await ledger.resolve(receiptId, usage); return ledger.inspect(); }
  finally { await claim.release(); }
}
function addUSD(a: number, b: number): number {
  const total = Number((a + b).toPrecision(15));
  if (!Number.isFinite(total) || total < -1e-12) throw error("USAGE_INVALID", "Invalid USD total");
  return Math.max(0, total);
}
