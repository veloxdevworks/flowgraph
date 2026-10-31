/**
 * In-memory checkpointer with the same retention rules as the sqlite and
 * postgres savers. Channel values are stored once per version instead of
 * inside every checkpoint.
 */

import {
  BaseCheckpointSaver,
  MemorySaver,
  copyCheckpoint,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
} from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";

type ChannelVersions = Record<string, string | number>;
import {
  CHECKPOINT_INLINE_MAX_BYTES,
  CHECKPOINT_PIN_CHANNELS,
  ThreadRunGuard,
  selectRetainedCheckpointIds,
  resolveCheckpointRetention,
  threadDeletionRequested,
  type CheckpointRetentionInput,
  type CheckpointThreadStatus,
  type ResolvedCheckpointRetention,
} from "./retention.js";

interface BlobRec {
  type: string;
  value: Uint8Array;
}

interface PinRec {
  ns: string;
  checkpointId: string;
  pinnedAt: number;
  reason: string;
}

interface ThreadRec {
  status: CheckpointThreadStatus;
  updatedAt: number;
  deletable: boolean;
  finishedTtlMs: number | null;
  maxFinished: number | null;
  activeMark: string | null;
}

function writeKey(threadId: string, ns: string, checkpointId: string): string {
  return JSON.stringify([threadId, ns, checkpointId]);
}

function blank<T extends object>(): T {
  return Object.create(null) as T;
}

/**
 * MemorySaver that prunes old checkpoints, keeps interrupt and resume points,
 * and drops finished threads past the retention cap.
 */
export class FlowgraphMemorySaver extends MemorySaver {
  readonly retention: ResolvedCheckpointRetention;
  private readonly blobs: Record<string, Record<string, Record<string, Record<string, BlobRec>>>> = blank();
  private readonly threads = new Map<string, ThreadRec>();
  private readonly pins = new Map<string, PinRec[]>();
  private readonly threadPolicy = new Map<string, ResolvedCheckpointRetention>();
  private readonly runs = new ThreadRunGuard();
  private lastSweepAt = 0;

