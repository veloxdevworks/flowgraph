/**
 * Shared conformance suite for scoped-memory backends.
 *
 *   import { describeMemoryBackendConformance } from "@flowgraph/testing/memory-conformance";
 *   describeMemoryBackendConformance("sqlite", async () => ({ backend: open(), cleanup }));
 *
 * Every backend (in-memory, sqlite, postgres) must pass the same cases so
 * scope isolation, atomic ops, CAS, op-id replay, limits and TTL behave the
 * same everywhere.
 */
import { describe, it, expect } from "vitest";
import {
  MEMORY_DEFAULT_LIMITS,
  MemoryError,
  createScopedMemory,
  defaultMemoryPolicy,
  memoryPositionalOpId,
  type MemoryBackend,
  type MemoryLimits,
  type MemoryOpSource,
  type MemoryTuple,
  type MemoryWriteOp,
} from "@flowgraph/core";

export interface MemoryBackendHarness {
  backend: MemoryBackend;
  cleanup?: () => void | Promise<void>;
  /** Close and reopen the same storage (durable backends only). */
  reopen?: () => Promise<MemoryBackend>;
}

const T = (o: Partial<MemoryTuple>): MemoryTuple => ({
  org: "acme",
  project: "",
  graph: "",
  usr: "",
  subjectType: "",
  subjectKey: "",
  ...o,
});

export const conformanceTuples = {
  org: T({}),
  project: T({ project: "github.com/acme/web" }),
  graphA: T({ project: "github.com/acme/web", graph: "a" }),
  graphB: T({ project: "github.com/acme/web", graph: "b" }),
  userA1: T({ project: "github.com/acme/web", graph: "a", usr: "u1@x" }),
  userA2: T({ project: "github.com/acme/web", graph: "a", usr: "u2@x" }),
  subject1: T({ project: "github.com/acme/web", subjectType: "incident", subjectKey: "inc-1" }),
  subject2: T({ project: "github.com/acme/web", subjectType: "incident", subjectKey: "inc-2" }),
};

function limits(over: Partial<MemoryLimits> = {}): MemoryLimits {
  return { ...MEMORY_DEFAULT_LIMITS, ...over };
}

function op(o: Partial<MemoryWriteOp> & Pick<MemoryWriteOp, "kind" | "tuple" | "key">): MemoryWriteOp {
  return { limits: limits(), ...o };
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err, `expected ${code}`).toBeInstanceOf(MemoryError);
  expect((err as MemoryError).code).toBe(code);
}

