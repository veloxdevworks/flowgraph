/**
 * Built-in node type: `memory`
 *
 * Reads or writes scoped durable memory through `ctx.memory`. Requires
 * `runtime.memory`. Writes are replay-safe (op ids) and atomic per op.
 */
import { z } from "zod";
import { MemoryWithSchema } from "@flowgraph/spec";
import { renderDeep } from "@flowgraph/expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { NodeRunContext } from "../context.js";
import { applyOutput } from "./output.js";
import { MemoryError } from "../memory/types.js";
import type { MemoryScopeName } from "../memory/types.js";

const configSchema = MemoryWithSchema;
type Config = z.infer<typeof configSchema>;

function toNumber(v: unknown, what: string): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new MemoryError("MEMORY_TYPE_MISMATCH", `${what} must be a number (got ${JSON.stringify(v)})`);
  return n;
}

export const memoryNode = defineNode<Config>({
  type: "memory",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configSchema: configSchema as any,
  capabilities: {},

  build(_ctx: BuildContext, nodeSpec: Record<string, unknown>, config: Config): CompiledNode {
    const nodeId = String(nodeSpec["id"] ?? "memory");
    return {
      contract: {},
      capabilities: {},

      async run(state: Record<string, unknown>, ctx: NodeRunContext): Promise<NodeResult> {
        const mem = ctx.memory;
        if (!mem) {
          throw new MemoryError(
            "MEMORY_NOT_CONFIGURED",
            `memory node "${nodeId}" needs runtime.memory in the graph spec`,
          );
        }
        const scope = {
          state,
          input: (ctx as NodeRunContext & { _input?: Record<string, unknown> })._input ?? {},
          config: ctx.config,
          run: ctx.meta,
        };
        const r = <T>(v: T): unknown => (v === undefined ? undefined : renderDeep(v as never, scope));
        const renderedKey = config.key !== undefined ? r(config.key) : undefined;
        if (config.op !== "search" && (renderedKey === undefined || renderedKey === null || renderedKey === "")) {
          throw new MemoryError(
            "MEMORY_KEY_INVALID",
            `memory node "${nodeId}": op "${config.op}" needs a key` +
              (config.key !== undefined ? ` (${JSON.stringify(config.key)} rendered empty)` : ""),
          );
        }
        const key = renderedKey === undefined || renderedKey === null ? "" : String(renderedKey);
        const readScopes: MemoryScopeName[] | undefined = config.scopes ?? (config.scope ? [config.scope] : undefined);
        const writeScope: MemoryScopeName = config.scope ?? (mem.scope.user ? "user" : "graph");
        const attrs = r(config.attrs) as Record<string, unknown> | undefined;
        const ifVersion = toNumber(r(config.ifVersion), "ifVersion");
        const writeOpts = {
          ...(attrs !== undefined ? { attrs } : {}),
          ...(config.ttl !== undefined ? { ttl: config.ttl } : {}),
          ...(ifVersion !== undefined ? { ifVersion } : {}),
        };

        let result: unknown;
        switch (config.op) {
          case "get": {
            const rec = await mem.get(key, { scopes: readScopes });
            if (!rec && config.required) {
              throw new Error(`memory node "${nodeId}": key "${key}" not found in scopes ${(readScopes ?? ["user", "subject", "graph", "project", "org"]).join(", ")}`);
            }
            result = rec ? { key: rec.key, value: rec.value, scope: rec.scope, version: rec.version, attrs: rec.attrs } : null;
            break;
          }
          case "search": {
            const items = await mem.search({
              scopes: readScopes,
              prefix: config.prefix !== undefined ? String(r(config.prefix)) : undefined,
              attrs,
              limit: config.limit,
            });
            result = items.map((i) => ({ key: i.key, value: i.value, scope: i.scope, version: i.version, attrs: i.attrs }));
            break;
          }
          case "put":
          case "patch":
          case "append":
          case "increment":
          case "delete": {
            let out;
            if (config.op === "put") out = await mem.put(writeScope, key, r(config.value), writeOpts);
            else if (config.op === "patch") out = await mem.patch(writeScope, key, r(config.value) as Record<string, unknown>, writeOpts);
            else if (config.op === "append") out = await mem.append(writeScope, key, r(config.value), { ...writeOpts, ...(config.max ? { max: config.max } : {}) });
            else if (config.op === "increment") {
              out = await mem.increment(writeScope, key, config.field ?? "count", toNumber(r(config.by), "by") ?? 1, writeOpts);
            } else out = await mem.delete(writeScope, key, ifVersion !== undefined ? { ifVersion } : undefined);
            result = { key, scope: writeScope, version: out.version, value: out.value };
            break;
          }
        }

        ctx.emit("node.output", { result });
        return { update: applyOutput(config.output, result, { nodeId, scope }) };
      },
    };
  },
});
