import { expect, it } from "vitest";
import { createMapMemo, reduceMapMemo } from "./map-memo.js";
import type { MapTask } from "../nodes/map.js";
import type { NodeRunContext } from "../context.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const task: MapTask = { mapId: "fan", index: 0, item: 1, as: "n", count: 1, memoGeneration: 1 };
it("merges successful parallel entries deterministically and handles prototype-like map ids", () => {
  const entry = (key: string, index: number) => ({
    key,
    index,
    payload: "1",
    bytes: 1,
    hash: "",
    generation: 1,
  });
  const a = {
    version: 1 as const,
    maxEntries: 1,
    maxBytes: 10,
    generation: 1,
    entries: [entry("a", 0)],
  };
  const b = { ...a, entries: [entry("b", 1)] };
  expect(reduceMapMemo({ fan: a }, { fan: b })).toEqual(reduceMapMemo({ fan: b }, { fan: a }));
  expect(Object.getOwnPropertyDescriptor(reduceMapMemo({}, JSON.parse(JSON.stringify({ constructor: a }))), "constructor")?.value.entries).toEqual(a.entries);
});
it("validates cached artifacts and corrupt payloads without invoking work again", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "memo-artifact-"));
  const ctx = {
    workspace,
    config: {},
    events: { emit() {} },
    nodeId: "fan[0]",
  } as unknown as NodeRunContext;
  try {
    await writeFile(join(workspace, "result.txt"), "one");
    const artifact = { kind: "artifact", path: "result.txt", mimeType: "text/plain", sizeBytes: 3 };
    const first = createMapMemo({}, task, true)!;
    await first.run({}, async () => artifact, {}, ctx);
    const state = first.delta;
    await rm(join(workspace, "result.txt"));
    const invoke = async () => {
      throw new Error("must not repeat paid work");
    };
    await expect(createMapMemo(state, task, true)!.run({}, invoke, {}, ctx)).rejects.toMatchObject({
      code: "MAP_MEMO_ARTIFACT_INVALID",
    });
    const caches = state.__mapMemo as Record<string, { entries: Array<{ payload: string }> }>;
    caches.fan!.entries[0]!.payload = "null";
    await expect(createMapMemo(state, task, true)!.run({}, invoke, {}, ctx)).rejects.toMatchObject({
      code: "MAP_MEMO_INVALID",
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
it("invalidates explicit versions and never coerces non-JSON results", async () => {
  const ctx = {
    workspace: tmpdir(),
    config: {},
    events: { emit() {} },
  } as unknown as NodeRunContext;
  const first = createMapMemo({}, task, { version: "1" })!;
  await first.run({}, async () => 1, {}, ctx);
  expect(
    await createMapMemo(first.delta, task, { version: "2" })!.run({}, async () => 2, {}, ctx),
  ).toBe(2);
  const next = createMapMemo({}, task, true)!;
  const value = { missing: undefined };
  expect(await next.run({}, async () => value, {}, ctx)).toBe(value);
  expect(next.delta).toEqual({});
});
