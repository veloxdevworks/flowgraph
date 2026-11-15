/** Content-addressed, content-defined chunks. Owner rows and references commit atomically. */
import { createHash } from "node:crypto";
import type { SqliteDatabase } from "./memory.js";
export const CHUNK_TYPE = "fg-chunks-v1:";
const FRAME = "FGCH1:";
const MIN = 1024,
  MAX = 8192,
  INLINE = 4096;
const digest = (kind: string, data: Uint8Array) =>
  createHash("sha256").update(kind).update(data).digest("hex");
const gear = Array.from({ length: 256 }, (_, i) => {
  let n = i + 1;
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return (n ^ (n >>> 16)) >>> 0;
});
export const CHUNK_MIGRATION =
  `
CREATE TABLE fg_checkpoint_chunks (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data BLOB NOT NULL, refs INTEGER NOT NULL DEFAULT 0 CHECK(refs >= 0)) WITHOUT ROWID;
CREATE INDEX fg_checkpoint_chunks_unused ON fg_checkpoint_chunks(refs) WHERE refs=0;
CREATE TABLE fg_checkpoint_chunk_links (parent TEXT NOT NULL, child TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(parent,child)) WITHOUT ROWID;
CREATE TABLE fg_checkpoint_chunk_owners (kind TEXT NOT NULL, owner TEXT NOT NULL, root TEXT NOT NULL, PRIMARY KEY(kind,owner)) WITHOUT ROWID;
CREATE TRIGGER fg_chunk_owner_add AFTER INSERT ON fg_checkpoint_chunk_owners BEGIN UPDATE fg_checkpoint_chunks SET refs=refs+1 WHERE id=NEW.root; END;
CREATE TRIGGER fg_chunk_owner_remove AFTER DELETE ON fg_checkpoint_chunk_owners BEGIN UPDATE fg_checkpoint_chunks SET refs=refs-1 WHERE id=OLD.root; END;
CREATE TRIGGER fg_chunk_link_add AFTER INSERT ON fg_checkpoint_chunk_links BEGIN UPDATE fg_checkpoint_chunks SET refs=refs+NEW.n WHERE id=NEW.child; END;
CREATE TRIGGER fg_chunk_link_remove AFTER DELETE ON fg_checkpoint_chunk_links BEGIN UPDATE fg_checkpoint_chunks SET refs=refs-OLD.n WHERE id=OLD.child; END;
` +
  [
    [
      "checkpoints",
      "checkpoint",
      "checkpoint",
      "json_array(OLD.thread_id,OLD.checkpoint_ns,OLD.checkpoint_id)",
    ],
    [
      "writes",
      "write",
      "value",
      "json_array(OLD.thread_id,OLD.checkpoint_ns,OLD.checkpoint_id,OLD.task_id,OLD.idx)",
    ],
    [
      "fg_checkpoint_blobs",
      "blob",
      "value",
      "json_array(OLD.thread_id,OLD.checkpoint_ns,OLD.channel,OLD.version)",
    ],
  ]
    .map(
      ([table, kind, column, owner]) => `
CREATE TRIGGER fg_chunk_${kind}_delete AFTER DELETE ON ${table} BEGIN DELETE FROM fg_checkpoint_chunk_owners WHERE kind='${kind}' AND owner=${owner}; END;
CREATE TRIGGER fg_chunk_${kind}_update AFTER UPDATE OF ${column} ON ${table} BEGIN DELETE FROM fg_checkpoint_chunk_owners WHERE kind='${kind}' AND owner=${owner}; END;
`,
    )
    .join("");
export type Packed = { data: Buffer; root?: string };
const corrupt = (why: string) =>
  Object.assign(new Error(`Checkpoint chunks are corrupt: ${why}`), {
    code: "CHECKPOINT_CHUNK_CORRUPT",
    retryable: false,
  });
