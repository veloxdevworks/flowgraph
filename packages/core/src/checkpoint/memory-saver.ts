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
  CHECKPOINT_PIN_CHANNELS,
  selectRetainedCheckpointIds,
  resolveCheckpointRetention,
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

  constructor(
    retention?: boolean | CheckpointRetentionInput | ResolvedCheckpointRetention | null,
    serde?: ConstructorParameters<typeof MemorySaver>[0],
  ) {
    super(serde);
    this.retention = isResolved(retention) ? retention : resolveCheckpointRetention(retention ?? undefined);
  }

  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const tuple = await super.getTuple(config);
    if (tuple && this.retention.enabled && this.retention.dedupeChannels) await this.rehydrate(tuple);
    return tuple;
  }

  override async *list(
    config: RunnableConfig,
    options?: Parameters<MemorySaver["list"]>[1],
  ): AsyncGenerator<CheckpointTuple> {
    for await (const tuple of super.list(config, options)) {
      if (this.retention.enabled && this.retention.dedupeChannels) await this.rehydrate(tuple);
      yield tuple;
    }
  }

  override async getDeltaChannelHistory(
    options: Parameters<BaseCheckpointSaver["getDeltaChannelHistory"]>[0],
  ): Promise<Awaited<ReturnType<BaseCheckpointSaver["getDeltaChannelHistory"]>>> {
    // Stored checkpoints omit channel values when deduping. The base walk
    // loads them through getTuple; MemorySaver's own walk reads the raw rows.
    if (this.retention.enabled && this.retention.dedupeChannels) {
      return BaseCheckpointSaver.prototype.getDeltaChannelHistory.call(this, options);
    }
    return super.getDeltaChannelHistory(options);
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions?: ChannelVersions,
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id;
    const ns = config.configurable?.checkpoint_ns ?? "";
    let stored: Checkpoint = checkpoint;
    if (this.retention.enabled && this.retention.dedupeChannels && typeof threadId === "string") {
      stored = copyCheckpoint(checkpoint);
      await this.writeBlobs(threadId, ns, checkpoint, newVersions);
      stored.channel_values = {};
    }
    const result = await super.put(config, stored, metadata);
    if (this.retention.enabled && typeof threadId === "string") {
      this.touch(threadId, "active", Date.now());
      await this.pruneNamespace(threadId, ns);
    }
    return result;
  }

  override async putWrites(
    config: RunnableConfig,
    writes: Parameters<MemorySaver["putWrites"]>[1],
    taskId: string,
  ): Promise<void> {
    await super.putWrites(config, writes, taskId);
    if (!this.retention.enabled) return;
    const hit = writes.find(([channel]) => CHECKPOINT_PIN_CHANNELS.has(channel));
    const threadId = config.configurable?.thread_id;
    const checkpointId = config.configurable?.checkpoint_id;
    if (!hit || typeof threadId !== "string" || typeof checkpointId !== "string") return;
    this.addPin(threadId, config.configurable?.checkpoint_ns ?? "", checkpointId, hit[0], Date.now());
  }

  override async deleteThread(threadId: string): Promise<void> {
    delete this.blobs[threadId];
    this.threads.delete(threadId);
    this.pins.delete(threadId);
    await super.deleteThread(threadId);
  }

  async noteThreadStatus(threadId: string, status: CheckpointThreadStatus, now = Date.now()): Promise<void> {
    if (!this.retention.enabled) return;
    if (status === "paused") this.pinHead(threadId, now);
    this.touch(threadId, status, now);
    if (status === "finished") await this.sweep(now);
  }

  async sweep(now = Date.now()): Promise<void> {
    if (!this.retention.enabled) return;
    const ttl = this.retention.finishedTtlMs;
    if (ttl !== null) {
      for (const [threadId, row] of [...this.threads]) {
        if (row.status === "paused") continue;
        if (now - row.updatedAt < ttl) continue;
        if (row.status === "active" && this.headIsPinned(threadId)) {
          this.touch(threadId, "paused", row.updatedAt);
          continue;
        }
        await this.deleteThread(threadId);
      }
    }
    const cap = this.retention.maxFinishedThreads;
    if (cap === null) return;
    const finished = [...this.threads.entries()]
      .filter(([, row]) => row.status === "finished")
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt || (a[0] < b[0] ? -1 : 1));
    while (finished.length > cap) {
      const next = finished.shift();
      if (!next) break;
      await this.deleteThread(next[0]);
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

  private touch(threadId: string, status: CheckpointThreadStatus, updatedAt: number): void {
    this.threads.set(threadId, { status, updatedAt });
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

  private headIsPinned(threadId: string): boolean {
    const namespaces = this.storage[threadId] ?? {};
    for (const ns of Object.keys(namespaces)) {
      const ids = Object.keys(namespaces[ns] ?? {}).sort((a, b) => b.localeCompare(a));
      const head = ids[0];
      if (!head) continue;
      const writes = this.writes[writeKey(threadId, ns, head)];
      if (writes && Object.values(writes).some((entry) => CHECKPOINT_PIN_CHANNELS.has(entry[1]))) return true;
      if ((this.pins.get(threadId) ?? []).some((p) => p.ns === ns && p.checkpointId === head)) return true;
    }
    return false;
  }

  private async writeBlobs(
    threadId: string,
    ns: string,
    checkpoint: Checkpoint,
    newVersions: ChannelVersions | undefined,
  ): Promise<void> {
    void newVersions;
    const values = checkpoint.channel_values ?? {};
    const versions = checkpoint.channel_versions ?? {};
    const threadBlobs = (this.blobs[threadId] ??= blank());
    const nsBlobs = (threadBlobs[ns] ??= blank());
    for (const channel of Object.keys(values)) {
      const version = versions[channel];
      if (version === undefined) continue;
      const verKey = String(version);
      const channelBlobs = (nsBlobs[channel] ??= blank());
      // Same version means the channel did not change. Store the bytes once.
      if (channelBlobs[verKey]) continue;
      const [type, bytes] = await this.serde.dumpsTyped(values[channel]);
      channelBlobs[verKey] = { type, value: bytes };
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

  private async pruneNamespace(threadId: string, ns: string): Promise<void> {
    const bucket = this.storage[threadId]?.[ns];
    if (!bucket) return;
    const ids = Object.keys(bucket).sort((a, b) => b.localeCompare(a));
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
      maxCheckpoints: this.retention.maxCheckpoints,
      interruptIds,
      explicitPinsNewestFirst: explicit,
      maxInterruptPoints: this.retention.maxInterruptPoints,
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
