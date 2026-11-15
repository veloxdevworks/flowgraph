import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileGraph,
  createScriptedProvider,
  registerTool,
  inspectThreadReplay,
  type ReplayCheckpointStore,
  type GraphSpec,
} from "@flowgraph/core";
import { openSqliteBackend } from "./index.js";
it("persists completed model/tool steps across SQLite connections", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fg-replay-sqlite-")),
    a = await openSqliteBackend(join(dir, "cp.db")),
    b = await openSqliteBackend(join(dir, "cp.db"));
  try {
    const effect = vi.fn(() => "done");
    registerTool({ name: "replay_effect_sqlite", handler: effect });
    let fail = true,
      calls = 0;
    const provider = createScriptedProvider("replay", async (_req, ctx) => {
      if (ctx.replay?.get("llm:0") === undefined) {
        const value = await ctx.meterCall!(
          async () => {
            calls++;
            return { totalTokens: 4, costUSD: 0.001 };
          },
          { usage: (v) => v },
        );
        await ctx.replay?.set("llm:0", value);
      }
      await ctx.invokeTool("replay_effect_sqlite", {});
      if (fail) {
        fail = false;
        throw new Error("crash after tool");
      }
      return { output: "done", stopReason: "done" };
    });
    provider.capabilities.callAccounting = true;
    const spec = {
      metadata: { name: "replay" },
      nodes: [
        {
          id: "a",
          type: "agent",
          provider: "replay",
          with: { prompt: "test", tools: [{ function: "replay_effect_sqlite" }] },
        },
      ],
      edges: [
        { from: "START", to: "a" },
        { from: "a", to: "END" },
      ],
    } as unknown as GraphSpec;
    expect(
      (
        await (
          await compileGraph(spec, { checkpointer: a.checkpointer, providers: [provider] })
        ).run({ threadId: "replay" })
      ).status,
    ).toBe("error");
    expect((await inspectThreadReplay(b.checkpointer, "replay")).length).toBeGreaterThan(0);
    expect(
      await (
        await compileGraph(spec, { checkpointer: b.checkpointer, providers: [provider] })
      ).resume({ threadId: "replay", resume: true }),
    ).toMatchObject({ status: "completed", usage: { totalTokens: 4, costUSD: 0.001 } });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(calls).toBe(1);
    const store = b.checkpointer as unknown as ReplayCheckpointStore;
    const pending = { id: "receipt", state: "pending" };
    expect(await store.compareThreadReplay("replay", "race", "slot", undefined, pending)).toBe(
      true,
    );
    expect(
      await store.compareThreadReplay("replay", "race", "slot", pending, { result: "reconciled" }),
    ).toBe(true);
    expect(
      await store.compareThreadReplay("replay", "race", "slot", pending, { result: "late" }),
    ).toBe(false);
    expect((await store.readThreadReplay("replay", "race"))?.slot).toEqual({
      result: "reconciled",
    });
    expect(await store.compareThreadReplay("replay", "race", "null", undefined, null)).toBe(true);
    expect(await store.compareThreadReplay("replay", "race", "null", undefined, "wrong")).toBe(
      false,
    );
    expect(await store.compareThreadReplay("replay", "race", "null", null, undefined)).toBe(true);
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
