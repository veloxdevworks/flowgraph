/**
 * Legacy `ctx.store` adapter: a LangGraph BaseStore view over scoped memory,
 * confined to the graph scope of the root graph.
 *
 * (namespace, key) maps to the memory key `legacy/<ns…>/<key>` with each
 * segment URI-encoded. Writes are last-writer-wins (no op ids), values may be
 * up to the 64KB hard cap and are not secret-scanned, matching the old
 * InMemoryStore semantics; the graph scope's item/byte limits apply with
 * evict-oldest.
 */
import {
  BaseStore,
  type Item,
  type Operation,
  type OperationResults,
  type GetOperation,
  type PutOperation,
  type SearchOperation,
  type ListNamespacesOperation,
} from "@langchain/langgraph";
import { MemoryError, MEMORY_HARD_CAPS, type MemoryBackend, type MemoryRow, type MemoryTuple } from "./types.js";
import type { MemoryPolicy } from "./handle.js";

const PREFIX = "legacy/";

function encodeKey(namespace: string[], key: string): string {
  return PREFIX + [...namespace, key].map((s) => encodeURIComponent(s)).join("/");
}

function decodeKey(k: string): { namespace: string[]; key: string } | undefined {
  if (!k.startsWith(PREFIX)) return undefined;
  const parts = k.slice(PREFIX.length).split("/").map((s) => decodeURIComponent(s));
  const key = parts.pop();
  if (key === undefined) return undefined;
  return { namespace: parts, key };
}

function toItem(row: MemoryRow, ns: string[], key: string): Item {
  return {
    namespace: ns,
    key,
    value: (row.value ?? {}) as Record<string, unknown>,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function matchesFilter(value: unknown, filter: Record<string, unknown> | undefined): boolean {
  if (!filter) return true;
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Object.entries(filter).every(([k, want]) => {
    const got = v[k];
    if (want !== null && typeof want === "object" && !Array.isArray(want)) {
      const ops = want as Record<string, unknown>;
      return Object.entries(ops).every(([op, x]) => {
        switch (op) {
          case "$eq": return got === x;
          case "$ne": return got !== x;
          case "$gt": return (got as number) > (x as number);
          case "$gte": return (got as number) >= (x as number);
          case "$lt": return (got as number) < (x as number);
          case "$lte": return (got as number) <= (x as number);
          default: return JSON.stringify(got) === JSON.stringify(want);
        }
      });
    }
    return JSON.stringify(got) === JSON.stringify(want);
  });
}

export class LegacyScopedStore extends BaseStore {
  constructor(
    private readonly backend: MemoryBackend,
    private readonly tuple: MemoryTuple,
    private readonly policy: MemoryPolicy,
  ) {
    super();
  }

  /** The graph-scope tuple this store is confined to. */
  get scopeTuple(): Readonly<MemoryTuple> {
    return this.tuple;
  }

  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    const out: unknown[] = [];
    for (const op of operations) {
      if ("namespacePrefix" in op) out.push(await this.doSearch(op as SearchOperation));
      else if ("key" in op && "value" in op) out.push(await this.doPut(op as PutOperation));
      else if ("key" in op) out.push(await this.doGet(op as GetOperation));
      else out.push(await this.doListNamespaces(op as ListNamespacesOperation));
    }
    return out as OperationResults<Op>;
  }

  private async doGet(op: GetOperation): Promise<Item | null> {
    const row = await this.backend.get(this.tuple, encodeKey(op.namespace, op.key));
    return row ? toItem(row, op.namespace, op.key) : null;
  }

  private async doPut(op: PutOperation): Promise<void> {
    const key = encodeKey(op.namespace, op.key);
    if (key.length > this.policy.limits.keyChars) {
      throw new MemoryError("MEMORY_KEY_INVALID", `store key ${JSON.stringify([...op.namespace, op.key])} is too long`);
    }
    await this.backend.write({
      kind: op.value === null ? "delete" : "put",
      tuple: this.tuple,
      key,
      value: op.value,
      limits: { ...this.policy.limits, itemBytes: MEMORY_HARD_CAPS.itemBytes },
      allowSecrets: true,
    });
  }

  private async allItems(prefix: string[]): Promise<Array<{ row: MemoryRow; namespace: string[]; key: string }>> {
    const p = prefix.length ? PREFIX + prefix.map((s) => encodeURIComponent(s)).join("/") + "/" : PREFIX;
    const rows = await this.backend.list(this.tuple, { prefix: p });
    const out: Array<{ row: MemoryRow; namespace: string[]; key: string }> = [];
    for (const row of rows) {
      const d = decodeKey(row.key);
      if (d) out.push({ row, ...d });
    }
    return out;
  }

  private async doSearch(op: SearchOperation): Promise<Item[]> {
    const items = (await this.allItems(op.namespacePrefix)).filter((i) => matchesFilter(i.row.value, op.filter));
    const offset = op.offset ?? 0;
    const limit = op.limit ?? 10;
    return items.slice(offset, offset + limit).map((i) => toItem(i.row, i.namespace, i.key));
  }

  private async doListNamespaces(op: ListNamespacesOperation): Promise<string[][]> {
    const seen = new Map<string, string[]>();
    for (const i of await this.allItems([])) {
      let ns = i.namespace;
      if (op.maxDepth !== undefined) ns = ns.slice(0, op.maxDepth);
      seen.set(JSON.stringify(ns), ns);
    }
    let all = [...seen.values()].sort((a, b) => a.join("/").localeCompare(b.join("/")));
    for (const c of op.matchConditions ?? []) {
      all = all.filter((ns) => {
        const path = c.path;
        if (path.length > ns.length) return false;
        const seg = c.matchType === "prefix" ? ns.slice(0, path.length) : ns.slice(ns.length - path.length);
        return path.every((p, idx) => p === "*" || p === seg[idx]);
      });
    }
    const offset = op.offset ?? 0;
    return all.slice(offset, offset + (op.limit ?? 100));
  }
}
