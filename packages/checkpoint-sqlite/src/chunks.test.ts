import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { openSqliteBackend } from "./index.js";
import { openDatabase } from "./memory.js";
const checkpoint = (id = "1", log = "abc".repeat(10000)) => ({
  v: 4,
  id,
  ts: "2026-01-01T00:00:00Z",
  channel_values: { log },
  channel_versions: { log: id },
  versions_seen: {},
});
const config = (thread_id = "one", checkpoint_id = "1") => ({
  configurable: { thread_id, checkpoint_ns: "", checkpoint_id },
});
const metadata = { source: "loop" as const, step: 1, parents: {} };
it("preserves shared chunks across threads/reopen and collects them on final deletion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fg-chunks-"));
  let backend = await openSqliteBackend({ path: join(dir, "state.db"), retention: false });
  try {
    for (const thread of ["one", "two"]) {
      await backend.checkpointer.put(config(thread), checkpoint(), metadata, {});
      await backend.checkpointer.putWrites(config(thread), [["log", "abc".repeat(10000)]], "task");
    }
    const count = () =>
      (backend.db.prepare("SELECT COUNT(*) AS n FROM fg_checkpoint_chunks").get() as { n: number })
        .n;
    const before = count();
    expect(before).toBeGreaterThan(0);
    await backend.checkpointer.deleteThread("one");
    expect(count()).toBe(before);
    backend.close();
    backend = await openSqliteBackend({ path: join(dir, "state.db"), retention: false });
    expect(
      (await backend.checkpointer.getTuple(config("two")))?.checkpoint.channel_values.log,
    ).toBe("abc".repeat(10000));
    expect((await backend.checkpointer.getTuple(config("two")))?.pendingWrites?.[0]?.[2]).toBe(
      "abc".repeat(10000),
    );
    // JSON metadata filtering continues to work: metadata is kept queryable.
    const filtered = [];
    for await (const tuple of backend.checkpointer.list(config("two"), {
      filter: { source: "loop" },
    }))
      filtered.push(tuple);
    expect(filtered).toHaveLength(1);
    await backend.checkpointer.deleteThread("two");
    expect(count()).toBe(0);
    expect(
      backend.db.prepare("SELECT COUNT(*) AS n FROM fg_checkpoint_chunk_owners").get(),
    ).toEqual({ n: 0 });
    expect(backend.db.prepare("SELECT COUNT(*) AS n FROM fg_checkpoint_chunk_links").get()).toEqual(
      { n: 0 },
    );
  } finally {
    backend.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it("fails closed on corrupt/missing chunk data", async () => {
  const backend = await openSqliteBackend({ path: ":memory:", retention: false });
  try {
    await backend.checkpointer.put(config(), checkpoint(), metadata, {});
    backend.db
      .prepare("UPDATE fg_checkpoint_chunks SET data=? WHERE kind='L'")
      .run(Buffer.from("corrupt"));
    await expect(backend.checkpointer.getTuple(config())).rejects.toMatchObject({
      code: "CHECKPOINT_CHUNK_CORRUPT",
    });
    backend.db.prepare("DELETE FROM fg_checkpoint_chunks WHERE kind='L'").run();
    await expect(backend.checkpointer.getTuple(config())).rejects.toMatchObject({
      code: "CHECKPOINT_CHUNK_CORRUPT",
    });
  } finally {
    backend.close();
  }
});
it("rolls back chunks with a failed owner write and preserves INSERT IGNORE write semantics", async () => {
  const backend = await openSqliteBackend({ path: ":memory:", retention: false });
  try {
    backend.db.exec(
      "CREATE TRIGGER fail_owner BEFORE INSERT ON checkpoints BEGIN SELECT RAISE(ABORT, 'test write failure'); END;",
    );
    await expect(backend.checkpointer.put(config(), checkpoint(), metadata, {})).rejects.toThrow(
      "test write failure",
    );
    expect(backend.db.prepare("SELECT COUNT(*) AS n FROM fg_checkpoint_chunks").get()).toEqual({
      n: 0,
    });
    backend.db.exec("DROP TRIGGER fail_owner");
    await backend.checkpointer.put(config(), checkpoint(), metadata, {});
    await backend.checkpointer.putWrites(config(), [["log", "first".repeat(2000)]], "task");
    await backend.checkpointer.putWrites(config(), [["log", "second".repeat(2000)]], "task");
    expect((await backend.checkpointer.getTuple(config()))?.pendingWrites?.[0]?.[2]).toBe(
      "first".repeat(2000),
    );
    expect(
      backend.db.prepare("SELECT COUNT(*) AS n FROM fg_checkpoint_chunks WHERE refs=0").get(),
    ).toEqual({ n: 0 });
    await backend.checkpointer.putWrites(
      config(),
      [["__error__", { message: "a".repeat(6000) }]],
      "error",
    );
    await backend.checkpointer.putWrites(
      config(),
      [["__error__", { message: "b".repeat(6000) }]],
      "error",
    );
    const errors = (await backend.checkpointer.getTuple(config()))?.pendingWrites?.filter(
      (w) => w[1] === "__error__",
    );
    expect(errors).toHaveLength(1);
    expect(errors?.[0]?.[2]).toEqual({ message: "b".repeat(6000) });
  } finally {
    backend.close();
  }
});
it("reads legacy unchunked data and keeps a second connection's live roots during pruning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fg-chunk-race-"));
  const file = join(dir, "state.db");
  const db = openDatabase(file);
  const legacy = new SqliteSaver(db as never);
  await legacy.put(config(), checkpoint(), metadata);
  db.close();
  const first = await openSqliteBackend({ path: file, retention: { maxCheckpoints: 1 } });
  const second = await openSqliteBackend({ path: file, retention: false });
  try {
    expect((await first.checkpointer.getTuple(config()))?.checkpoint.channel_values.log).toBe(
      "abc".repeat(10000),
    );
    await second.checkpointer.put(config("other"), checkpoint(), metadata, {});
    for (let n = 2; n < 8; n++)
      await first.checkpointer.put(
        config("one", String(n - 1)),
        checkpoint(String(n)),
        { ...metadata, step: n },
        { log: n },
      );
    await first.checkpointer.deleteThread("one");
    expect(
      (await second.checkpointer.getTuple(config("other")))?.checkpoint.channel_values.log,
    ).toBe("abc".repeat(10000));
  } finally {
    first.close();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
