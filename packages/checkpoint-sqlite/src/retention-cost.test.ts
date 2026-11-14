import { expect, it, vi } from "vitest";
import { resolveCheckpointRetention } from "@flowgraph/core";
import { openDatabase } from "./memory.js";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { FlowgraphSqliteSaver } from "./retention.js";

it("prunes using version metadata without deserializing the retained window", async () => {
  const db = openDatabase(":memory:");
  const saver = new FlowgraphSqliteSaver(db, resolveCheckpointRetention({ maxCheckpoints: 100 }));
  const put = async (n: number) => saver.put(
    { configurable: { thread_id: "cost", checkpoint_ns: "", ...(n ? { checkpoint_id: String(n - 1).padStart(4, "0") } : {}) } },
    { v: 4, id: String(n).padStart(4, "0"), ts: new Date().toISOString(), channel_values: { log: "x".repeat(1024 * n) }, channel_versions: { log: n }, versions_seen: {} },
    { source: "loop", step: n, parents: {} },
    { log: n },
  );
  try {
    for (let n = 0; n < 105; n++) await put(n);
    const loads = vi.spyOn(saver.serde, "loadsTyped");
    await put(105);
    // A parent read is allowed; scanning 100 large serialized checkpoints is not.
    expect(loads.mock.calls.length).toBeLessThanOrEqual(1);
    expect((await saver.getTuple({ configurable: { thread_id: "cost" } }))?.checkpoint.channel_values.log).toHaveLength(105 * 1024);
  } finally { db.close(); }
});

it("backfills retained legacy rows once and preserves their deduplicated blobs", async () => {
  const db = openDatabase(":memory:");
  const saver = new FlowgraphSqliteSaver(db, resolveCheckpointRetention({ maxCheckpoints: 3 }));
  const put = (n: number) => saver.put(
    { configurable: { thread_id: "legacy", checkpoint_ns: "", ...(n ? { checkpoint_id: String(n - 1) } : {}) } },
    { v: 4, id: String(n), ts: new Date().toISOString(), channel_values: { pad: "x".repeat(8192), n }, channel_versions: { pad: 1, n }, versions_seen: {} },
    { source: "loop", step: n, parents: {} }, { n },
  );
  try {
    for (let n = 0; n < 5; n++) await put(n);
    db.prepare("UPDATE checkpoints SET fg_channel_versions = NULL").run();
    const loads = vi.spyOn(saver.serde, "loadsTyped");
    await put(5);
    expect(loads.mock.calls.length).toBeGreaterThan(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE fg_channel_versions IS NULL").get()).toEqual({ n: 0 });
    loads.mockClear();
    await put(6);
    expect(loads.mock.calls.length).toBe(0);
    expect((await saver.getTuple({ configurable: { thread_id: "legacy" } }))?.checkpoint.channel_values.pad).toBe("x".repeat(8192));
  } finally { db.close(); }
});

it("keeps blobs while a concurrent raw checkpoint has unpublished reference metadata", async () => {
  const db = openDatabase(":memory:");
  const saver = new FlowgraphSqliteSaver(db, resolveCheckpointRetention({ maxCheckpoints: 2, dedupeChannels: false }));
  const raw = new SqliteSaver(db as never);
  const put = (n: number) => saver.put(
    { configurable: { thread_id: "race", checkpoint_ns: "", ...(n ? { checkpoint_id: String(n - 1) } : {}) } },
    { v: 4, id: String(n), ts: new Date().toISOString(), channel_values: { n }, channel_versions: { n }, versions_seen: {} },
    { source: "loop", step: n, parents: {} }, { n },
  );
  try {
    for (let n = 0; n < 5; n++) await put(n);
    db.prepare("UPDATE checkpoints SET fg_channel_versions = NULL WHERE checkpoint_id='4'").run();
    const inner = saver.serde.loadsTyped.bind(saver.serde);
    vi.spyOn(saver.serde, "loadsTyped").mockImplementationOnce(async (type, bytes) => {
      await raw.put({ configurable: { thread_id: "race", checkpoint_ns: "", checkpoint_id: "4" } },
        { v: 4, id: "9", ts: new Date().toISOString(), channel_values: {}, channel_versions: { pad: "future" }, versions_seen: {} },
        { source: "loop", step: 9, parents: {} });
      const [blobType, value] = await saver.serde.dumpsTyped("future blob");
      db.prepare("INSERT INTO fg_checkpoint_blobs (thread_id, checkpoint_ns, channel, version, type, value) VALUES ('race', '', 'pad', 'future', ?, ?)").run(blobType, Buffer.from(value));
      return inner(type, bytes);
    });
    await put(5);
    expect(db.prepare("SELECT fg_channel_versions FROM checkpoints WHERE checkpoint_id='9'").get()).toEqual({ fg_channel_versions: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM fg_checkpoint_blobs WHERE channel='pad'").get()).toEqual({ n: 1 });
    expect((await saver.getTuple({ configurable: { thread_id: "race", checkpoint_id: "9" } }))?.checkpoint.channel_values.pad).toBe("future blob");
    await put(6);
    await put(7); // The next actual prune backfills the new branch; its blob remains referenced.
    expect(db.prepare("SELECT fg_channel_versions FROM checkpoints WHERE checkpoint_id='9'").get()).toEqual({ fg_channel_versions: '{"pad":"future"}' });
  } finally { db.close(); }
});

it.each([false, true])("preserves large numeric version keys (legacy metadata=%s)", async legacy => {
  const db = openDatabase(":memory:");
  const saver = new FlowgraphSqliteSaver(db, resolveCheckpointRetention({ maxCheckpoints: 2 }));
  const put = (n: number) => saver.put(
    { configurable: { thread_id: "numeric", checkpoint_ns: "", ...(n ? { checkpoint_id: String(n - 1) } : {}) } },
    { v: 4, id: String(n), ts: new Date().toISOString(), channel_values: { pad: "x".repeat(8192), n }, channel_versions: { pad: 1e21, n }, versions_seen: {} },
    { source: "loop", step: n, parents: {} }, { n },
  );
  try {
    for (let n = 0; n < 4; n++) await put(n);
    if (legacy) db.prepare("UPDATE checkpoints SET fg_channel_versions = NULL").run();
    await put(4);
    expect((await saver.getTuple({ configurable: { thread_id: "numeric" } }))?.checkpoint.channel_values.pad).toBe("x".repeat(8192));
  } finally { db.close(); }
});