export class CheckpointChunks {
  constructor(private readonly db: SqliteDatabase) {}
  private node(kind: "L" | "B", data: Buffer, children: string[] = []): string {
    const id = digest(kind, data);
    const result = this.db
      .prepare("INSERT OR IGNORE INTO fg_checkpoint_chunks(id,kind,data) VALUES(?,?,?)")
      .run(id, kind, data);
    if (result.changes && children.length) {
      const counts = new Map<string, number>();
      for (const child of children) counts.set(child, (counts.get(child) ?? 0) + 1);
      const insert = this.db.prepare(
        "INSERT INTO fg_checkpoint_chunk_links(parent,child,n) VALUES(?,?,?)",
      );
      for (const [child, n] of counts) insert.run(id, child, n);
    }
    return id;
  }
  /** Must run inside the transaction that inserts the owning checkpoint/write/blob. */
  pack(bytes: Uint8Array): Packed {
    const data = Buffer.from(bytes);
    if (data.byteLength <= INLINE) return { data };
    let ids: string[] = [],
      start = 0,
      rolling = 0;
    for (let i = 0; i < data.length; i++) {
      rolling = ((rolling << 1) + gear[data[i]!]!) >>> 0;
      const size = i + 1 - start;
      if (size >= MAX || (size >= MIN && (rolling & 2047) === 0)) {
        ids.push(this.node("L", data.subarray(start, i + 1)));
        start = i + 1;
        rolling = 0;
      }
    }
    if (start < data.length) ids.push(this.node("L", data.subarray(start)));
    while (ids.length > 1) {
      const next: string[] = [];
      let group: string[] = [];
      for (const id of ids) {
        group.push(id);
        // Hash anchors stabilize branch boundaries after insertions/prepends as well as appends.
        if (
          group.length >= 32 ||
          (group.length >= 4 && (parseInt(id.slice(0, 8), 16) & 15) === 0)
        ) {
          next.push(this.node("B", Buffer.from(JSON.stringify(group)), group));
          group = [];
        }
      }
      if (group.length) next.push(this.node("B", Buffer.from(JSON.stringify(group)), group));
      ids = next;
    }
    const root = ids[0]!;
    return { root, data: Buffer.from(`${FRAME}${root}:${data.byteLength}`) };
  }
  attach(kind: string, owner: unknown[], packed: Packed): void {
    const key = JSON.stringify(owner);
    this.db
      .prepare("DELETE FROM fg_checkpoint_chunk_owners WHERE kind=? AND owner=?")
      .run(kind, key);
    if (packed.root)
      this.db
        .prepare("INSERT INTO fg_checkpoint_chunk_owners(kind,owner,root) VALUES(?,?,?)")
        .run(kind, key, packed.root);
  }
  unpack(data: Uint8Array | string): Uint8Array | string {
    const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    const match = /^FGCH1:([a-f0-9]{64}):([1-9][0-9]*)$/.exec(bytes.toString("utf8"));
    if (!match) {
      if (bytes.subarray(0, FRAME.length).toString() === FRAME)
        throw corrupt("invalid reference frame");
      return data;
    }
    const expected = Number(match[2]);
    if (!Number.isSafeInteger(expected) || expected > 2 ** 31 - 1)
      throw corrupt("invalid serialized size");
    const parts: Buffer[] = [];
    let length = 0;
    const ancestors = new Set<string>();
    const read = this.db.prepare("SELECT kind,data FROM fg_checkpoint_chunks WHERE id=?");
    const walk = (id: string, depth: number): void => {
      if (depth > 64 || ancestors.has(id)) throw corrupt("cyclic or excessive chunk nesting");
      const node = read.get(id) as { kind: string; data: Uint8Array } | undefined;
      if (!node || !["L", "B"].includes(node.kind) || digest(node.kind, node.data) !== id)
        throw corrupt("missing or invalid chunk");
      if (node.kind === "L") {
        if (node.data.byteLength > MAX) throw corrupt("oversized leaf");
        length += node.data.byteLength;
        if (length > expected) throw corrupt("serialized size mismatch");
        parts.push(Buffer.from(node.data));
        return;
      }
      let children: unknown;
      try {
        children = JSON.parse(Buffer.from(node.data).toString());
      } catch {
        throw corrupt("invalid branch");
      }
      if (
        !Array.isArray(children) ||
        children.length < 1 ||
        children.length > 32 ||
        children.some((x) => typeof x !== "string" || !/^[a-f0-9]{64}$/.test(x))
      )
        throw corrupt("invalid branch references");
      ancestors.add(id);
      for (const child of children as string[]) walk(child, depth + 1);
      ancestors.delete(id);
    };
    walk(match[1]!, 0);
    if (length !== expected) throw corrupt("serialized size mismatch");
    return Buffer.concat(parts, length);
  }
  /** Indexed reference-count GC; no scan/deserialization of retained history. */
  collect(): number {
    return this.db.transaction(() => {
      let count = 0;
      const read = this.db.prepare("SELECT id FROM fg_checkpoint_chunks WHERE refs=0 LIMIT 128");
      const links = this.db.prepare("DELETE FROM fg_checkpoint_chunk_links WHERE parent=?");
      const remove = this.db.prepare("DELETE FROM fg_checkpoint_chunks WHERE id=? AND refs=0");
      while (true) {
        const rows = read.all() as { id: string }[];
        if (!rows.length) return count;
        for (const { id } of rows) {
          links.run(id);
          count += remove.run(id).changes;
        }
      }
    })();
  }
}