export function describeMemoryBackendConformance(
  name: string,
  open: () => Promise<MemoryBackendHarness>,
): void {
  const tu = conformanceTuples;
  const replayBinding = { org: "acme", project: "github.com/acme/web", graph: "a", user: "u1@x" };
  const attempt = (b: MemoryBackend, taskId = "task-replay", nodeId = "node") => {
    const source: MemoryOpSource = { threadId: "replay-thread", checkpointNs: "ns", taskId, nodeId };
    return { source, memory: createScopedMemory(b, replayBinding, defaultMemoryPolicy(), source) };
  };
  const withBackend = (fn: (b: MemoryBackend, h: MemoryBackendHarness) => Promise<void>) => async () => {
    const h = await open();
    try {
      await fn(h.backend, h);
    } finally {
      await h.cleanup?.();
    }
  };

  describe(`memory backend conformance: ${name}`, () => {
    it("put/get round-trips JSON and bumps version", withBackend(async (b) => {
      const r1 = await b.write(op({ kind: "put", tuple: tu.graphA, key: "k", value: { a: [1, "x", null] } }));
      expect(r1).toMatchObject({ version: 1, deduped: false });
      const r2 = await b.write(op({ kind: "put", tuple: tu.graphA, key: "k", value: { a: 2 } }));
      expect(r2.version).toBe(2);
      const row = await b.get(tu.graphA, "k");
      expect(row?.value).toEqual({ a: 2 });
      expect(row?.version).toBe(2);
      expect(row?.bytes).toBe(Buffer.byteLength(JSON.stringify({ a: 2 })));
      expect(await b.get(tu.graphA, "missing")).toBeNull();
    }));

    it("isolates every scope tuple", withBackend(async (b) => {
      const all = Object.entries(tu);
      for (const [n, t] of all) await b.write(op({ kind: "put", tuple: t, key: "k", value: n }));
      for (const [n, t] of all) expect((await b.get(t, "k"))?.value).toBe(n);
      expect((await b.list(tu.graphB)).map((r) => r.value)).toEqual(["graphB"]);
    }));

    it("rejects malformed tuples", withBackend(async (b) => {
      await expectCode(b.write(op({ kind: "put", tuple: T({ graph: "g" }), key: "k", value: 1 })), "MEMORY_SCOPE_INVALID");
      await expectCode(b.write(op({ kind: "put", tuple: T({ project: "p", graph: "g", subjectType: "x", subjectKey: "y" }), key: "k", value: 1 })), "MEMORY_SCOPE_INVALID");
      await expectCode(b.write(op({ kind: "put", tuple: T({ project: "p", subjectType: "x" }), key: "k", value: 1 })), "MEMORY_SCOPE_INVALID");
      await expectCode(b.write(op({ kind: "put", tuple: T({ org: "" }), key: "k", value: 1 })), "MEMORY_SCOPE_INVALID");
      await expectCode(b.write(op({ kind: "put", tuple: tu.graphA, key: "", value: 1 })), "MEMORY_KEY_INVALID");
      await expectCode(b.write(op({ kind: "put", tuple: tu.graphA, key: "x".repeat(257), value: 1 })), "MEMORY_KEY_INVALID");
    }));

    it("patch merges, increment counts, append is bounded", withBackend(async (b) => {
      await b.write(op({ kind: "patch", tuple: tu.graphA, key: "p", value: { a: 1 } }));
      await b.write(op({ kind: "patch", tuple: tu.graphA, key: "p", value: { b: 2 } }));
      expect((await b.get(tu.graphA, "p"))?.value).toEqual({ a: 1, b: 2 });

      await b.write(op({ kind: "increment", tuple: tu.graphA, key: "c", field: "n" }));
      const r = await b.write(op({ kind: "increment", tuple: tu.graphA, key: "c", field: "n", by: 4 }));
      expect(r.value).toEqual({ n: 5 });
      await b.write(op({ kind: "increment", tuple: tu.graphA, key: "bare", field: "", by: 2 }));
      expect((await b.get(tu.graphA, "bare"))?.value).toBe(2);
      await expectCode(b.write(op({ kind: "increment", tuple: tu.graphA, key: "p", field: "a", by: Number.NaN })), "MEMORY_TYPE_MISMATCH");
      await expectCode(b.write(op({ kind: "patch", tuple: tu.graphA, key: "bare", value: { x: 1 } })), "MEMORY_TYPE_MISMATCH");

      for (let i = 0; i < 5; i++) await b.write(op({ kind: "append", tuple: tu.graphA, key: "l", value: i, max: 3 }));
      expect((await b.get(tu.graphA, "l"))?.value).toEqual([2, 3, 4]);
    }));

    it("many concurrent increments are not lost", withBackend(async (b) => {
      await Promise.all(
        Array.from({ length: 50 }, () => b.write(op({ kind: "increment", tuple: tu.project, key: "hits", field: "n" }))),
      );
      expect((await b.get(tu.project, "hits"))?.value).toEqual({ n: 50 });
    }));

    it("CAS: ifVersion conflicts and 0 means create-only", withBackend(async (b) => {
      const r = await b.write(op({ kind: "put", tuple: tu.graphA, key: "cas", value: 1, ifVersion: 0 }));
      expect(r.version).toBe(1);
      await expectCode(b.write(op({ kind: "put", tuple: tu.graphA, key: "cas", value: 2, ifVersion: 0 })), "MEMORY_VERSION_CONFLICT");
      await expectCode(b.write(op({ kind: "put", tuple: tu.graphA, key: "cas", value: 2, ifVersion: 7 })), "MEMORY_VERSION_CONFLICT");
      expect((await b.write(op({ kind: "put", tuple: tu.graphA, key: "cas", value: 2, ifVersion: 1 }))).version).toBe(2);
      await expectCode(b.write(op({ kind: "delete", tuple: tu.graphA, key: "cas", ifVersion: 1 })), "MEMORY_VERSION_CONFLICT");
      await b.write(op({ kind: "delete", tuple: tu.graphA, key: "cas", ifVersion: 2 }));
      expect(await b.get(tu.graphA, "cas")).toBeNull();
    }));

    it("replays of the same op id are no-ops", withBackend(async (b) => {
      const first = await b.write(op({ kind: "increment", tuple: tu.graphA, key: "r", field: "n", opId: "op-1" }));
      const again = await b.write(op({ kind: "increment", tuple: tu.graphA, key: "r", field: "n", opId: "op-1" }));
      expect(again).toMatchObject({ deduped: true, version: first.version, value: { n: 1 } });
      await b.write(op({ kind: "increment", tuple: tu.graphA, key: "r", field: "n", opId: "op-2" }));
      expect((await b.get(tu.graphA, "r"))?.value).toEqual({ n: 2 });
      // A failed write does not burn its op id.
      await expectCode(b.write(op({ kind: "put", tuple: tu.graphA, key: "r", value: 0, ifVersion: 99, opId: "op-3" })), "MEMORY_VERSION_CONFLICT");
      expect((await b.write(op({ kind: "put", tuple: tu.graphA, key: "r", value: 0, opId: "op-3" }))).deduped).toBe(false);
    }));

    it("enforces item size, attrs and secret rules", withBackend(async (b) => {
      await expectCode(b.write(op({ kind: "put", tuple: tu.graphA, key: "big", value: "x".repeat(9000) })), "MEMORY_VALUE_TOO_LARGE");
      await b.write(op({ kind: "put", tuple: tu.graphA, key: "big", value: "x".repeat(9000), limits: limits({ itemBytes: 65536 }) }));
      await expectCode(b.write(op({ kind: "put", tuple: tu.graphA, key: "s", value: { note: "api_key=abcdefghijklmnopqrstuvwxyz123" } })), "MEMORY_SECRET_DETECTED");
      await expectCode(b.write(op({ kind: "put", tuple: tu.graphA, key: "s", value: "Bearer abc.def.ghi" })), "MEMORY_SECRET_DETECTED");
      await b.write(op({ kind: "put", tuple: tu.graphA, key: "s", value: "Bearer abc.def.ghi", allowSecrets: true }));
      await expectCode(b.write(op({ kind: "put", tuple: tu.graphA, key: "a", value: 1, attrs: { nested: { x: 1 } } })), "MEMORY_ATTRS_INVALID");
      await expectCode(b.write(op({ kind: "put", tuple: tu.graphA, key: "a", value: 1, attrs: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, i])) })), "MEMORY_ATTRS_INVALID");
    }));

    it("rejects lone surrogates in keys, values, attrs, scopes and queries", withBackend(async (b) => {
      const LONE = "MEMORY_LONE_SURROGATE";
      for (const bad of ["a\uD83Db", "a\uDE00", "\uD83D"]) {
        await expectCode(b.write(op({ kind: "put", tuple: tu.graphA, key: bad, value: 1 })), LONE);
        await expectCode(b.write(op({ kind: "put", tuple: tu.graphA, key: "k", value: { deep: [bad] } })), LONE);
        await expectCode(b.write(op({ kind: "put", tuple: tu.graphA, key: "k", value: { [bad]: 1 } })), LONE);
        await expectCode(b.write(op({ kind: "put", tuple: tu.graphA, key: "k", value: 1, attrs: { tag: bad } })), LONE);
        await expectCode(b.write(op({ kind: "put", tuple: tu.graphA, key: "k", value: 1, opId: bad })), LONE);
        await expectCode(b.write(op({ kind: "put", tuple: { ...tu.subject1, subjectKey: bad }, key: "k", value: 1 })), LONE);
        await expectCode(b.get(tu.graphA, bad), LONE);
        await expectCode(b.list(tu.graphA, { attrs: { tag: bad } }), LONE);
      }
      expect(await b.list(tu.graphA)).toEqual([]);
      // Whole surrogate pairs (astral characters) are ordinary text.
      await b.write(op({ kind: "put", tuple: tu.graphA, key: "emoji-😀", value: { s: "😀 ok" }, attrs: { t: "𝄞" } }));
      const row = await b.get(tu.graphA, "emoji-😀");
      expect(row?.value).toEqual({ s: "😀 ok" });
      expect(row?.attrs).toEqual({ t: "𝄞" });
      expect(await b.list(tu.graphA, { attrs: { t: "𝄞" } })).toHaveLength(1);
    }));

    it("rejects NUL characters in keys, values, attrs, scopes and queries", withBackend(async (b) => {
      const nul = "a\u0000b";
      const NUL = "MEMORY_NUL_CHARACTER";
      await expectCode(b.write(op({ kind: "put", tuple: tu.graphA, key: nul, value: 1 })), NUL);
      await expectCode(b.write(op({ kind: "put", tuple: tu.graphA, key: "k", value: nul })), NUL);
      await expectCode(b.write(op({ kind: "put", tuple: tu.graphA, key: "k", value: { deep: [{ x: nul }] } })), NUL);
      await expectCode(b.write(op({ kind: "put", tuple: tu.graphA, key: "k", value: { [nul]: 1 } })), NUL);
      await expectCode(b.write(op({ kind: "put", tuple: tu.graphA, key: "k", value: 1, attrs: { tag: nul } })), NUL);
      await expectCode(b.write(op({ kind: "put", tuple: tu.graphA, key: "k", value: 1, attrs: { [nul]: 1 } })), NUL);
      await expectCode(b.write(op({ kind: "append", tuple: tu.graphA, key: "log", value: nul, max: 10 })), NUL);
      await expectCode(b.write(op({ kind: "patch", tuple: tu.graphA, key: "obj", value: { a: nul } })), NUL);
      await expectCode(b.write(op({ kind: "put", tuple: { ...tu.subject1, subjectKey: nul }, key: "k", value: 1 })), NUL);
      await expectCode(b.write(op({ kind: "put", tuple: tu.graphA, key: "k", value: 1, opId: nul })), NUL);
      await expectCode(b.write(op({ kind: "put", tuple: tu.graphA, key: "k", value: 1, writtenBy: nul })), NUL);
      await expectCode(b.write(op({ kind: "put", tuple: tu.graphA, key: "k", value: 1, writtenByRun: nul })), NUL);
      await expectCode(b.get(tu.graphA, nul), NUL);
      await expectCode(b.list(tu.graphA, { prefix: nul }), NUL);
      await expectCode(b.list(tu.graphA, { attrs: { tag: nul } }), NUL);
      await expectCode(b.similarSubjects({ org: "acme", project: tu.subject1.project, subjectType: "incident", prefix: nul, limit: 5, perSubject: 1 }), NUL);
      await expectCode(b.bindThread({ threadId: nul, org: "acme", project: "p", graph: "g", usr: "", subjectType: "", subjectKey: "" }), NUL);
      await expectCode(b.getThread(nul), NUL);
      expect(await b.list(tu.graphA)).toEqual([]);
      // The escaped text "\u0000" (backslash, u, digits) is ordinary data.
      await b.write(op({ kind: "put", tuple: tu.graphA, key: "k", value: { s: "\\u0000" }, attrs: { t: "\\u0000" } }));
      const row = await b.get(tu.graphA, "k");
      expect(row?.value).toEqual({ s: "\\u0000" });
      expect(row?.attrs).toEqual({ t: "\\u0000" });
    }));

    it("evicts oldest items when a graph/user/subject scope is full", withBackend(async (b) => {
      const l = limits({ itemsPerScope: 5 });
      let now = 1_000;
      for (let i = 0; i < 12; i++) {
        await b.write(op({ kind: "put", tuple: tu.graphA, key: `k${i}`, value: i, limits: l, now: now++ }));
      }
      const rows = await b.list(tu.graphA, { now });
      expect(rows.map((r) => r.key)).toEqual(["k11", "k10", "k9", "k8", "k7"]);
      // Bytes limit also evicts.
      const lb = limits({ bytesPerScope: 30 });
      for (let i = 0; i < 6; i++) {
        await b.write(op({ kind: "put", tuple: tu.userA1, key: `b${i}`, value: "123456789", limits: lb, now: now++ }));
      }
      const urows = await b.list(tu.userA1, { now });
      expect(urows.reduce((s, r) => s + r.bytes, 0)).toBeLessThanOrEqual(30);
      expect(urows[0]?.key).toBe("b5");
    }));

    it("rejects when full for org/project scopes or onFull: reject", withBackend(async (b) => {
      const l = limits({ itemsPerScope: 2 });
      await b.write(op({ kind: "put", tuple: tu.project, key: "a", value: 1, limits: l }));
      await b.write(op({ kind: "put", tuple: tu.project, key: "b", value: 1, limits: l }));
      await expectCode(b.write(op({ kind: "put", tuple: tu.project, key: "c", value: 1, limits: l })), "MEMORY_SCOPE_FULL");
      // Updating an existing key in a full scope is fine.
      await b.write(op({ kind: "put", tuple: tu.project, key: "a", value: 2, limits: l }));
      const lr = limits({ itemsPerScope: 1, onFull: "reject" });
      await b.write(op({ kind: "put", tuple: tu.graphB, key: "a", value: 1, limits: lr }));
      await expectCode(b.write(op({ kind: "put", tuple: tu.graphB, key: "b", value: 1, limits: lr })), "MEMORY_SCOPE_FULL");
      expect((await b.list(tu.graphB)).length).toBe(1);
    }));

    it("subject TTL slides on every write to the subject and hides expired rows", withBackend(async (b) => {
      const ttl = 1_000;
      await b.write(op({ kind: "put", tuple: tu.subject1, key: "a", value: 1, subjectTtlMs: ttl, now: 0 }));
      await b.write(op({ kind: "put", tuple: tu.subject1, key: "b", value: 2, subjectTtlMs: ttl, now: 800 }));
      // "a" was refreshed by the write to "b".
      expect((await b.get(tu.subject1, "a", 1_500))?.value).toBe(1);
      expect((await b.get(tu.subject1, "a", 1_500))?.expiresAt).toBe(1_800);
      expect(await b.get(tu.subject1, "a", 1_800)).toBeNull();
      expect(await b.list(tu.subject1, { now: 1_900 })).toEqual([]);
      // Writing after expiry starts fresh at version 1.
      const r = await b.write(op({ kind: "increment", tuple: tu.subject1, key: "a", field: "n", subjectTtlMs: ttl, now: 2_000 }));
      expect(r).toMatchObject({ version: 1, value: { n: 1 } });
      expect(await b.sweep(10_000)).toBeGreaterThanOrEqual(1);
      expect(await b.get(tu.subject1, "a", 0)).toBeNull();
    }));

    it("per-item ttl expires non-subject items", withBackend(async (b) => {
      await b.write(op({ kind: "put", tuple: tu.graphA, key: "t", value: 1, ttlMs: 100, now: 0 }));
      expect(await b.get(tu.graphA, "t", 50)).not.toBeNull();
      expect(await b.get(tu.graphA, "t", 100)).toBeNull();
    }));

    it("evicts the least recently written subject beyond subjectsPerType", withBackend(async (b) => {
      const l = limits({ subjectsPerType: 2 });
      const s = (k: string) => T({ project: "github.com/acme/web", subjectType: "build", subjectKey: k });
      await b.write(op({ kind: "put", tuple: s("b1"), key: "x", value: 1, limits: l, now: 1 }));
      await b.write(op({ kind: "put", tuple: s("b2"), key: "x", value: 1, limits: l, now: 2 }));
      await b.write(op({ kind: "put", tuple: s("b1"), key: "y", value: 1, limits: l, now: 3 }));
      await b.write(op({ kind: "put", tuple: s("b3"), key: "x", value: 1, limits: l, now: 4 }));
      expect(await b.get(s("b2"), "x", 5)).toBeNull();
      expect(await b.get(s("b1"), "x", 5)).not.toBeNull();
      expect(await b.get(s("b3"), "x", 5)).not.toBeNull();
    }));

    it("a new subject evicts every subject past a lowered cap, oldest first", withBackend(async (b) => {
      const s = (k: string) => T({ project: "github.com/acme/web", subjectType: "build", subjectKey: k });
      for (const [i, k] of ["b1", "b2", "b3", "b4"].entries()) {
        await b.write(op({ kind: "put", tuple: s(k), key: "x", value: i, limits: limits({ subjectsPerType: 10 }), now: 10 + i }));
      }
      // Writing to an existing subject never evicts.
      const keep = await b.write(op({ kind: "put", tuple: s("b1"), key: "y", value: 1, limits: limits({ subjectsPerType: 2 }), now: 20 }));
      expect(keep.evicted).toBe(0);
      const r = await b.write(op({ kind: "put", tuple: s("b5"), key: "x", value: 1, limits: limits({ subjectsPerType: 2 }), now: 21 }));
      // b1 (refreshed at 20) and the new b5 remain; b2, b3, b4 go.
      expect(r.evicted).toBe(3);
      for (const k of ["b2", "b3", "b4"]) expect(await b.get(s(k), "x", 22)).toBeNull();
      expect(await b.get(s("b1"), "y", 22)).not.toBeNull();
      expect(await b.get(s("b5"), "x", 22)).not.toBeNull();
    }));

    it("concurrent writes to many keys and subjects all land", withBackend(async (b) => {
      const s = (k: string) => T({ project: "github.com/acme/web", subjectType: "job", subjectKey: k });
      await Promise.all([
        ...Array.from({ length: 20 }, (_, i) => b.write(op({ kind: "append", tuple: tu.graphA, key: "log", value: i, max: 100 }))),
        ...Array.from({ length: 20 }, (_, i) => b.write(op({ kind: "put", tuple: tu.graphA, key: `k${i}`, value: i }))),
        ...Array.from({ length: 10 }, (_, i) => b.write(op({ kind: "increment", tuple: s(`j${i % 3}`), key: "n", field: "" }))),
      ]);
      expect(((await b.get(tu.graphA, "log"))?.value as number[]).slice().sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i));
      expect(await b.list(tu.graphA, { prefix: "k" })).toHaveLength(20);
      const counts = await Promise.all([0, 1, 2].map(async (i) => (await b.get(s(`j${i}`), "n"))?.value));
      expect(counts).toEqual([4, 3, 3]);
    }));

    it("sweep drops expired items everywhere and op records past retention", withBackend(async (b) => {
      await b.write(op({ kind: "put", tuple: tu.graphA, key: "t", value: 1, ttlMs: 10, now: 0 }));
      await b.write(op({ kind: "put", tuple: tu.userA1, key: "t", value: 1, ttlMs: 10, now: 0 }));
      await b.write(op({ kind: "put", tuple: tu.graphA, key: "keep", value: 1, now: 0 }));
      await b.write(op({ kind: "put", tuple: tu.graphA, key: "o", value: 1, opId: "sweep-1", now: 0 }));
      // Default retention keeps a fresh op record.
      expect(await b.sweep(100)).toBe(2);
      expect((await b.write(op({ kind: "put", tuple: tu.graphA, key: "o", value: 1, opId: "sweep-1", now: 100 }))).deduped).toBe(true);
      expect(await b.sweep(200, { opsRetentionMs: 50 })).toBe(0);
      expect((await b.write(op({ kind: "put", tuple: tu.graphA, key: "o", value: 1, opId: "sweep-1", now: 200 }))).deduped).toBe(false);
      expect(await b.get(tu.graphA, "keep", 200)).not.toBeNull();
    }));

    it("lists by prefix and attrs, newest first, with limit", withBackend(async (b) => {
      await b.write(op({ kind: "put", tuple: tu.graphA, key: "fix/1", value: 1, attrs: { kind: "fix" }, now: 1 }));
      await b.write(op({ kind: "put", tuple: tu.graphA, key: "fix/2", value: 2, attrs: { kind: "fix" }, now: 2 }));
      await b.write(op({ kind: "put", tuple: tu.graphA, key: "note/1", value: 3, attrs: { kind: "note" }, now: 3 }));
      await b.write(op({ kind: "put", tuple: tu.graphA, key: "fix%", value: 4, now: 4 }));
      expect((await b.list(tu.graphA, { prefix: "fix/", now: 5 })).map((r) => r.key)).toEqual(["fix/2", "fix/1"]);
      expect((await b.list(tu.graphA, { attrs: { kind: "note" }, now: 5 })).map((r) => r.key)).toEqual(["note/1"]);
      expect((await b.list(tu.graphA, { limit: 2, now: 5 })).map((r) => r.key)).toEqual(["fix%", "note/1"]);
      // LIKE metacharacters in prefixes are literal.
      expect((await b.list(tu.graphA, { prefix: "fix%", now: 5 })).map((r) => r.key)).toEqual(["fix%"]);
      expect((await b.list(tu.graphA, { prefix: "fi_", now: 5 })).map((r) => r.key)).toEqual([]);
    }));

    const subj = (key: string, o: Partial<MemoryTuple> = {}) =>
      T({ project: "github.com/acme/web", subjectType: "incident", subjectKey: key, ...o });
    const similar = (b: MemoryBackend, q: Partial<Parameters<MemoryBackend["similarSubjects"]>[0]> = {}) =>
      b.similarSubjects({
        org: "acme",
        project: "github.com/acme/web",
        subjectType: "incident",
        limit: 5,
        perSubject: 2,
        now: 100,
        ...q,
      });
    const keys = (gs: Array<{ subjectKey: string; items: Array<{ key: string }> }>) =>
      gs.map((g) => `${g.subjectKey}:${g.items.map((i) => i.key).join(",")}`);

    it("similarSubjects: other subjects of one type, newest first, grouped per subject", withBackend(async (b) => {
      let t = 1;
      for (const k of ["inc-1", "inc-2", "inc-3", "inc-ME"]) {
        for (let i = 0; i < 3; i++) {
          await b.write(op({ kind: "put", tuple: subj(k), key: `attempt/${i}`, value: { k, i }, attrs: { service: "db", outcome: "resolved" }, now: t++ }));
        }
      }
      // inc-1 gets the most recent activity.
      await b.write(op({ kind: "put", tuple: subj("inc-1"), key: "attempt/9", value: 9, attrs: { service: "db", outcome: "resolved" }, now: 50 }));
      expect(keys(await similar(b, { excludeSubjectKey: "inc-ME" }))).toEqual([
        "inc-1:attempt/9,attempt/2",
        "inc-3:attempt/2,attempt/1",
        "inc-2:attempt/2,attempt/1",
      ]);
      expect(keys(await similar(b, { excludeSubjectKey: "inc-ME", limit: 1, perSubject: 1 }))).toEqual(["inc-1:attempt/9"]);
      // limits are clamped, not trusted
      const wide = await similar(b, { limit: 10_000, perSubject: 10_000 });
      expect(wide.length).toBe(4);
      expect(Math.max(...wide.map((g) => g.items.length))).toBeLessThanOrEqual(10);
    }));

    it("similarSubjects without attrs: prefix, limit and per-subject order", withBackend(async (b) => {
      await b.write(op({ kind: "put", tuple: subj("s1"), key: "note/a", value: 1, now: 1 }));
      await b.write(op({ kind: "put", tuple: subj("s1"), key: "other", value: 1, now: 9 }));
      await b.write(op({ kind: "put", tuple: subj("s2"), key: "note/a", value: 1, now: 3 }));
      await b.write(op({ kind: "put", tuple: subj("s2"), key: "note/b", value: 1, now: 4 }));
      await b.write(op({ kind: "put", tuple: subj("s3"), key: "note/a", value: 1, now: 4 }));
      // s1's newest note is older than its newest item: only matching rows rank a subject.
      expect(keys(await similar(b, { prefix: "note/" }))).toEqual(["s2:note/b,note/a", "s3:note/a", "s1:note/a"]);
      expect(keys(await similar(b, {}))).toEqual(["s1:other,note/a", "s2:note/b,note/a", "s3:note/a"]);
      expect(keys(await similar(b, { limit: 2, perSubject: 1, excludeSubjectKey: "s1" }))).toEqual(["s2:note/b", "s3:note/a"]);
    }));

    it("similarSubjects: exact attr match by type, prefix filter, and scope isolation", withBackend(async (b) => {
      await b.write(op({ kind: "put", tuple: subj("A"), key: "attempt/1", value: 1, attrs: { service: "db", outcome: "resolved", n: 2, hot: true }, now: 1 }));
      await b.write(op({ kind: "put", tuple: subj("B"), key: "attempt/1", value: 2, attrs: { service: "db", outcome: "failed", n: "2", hot: false }, now: 2 }));
      await b.write(op({ kind: "put", tuple: subj("C"), key: "note/1", value: 3, attrs: { service: "db", outcome: "resolved" }, now: 3 }));
      // Same attrs outside the project / type / subject scope must never show up.
      await b.write(op({ kind: "put", tuple: subj("X", { project: "github.com/acme/other" }), key: "attempt/1", value: 4, attrs: { service: "db", outcome: "resolved" }, now: 4 }));
      await b.write(op({ kind: "put", tuple: subj("Y", { subjectType: "build" }), key: "attempt/1", value: 5, attrs: { service: "db", outcome: "resolved" }, now: 5 }));
      await b.write(op({ kind: "put", tuple: tu.userA1, key: "attempt/1", value: 6, attrs: { service: "db", outcome: "resolved" }, now: 6 }));
      await b.write(op({ kind: "put", tuple: tu.graphA, key: "attempt/1", value: 7, attrs: { service: "db", outcome: "resolved" }, now: 7 }));
      await b.write(op({ kind: "put", tuple: tu.project, key: "attempt/1", value: 8, attrs: { service: "db", outcome: "resolved" }, now: 8 }));

      expect(keys(await similar(b, { attrs: { service: "db" } }))).toEqual(["C:note/1", "B:attempt/1", "A:attempt/1"]);
      expect(keys(await similar(b, { attrs: { service: "db", outcome: "resolved" } }))).toEqual(["C:note/1", "A:attempt/1"]);
      expect(keys(await similar(b, { attrs: { outcome: "resolved" }, prefix: "attempt/" }))).toEqual(["A:attempt/1"]);
      // types are exact: number 2 is not string "2", true is not 1
      expect(keys(await similar(b, { attrs: { n: 2 } }))).toEqual(["A:attempt/1"]);
      expect(keys(await similar(b, { attrs: { n: "2" } }))).toEqual(["B:attempt/1"]);
      expect(keys(await similar(b, { attrs: { hot: true } }))).toEqual(["A:attempt/1"]);
      expect(keys(await similar(b, { attrs: { hot: 1 } }))).toEqual([]);
      expect(keys(await similar(b, { attrs: { missing: "x" } }))).toEqual([]);
      // a non-scalar filter matches nothing; prefix metacharacters are literal
      expect(await similar(b, { attrs: { service: { $ne: "x" } } })).toEqual([]);
      expect(await similar(b, { prefix: "attempt_" })).toEqual([]);
    }));

    it("similarSubjects: hides expired subjects", withBackend(async (b) => {
      await b.write(op({ kind: "put", tuple: subj("OLD"), key: "a", value: 1, subjectTtlMs: 10, now: 1 }));
      await b.write(op({ kind: "put", tuple: subj("NEW"), key: "a", value: 1, subjectTtlMs: 1_000, now: 50 }));
      expect(keys(await similar(b, { now: 100 }))).toEqual(["NEW:a"]);
    }));

    it("stores thread bindings insert-only, with the principal", withBackend(async (b) => {
      expect(await b.getThread("t1")).toBeNull();
      const base = { threadId: "t1", org: "acme", project: "p", graph: "g", usr: "u", principalId: "p-1", subjectType: "incident", subjectKey: "inc-9" };
      await b.bindThread(base);
      expect(await b.getThread("t1")).toMatchObject(base);
      // A second bind never overwrites the first (callers re-read and compare).
      await b.bindThread({ ...base, usr: "mallory", principalId: "p-2", subjectKey: "inc-1" });
      expect(await b.getThread("t1")).toMatchObject(base);
    }));

    it("op ids dedupe only the same write (fingerprint)", withBackend(async (b) => {
      await b.write(op({ kind: "put", tuple: tu.graphA, key: "fix-a", value: 1, opId: "fp-1", fingerprint: "A" }));
      // Same op id, different write: applied, never silently dropped.
      const other = await b.write(op({ kind: "put", tuple: tu.userA1, key: "pref-b", value: 2, opId: "fp-1", fingerprint: "B" }));
      expect(other.deduped).toBe(false);
      expect((await b.get(tu.userA1, "pref-b"))?.value).toBe(2);
      // Same op id and fingerprint: deduped.
      expect((await b.write(op({ kind: "put", tuple: tu.userA1, key: "pref-b", value: 2, opId: "fp-1", fingerprint: "B" }))).deduped).toBe(true);
      // Without an explicit fingerprint one is derived from the write itself.
      await b.write(op({ kind: "put", tuple: tu.graphA, key: "x", value: 1, opId: "fp-2" }));
      expect((await b.write(op({ kind: "put", tuple: tu.graphA, key: "x", value: 1, opId: "fp-2" }))).deduped).toBe(true);
      expect((await b.write(op({ kind: "put", tuple: tu.graphA, key: "x", value: 5, opId: "fp-2" }))).deduped).toBe(false);
      expect((await b.get(tu.graphA, "x"))?.value).toBe(5);
    }));

    it("alternating retries under one op id apply each write once", withBackend(async (b) => {
      for (const key of ["c", "d", "c", "d", "c"]) {
        await b.write(op({ kind: "increment", tuple: tu.graphA, key, field: "n", opId: "alt-1" }));
      }
      expect((await b.get(tu.graphA, "c"))?.value).toEqual({ n: 1 });
      expect((await b.get(tu.graphA, "d"))?.value).toEqual({ n: 1 });
    }));

    it("list honours a limit", withBackend(async (b) => {
      for (let i = 0; i < 5; i++) await b.write(op({ kind: "put", tuple: tu.graphA, key: `l/${i}`, value: i }));
      expect(await b.list(tu.graphA, { prefix: "l/", limit: 3 })).toHaveLength(3);
      expect(await b.list(tu.graphA, { prefix: "l/" })).toHaveLength(5);
    }));

    it("a reordered retry does not apply an increment or append twice", withBackend(async (b) => {
      const first = attempt(b, "task-reorder").memory;
      await first.increment("graph", "c", "n");
      await first.append("graph", "log", "a");
      await first.append("graph", "log", "a");
      await first.append("graph", "log", "b");
      await first.increment("graph", "d", "n");

      const retry = attempt(b, "task-reorder").memory;
      expect((await retry.append("graph", "log", "b")).deduped).toBe(true);
      expect((await retry.increment("graph", "d", "n")).deduped).toBe(true);
      expect((await retry.append("graph", "log", "a")).deduped).toBe(true);
      expect((await retry.append("graph", "log", "a")).deduped).toBe(true);
      expect((await retry.increment("graph", "c", "n")).deduped).toBe(true);

      expect((await b.get(tu.graphA, "c"))?.value).toEqual({ n: 1 });
      expect((await b.get(tu.graphA, "d"))?.value).toEqual({ n: 1 });
      expect((await b.get(tu.graphA, "log"))?.value).toEqual(["a", "a", "b"]);
    }));

    it("a retry that adds a write does not apply the original increment or append twice", withBackend(async (b) => {
      const first = attempt(b, "task-extra").memory;
      await first.increment("graph", "c", "n");
      await first.append("graph", "log", "a");
      await first.increment("graph", "d", "n");

      const retry = attempt(b, "task-extra").memory;
      expect((await retry.increment("graph", "c", "n")).deduped).toBe(true);
      expect((await retry.increment("graph", "extra", "n")).deduped).toBe(false);
      expect((await retry.append("graph", "log", "b")).deduped).toBe(false);
      expect((await retry.append("graph", "log", "a")).deduped).toBe(true);
      expect((await retry.increment("graph", "d", "n")).deduped).toBe(true);

      expect((await b.get(tu.graphA, "c"))?.value).toEqual({ n: 1 });
      expect((await b.get(tu.graphA, "extra"))?.value).toEqual({ n: 1 });
      expect((await b.get(tu.graphA, "d"))?.value).toEqual({ n: 1 });
      expect((await b.get(tu.graphA, "log"))?.value).toEqual(["a", "b"]);
    }));

    it("a retry that drops a write does not apply the ones it still makes twice", withBackend(async (b) => {
      const first = attempt(b, "task-drop").memory;
      await first.increment("graph", "c", "n");
      await first.append("graph", "log", "a");
      await first.append("graph", "log", "b");
      await first.increment("graph", "d", "n");

      const retry = attempt(b, "task-drop").memory;
      expect((await retry.append("graph", "log", "b")).deduped).toBe(true);
      expect((await retry.increment("graph", "d", "n")).deduped).toBe(true);

      expect((await b.get(tu.graphA, "c"))?.value).toEqual({ n: 1 });
      expect((await b.get(tu.graphA, "d"))?.value).toEqual({ n: 1 });
      expect((await b.get(tu.graphA, "log"))?.value).toEqual(["a", "b"]);
    }));

    it("adopts positional op records from an older build in any order", withBackend(async (b) => {
      const { source } = attempt(b, "task-legacy");
      // `by: 1` matches ctx.memory.increment, which always sends it.
      const inc = (index: number, key: string) =>
        b.write(op({ kind: "increment", tuple: tu.graphA, key, field: "n", by: 1, opId: memoryPositionalOpId(source, index) }));
      const app = (index: number, item: string) =>
        b.write(op({ kind: "append", tuple: tu.graphA, key: "log", value: item, opId: memoryPositionalOpId(source, index) }));
      await inc(0, "c");
      await inc(1, "c");
      await app(2, "a");
      await app(3, "b");
      // Index 4 was a write that failed and left no row. Index 5 is d.
      await inc(5, "d");

      const retry = attempt(b, "task-legacy").memory;
      expect((await retry.increment("graph", "d", "n")).deduped).toBe(true);
      expect((await retry.append("graph", "log", "b")).deduped).toBe(true);
      expect((await retry.append("graph", "log", "a")).deduped).toBe(true);
      expect((await retry.increment("graph", "c", "n")).deduped).toBe(true);
      expect((await retry.increment("graph", "c", "n")).deduped).toBe(true);
      // One more identical increment than the older attempt stored is a new write.
      expect((await retry.increment("graph", "c", "n")).deduped).toBe(false);

      expect((await b.get(tu.graphA, "c"))?.value).toEqual({ n: 3 });
      expect((await b.get(tu.graphA, "d"))?.value).toEqual({ n: 1 });
      expect((await b.get(tu.graphA, "log"))?.value).toEqual(["a", "b"]);
    }));

    it("adopts an older alternating record stored beside the positional id", withBackend(async (b) => {
      const { source } = attempt(b, "task-alt-legacy");
      const id = memoryPositionalOpId(source, 0);
      await b.write(op({ kind: "increment", tuple: tu.graphA, key: "c", field: "n", by: 1, opId: id }));
      await b.write(op({ kind: "increment", tuple: tu.graphA, key: "d", field: "n", by: 1, opId: id }));

      const retry = attempt(b, "task-alt-legacy").memory;
      expect((await retry.increment("graph", "d", "n")).deduped).toBe(true);
      expect((await retry.increment("graph", "c", "n")).deduped).toBe(true);
      expect((await b.get(tu.graphA, "c"))?.value).toEqual({ n: 1 });
      expect((await b.get(tu.graphA, "d"))?.value).toEqual({ n: 1 });
    }));

    it("an idempotency key keeps the first payload", withBackend(async (b) => {
      const first = attempt(b, "task-idem").memory;
      expect((await first.increment("graph", "c", "n", 1, { idempotencyKey: "charge" })).deduped).toBe(false);
      const retry = attempt(b, "task-idem").memory;
      const again = await retry.increment("graph", "c", "n", 5, { idempotencyKey: "charge" });
      expect(again).toMatchObject({ deduped: true, value: { n: 1 } });
      expect((await retry.increment("graph", "c", "n", 5, { idempotencyKey: "charge-2" })).deduped).toBe(false);
      expect((await b.get(tu.graphA, "c"))?.value).toEqual({ n: 6 });
    }));

    it("reusing an idempotency key for a different kind, scope or key is an error", withBackend(async (b) => {
      const first = attempt(b, "task-idem-mismatch").memory;
      await first.increment("graph", "x", "n", 1, { idempotencyKey: "k" });
      await first.update("graph", "counter", (cur) => ((cur as number | undefined) ?? 0) + 1, { idempotencyKey: "u" });
      // Same attempt: the key is already bound, so the other write is refused before it lands.
      await expect(first.put("graph", "y", 1, { idempotencyKey: "k" })).rejects.toMatchObject({ code: "MEMORY_IDEMPOTENCY_CONFLICT" });
      await expect(first.increment("user", "x", "n", 1, { idempotencyKey: "k" })).rejects.toMatchObject({ code: "MEMORY_IDEMPOTENCY_CONFLICT" });
      await expect(first.update("graph", "other", () => 1, { idempotencyKey: "u" })).rejects.toMatchObject({ code: "MEMORY_IDEMPOTENCY_CONFLICT" });

      const retry = attempt(b, "task-idem-mismatch").memory;
      await expect(retry.increment("graph", "y", "n", 1, { idempotencyKey: "k" })).rejects.toMatchObject({ code: "MEMORY_IDEMPOTENCY_CONFLICT" });
      await expect(retry.put("user", "x", 1, { idempotencyKey: "k" })).rejects.toMatchObject({ code: "MEMORY_IDEMPOTENCY_CONFLICT" });
      await expect(retry.append("graph", "x", "z", { idempotencyKey: "k" })).rejects.toMatchObject({ code: "MEMORY_IDEMPOTENCY_CONFLICT" });
      await expect(retry.increment("graph", "counter", "n", 1, { idempotencyKey: "u" })).rejects.toMatchObject({ code: "MEMORY_IDEMPOTENCY_CONFLICT" });
      await expect(retry.update("user", "counter", () => 5, { idempotencyKey: "u" })).rejects.toMatchObject({ code: "MEMORY_IDEMPOTENCY_CONFLICT" });

      // The original operation still dedupes, payload included.
      expect(await retry.increment("graph", "x", "n", 9, { idempotencyKey: "k" })).toMatchObject({ deduped: true, value: { n: 1 } });
      expect(await retry.update("graph", "counter", () => 99, { idempotencyKey: "u" })).toMatchObject({ deduped: true, value: 1 });
      expect(await b.get(tu.graphA, "y")).toBeNull();
      expect(await b.get(tu.userA1, "x")).toBeNull();
      expect(await b.get(tu.graphA, "other")).toBeNull();
      expect((await b.get(tu.graphA, "x"))?.value).toEqual({ n: 1 });
      expect((await b.get(tu.graphA, "counter"))?.value).toBe(1);
    }));

    it("concurrent retries of the same writes apply once", withBackend(async (b) => {
      await Promise.all(
        Array.from({ length: 8 }, () => {
          const m = attempt(b, "task-concurrent").memory;
          return m.increment("graph", "c", "n").then(() => m.append("graph", "log", "a"));
        }),
      );
      expect((await b.get(tu.graphA, "c"))?.value).toEqual({ n: 1 });
      expect((await b.get(tu.graphA, "log"))?.value).toEqual(["a"]);
    }));

    it("survives reopen when durable", withBackend(async (b, h) => {
      if (!b.durable || !h.reopen) return;
      await b.write(op({ kind: "increment", tuple: tu.graphA, key: "d", field: "n", opId: "dur-1" }));
      await b.bindThread({ threadId: "td", org: "acme", project: "p", graph: "g", usr: "", subjectType: "", subjectKey: "" });
      const b2 = await h.reopen();
      expect((await b2.get(tu.graphA, "d"))?.value).toEqual({ n: 1 });
      expect((await b2.write(op({ kind: "increment", tuple: tu.graphA, key: "d", field: "n", opId: "dur-1" }))).deduped).toBe(true);
      expect((await b2.getThread("td"))?.graph).toBe("g");
    }));
  });
}