  constructor(
    retention?: boolean | CheckpointRetentionInput | ResolvedCheckpointRetention | null,
    serde?: ConstructorParameters<typeof MemorySaver>[0],
  ) {
    super(serde);
    this.retention = isResolved(retention) ? retention : resolveCheckpointRetention(retention ?? undefined);
  }

  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const tuple = await super.getTuple(config);
    if (tuple) await this.rehydrate(tuple);
    return tuple;
  }

  override async *list(
    config: RunnableConfig,
    options?: Parameters<MemorySaver["list"]>[1],
  ): AsyncGenerator<CheckpointTuple> {
    for await (const tuple of super.list(config, options)) {
      await this.rehydrate(tuple);
      yield tuple;
    }
  }

  override async getDeltaChannelHistory(
    options: Parameters<BaseCheckpointSaver["getDeltaChannelHistory"]>[0],
  ): Promise<Awaited<ReturnType<BaseCheckpointSaver["getDeltaChannelHistory"]>>> {
    // Stored checkpoints omit channel values when deduping. The base walk
    // loads them through getTuple; MemorySaver's own walk reads the raw rows.
    return BaseCheckpointSaver.prototype.getDeltaChannelHistory.call(this, options);
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions?: ChannelVersions,
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id;
    const ns = config.configurable?.checkpoint_ns ?? "";
    const policy = typeof threadId === "string" ? this.policyFor(threadId) : this.retention;
    let stored: Checkpoint = checkpoint;
    if (policy.enabled && typeof threadId === "string" && threadDeletionRequested(policy)) {
      this.touch(threadId, "active", Date.now(), policy);
    }
    if (policy.enabled && policy.dedupeChannels && typeof threadId === "string") {
      stored = copyCheckpoint(checkpoint);
      const parentId = config.configurable?.checkpoint_id;
      await this.externalizeRepeats(threadId, ns, stored, typeof parentId === "string" ? parentId : undefined, newVersions);
    }
    const result = await super.put(config, stored, metadata);
    if (policy.enabled && typeof threadId === "string") {
      await this.pruneNamespace(threadId, ns, policy);
      this.compactWrites(threadId, ns);
    }
    return result;
  }

  override async putWrites(
    config: RunnableConfig,
    writes: Parameters<MemorySaver["putWrites"]>[1],
    taskId: string,
  ): Promise<void> {
    await super.putWrites(config, writes, taskId);
    const threadIdEarly = config.configurable?.thread_id;
    if (typeof threadIdEarly === "string" && !this.policyFor(threadIdEarly).enabled) return;
    const hit = writes.find(([channel]) => CHECKPOINT_PIN_CHANNELS.has(channel));
    const threadId = config.configurable?.thread_id;
    const checkpointId = config.configurable?.checkpoint_id;
    if (!hit || typeof threadId !== "string" || typeof checkpointId !== "string") return;
    this.addPin(threadId, config.configurable?.checkpoint_ns ?? "", checkpointId, hit[0], Date.now());
  }

  markThreadActive(threadId: string): string | undefined {
    const policy = this.policyFor(threadId);
    if (!policy.enabled || !threadDeletionRequested(policy)) return undefined;
    const mark = crypto.randomUUID();
    this.touch(threadId, "active", Date.now(), policy, mark);
    return mark;
  }

  savedThreadStatus(threadId: string): { status: CheckpointThreadStatus; updatedAt: number } | undefined {
    const row = this.threads.get(threadId);
    if (!row) return undefined;
    return { status: row.status, updatedAt: row.updatedAt };
  }

  restoreThreadStatus(
    threadId: string,
    prior: { status: CheckpointThreadStatus; updatedAt: number } | undefined,
    activeMark: string,
  ): void {
    const row = this.threads.get(threadId);
    if (!row || row.status !== "active" || row.activeMark !== activeMark) return;
    if (!prior) {
      this.threads.delete(threadId);
      return;
    }
    this.touch(threadId, prior.status, prior.updatedAt, this.policyFor(threadId));
  }

  beginThreadRun(threadId: string): number {
    return this.runs.begin(threadId);
  }

  endThreadRun(threadId: string, status: CheckpointThreadStatus, token = 0, resumed = false, releaseOnly = false): void {
    this.runs.end(threadId, status, token, resumed, releaseOnly);
  }

  override async deleteThread(threadId: string): Promise<void> {
    delete this.blobs[threadId];
    this.threads.delete(threadId);
    this.pins.delete(threadId);
    await super.deleteThread(threadId);
  }

  noteThreadPolicy(threadId: string, policy: ResolvedCheckpointRetention): void {
    this.threadPolicy.set(threadId, policy);
  }

  async noteThreadStatus(threadId: string, status: CheckpointThreadStatus, now = Date.now()): Promise<void> {
    const policy = this.policyFor(threadId);
    if (!policy.enabled) return;
    if (status === "paused") this.pinHead(threadId, now);
    if (!threadDeletionRequested(policy)) return;
    this.touch(threadId, status, now, policy);
    if (status !== "finished") return;
    const cap = policy.maxFinishedThreads;
    const capped = [...this.threads.values()].filter((row) => row.deletable && row.status === "finished" && row.maxFinished !== null);
    const overCap = cap !== null && capped.length > cap;
    if (cap === 0 || overCap || now - this.lastSweepAt >= 60_000) {
      this.lastSweepAt = now;
      await this.sweep(now);
    }
  }

  async sweep(now = Date.now()): Promise<void> {
    this.lastSweepAt = now;
    const stillFinished = (threadId: string, seenUpdatedAt: number): boolean => {
      if (this.runs.held(threadId)) return false;
      const live = this.threads.get(threadId);
      return !!live && live.deletable && live.status === "finished" && live.updatedAt === seenUpdatedAt;
    };
    for (const [threadId, row] of [...this.threads]) {
      if (!row.deletable || row.status !== "finished" || row.finishedTtlMs === null) continue;
      if (now - row.updatedAt < row.finishedTtlMs) continue;
      if (!stillFinished(threadId, row.updatedAt)) continue;
      await this.deleteThread(threadId);
    }
    const groups = new Map<number, [string, ThreadRec][]>();
    for (const entry of this.threads) {
      const row = entry[1];
      if (!row.deletable || row.status !== "finished" || row.maxFinished === null) continue;
      const list = groups.get(row.maxFinished) ?? [];
      list.push(entry);
      groups.set(row.maxFinished, list);
    }
    for (const [cap, rows] of groups) {
      rows.sort((a, b) => a[1].updatedAt - b[1].updatedAt || (a[0] < b[0] ? -1 : 1));
      while (rows.length > cap) {
        const idx = rows.findIndex(([id, rec]) => stillFinished(id, rec.updatedAt));
        if (idx < 0) break;
        const next = rows.splice(idx, 1)[0];
        if (!next) break;
        await this.deleteThread(next[0]);
      }
    }
  }

  /** Versions stored for one channel. Empty when dedupe is off or the channel was never written. */
  storedVersions(threadId: string, ns: string, channel: string): string[] {
    return Object.keys(this.blobs[threadId]?.[ns]?.[channel] ?? {});
  }

  /** Serialized checkpoint, write, and blob bytes still held. */
  byteSize(): number {
    let n = 0;
    const add = (bytes: Uint8Array | undefined) => {
      if (bytes) n += bytes.byteLength;
    };
    for (const nsMap of Object.values(this.storage)) {
      for (const bucket of Object.values(nsMap)) {
        for (const row of Object.values(bucket)) {
          add(row[0]);
          add(row[1]);
        }
      }
    }
    for (const group of Object.values(this.writes)) {
      for (const entry of Object.values(group)) add(entry[2]);
    }
    for (const nsMap of Object.values(this.blobs)) {
      for (const bucket of Object.values(nsMap)) {
        for (const versions of Object.values(bucket)) {
          for (const blob of Object.values(versions)) add(blob.value);
        }
      }
    }
    return n;
  }

  private policyFor(threadId: string): ResolvedCheckpointRetention {
    return this.threadPolicy.get(threadId) ?? this.retention;
  }

  private touch(
    threadId: string,
    status: CheckpointThreadStatus,
    updatedAt: number,
    policy: ResolvedCheckpointRetention,
    activeMark: string | null = null,
  ): void {
    const deletable = status === "finished" && threadDeletionRequested(policy);
    this.threads.set(threadId, {
      status,
      updatedAt,
      deletable,
      finishedTtlMs: deletable ? policy.finishedTtlMs : null,
      maxFinished: deletable ? policy.maxFinishedThreads : null,
      activeMark,
    });
  }

  private addPin(threadId: string, ns: string, checkpointId: string, reason: string, pinnedAt: number): void {
    const cap = this.retention.maxInterruptPoints;
    if (cap <= 0) return;
    const list = (this.pins.get(threadId) ?? []).filter((p) => !(p.ns === ns && p.checkpointId === checkpointId));
    list.push({ ns, checkpointId, pinnedAt, reason });
    const byNs = new Map<string, PinRec[]>();
    for (const pin of list) {
      const arr = byNs.get(pin.ns) ?? [];
      arr.push(pin);
      byNs.set(pin.ns, arr);
    }
    const next: PinRec[] = [];
    for (const arr of byNs.values()) {
      arr.sort((a, b) => b.pinnedAt - a.pinnedAt);
      next.push(...arr.slice(0, cap));
    }
    this.pins.set(threadId, next);
  }

  private pinHead(threadId: string, now: number): void {
    const namespaces = this.storage[threadId] ?? {};
    for (const ns of Object.keys(namespaces)) {
      const ids = Object.keys(namespaces[ns] ?? {}).sort((a, b) => b.localeCompare(a));
      const head = ids[0];
      if (head) this.addPin(threadId, ns, head, "paused", now);
    }
  }

  private compactWrites(threadId: string, ns: string): void {
    const bucket = this.storage[threadId]?.[ns];
    if (!bucket) return;
    const parents = new Set<string>();
    for (const id of Object.keys(bucket)) {
      const parent = bucket[id]?.[2];
      if (typeof parent === "string") parents.add(parent);
    }
    const pins = new Set(
      (this.pins.get(threadId) ?? []).filter((pin) => pin.ns === ns).map((pin) => pin.checkpointId),
    );
    for (const key of Object.keys(this.writes)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(key);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed) || parsed[0] !== threadId || parsed[1] !== ns) continue;
      const id = String(parsed[2]);
      // Writes can be stored before their checkpoint row is visible: LangGraph
      // assigns the next checkpoint id and flushes writes before the chained
      // put lands. Those writes belong to the upcoming leaf. Only drop writes
      // for a checkpoint that is already stored and has a successor.
      if (bucket[id] && parents.has(id) && !pins.has(id)) delete this.writes[key];
    }
  }

  /** Omit a large channel value once an earlier checkpoint already stored that version. */
  private async externalizeRepeats(
    threadId: string,
    ns: string,
    checkpoint: Checkpoint,
    parentId: string | undefined,
    newVersions: ChannelVersions | undefined,
  ): Promise<void> {
    void newVersions;
    const values = checkpoint.channel_values ?? {};
    const versions = checkpoint.channel_versions ?? {};
    const parent = parentId ? this.storage[threadId]?.[ns]?.[parentId] : undefined;
    let parentVersions: Record<string, unknown> | undefined;
    if (parent) {
      try {
        const loaded = (await this.serde.loadsTyped("json", parent[0])) as Checkpoint;
        parentVersions = loaded.channel_versions ?? {};
      } catch {
        parentVersions = undefined;
      }
    }
    for (const channel of Object.keys(values)) {
      const version = versions[channel];
      if (version === undefined) continue;
      const verKey = String(version);
      const [type, bytes] = await this.serde.dumpsTyped(values[channel]);
      if (bytes.byteLength <= CHECKPOINT_INLINE_MAX_BYTES) continue;
      const channelBlobs = (this.blobs[threadId] ??= blank());
      const nsBlobs = (channelBlobs[ns] ??= blank());
      const versionsForChannel = (nsBlobs[channel] ??= blank());
      const repeated = parentVersions !== undefined && String(parentVersions[channel]) === verKey;
      if (!versionsForChannel[verKey] && !repeated) continue;
      if (!versionsForChannel[verKey]) versionsForChannel[verKey] = { type, value: bytes };
      delete checkpoint.channel_values[channel];
    }
  }

  private async rehydrate(tuple: CheckpointTuple): Promise<void> {
    const threadId = tuple.config.configurable?.thread_id;
    const ns = tuple.config.configurable?.checkpoint_ns ?? "";
    if (typeof threadId !== "string") return;
    const checkpoint = tuple.checkpoint;
    checkpoint.channel_values ??= {};
    const versions = checkpoint.channel_versions ?? {};
    const nsBlobs = this.blobs[threadId]?.[ns];
    if (!nsBlobs) return;
    for (const channel of Object.keys(versions)) {
      if (Object.prototype.hasOwnProperty.call(checkpoint.channel_values, channel)) continue;
      const blob = nsBlobs[channel]?.[String(versions[channel])];
      if (!blob) continue;
      checkpoint.channel_values[channel] = await this.serde.loadsTyped(blob.type, blob.value);
    }
  }

  private async pruneNamespace(threadId: string, ns: string, policy: ResolvedCheckpointRetention): Promise<void> {
    const bucket = this.storage[threadId]?.[ns];
    if (!bucket) return;
    const ids = Object.keys(bucket).sort((a, b) => b.localeCompare(a));
    const parentOf = new Map(ids.map((id) => [id, bucket[id]?.[2]]));
    const interruptIds: string[] = [];
    for (const id of ids) {
      const writes = this.writes[writeKey(threadId, ns, id)];
      if (!writes) continue;
      if (Object.values(writes).some((entry) => CHECKPOINT_PIN_CHANNELS.has(entry[1]))) interruptIds.push(id);
    }
    const explicit = (this.pins.get(threadId) ?? [])
      .filter((pin) => pin.ns === ns)
      .sort((a, b) => b.pinnedAt - a.pinnedAt)
      .map((pin) => pin.checkpointId);
    const keep = selectRetainedCheckpointIds({
      idsNewestFirst: ids,
      parentOf,
      maxCheckpoints: policy.maxCheckpoints,
      interruptIds,
      explicitPinsNewestFirst: explicit,
      maxInterruptPoints: policy.maxInterruptPoints,
    });
    for (const id of ids) {
      if (keep.has(id)) continue;
      delete bucket[id];
      delete this.writes[writeKey(threadId, ns, id)];
    }
    await this.gcBlobs(threadId, ns, bucket);
    const pins = this.pins.get(threadId);
    if (pins) this.pins.set(threadId, pins.filter((pin) => pin.ns !== ns || keep.has(pin.checkpointId)));
  }

  private async gcBlobs(
    threadId: string,
    ns: string,
    bucket: Record<string, [Uint8Array, Uint8Array, string | undefined]>,
  ): Promise<void> {
    const nsBlobs = this.blobs[threadId]?.[ns];
    if (!nsBlobs) return;
    const referenced = new Set<string>();
    for (const id of Object.keys(bucket)) {
      const raw = bucket[id]?.[0];
      if (!raw) continue;
      const checkpoint = (await this.serde.loadsTyped("json", raw)) as Checkpoint;
      for (const [channel, version] of Object.entries(checkpoint.channel_versions ?? {})) {
        referenced.add(`${channel}\0${String(version)}`);
      }
    }
    for (const channel of Object.keys(nsBlobs)) {
      const versions = nsBlobs[channel] ?? {};
      for (const ver of Object.keys(versions)) {
        if (!referenced.has(`${channel}\0${ver}`)) delete versions[ver];
      }
      if (Object.keys(versions).length === 0) delete nsBlobs[channel];
    }
  }
}

function isResolved(
  value: boolean | CheckpointRetentionInput | ResolvedCheckpointRetention | null | undefined,
): value is ResolvedCheckpointRetention {
  return !!value && typeof value === "object" && "finishedTtlMs" in value && "maxCheckpoints" in value;
}
