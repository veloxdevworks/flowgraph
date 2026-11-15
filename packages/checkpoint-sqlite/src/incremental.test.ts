import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { openSqliteBackend } from "./index.js";
it.each(["append", "prepend"])(
  "stores growing %s histories and pending writes with near-linear physical growth",
  async (direction) => {
    const backend = await openSqliteBackend({ path: ":memory:", retention: false });
    const saver = backend.checkpointer;
    let config = { configurable: { thread_id: "growth", checkpoint_ns: "" } };
    const values: Array<{ id: number; text: string }> = [];
    let halfway = 0;
    const bytes = () =>
      Number(backend.db.pragma("page_count", { simple: true })) *
      Number(backend.db.pragma("page_size", { simple: true }));
    try {
      for (let n = 0; n < 160; n++) {
        const value = {
          id: n,
          text: Array.from({ length: 16 }, (_, i) =>
            createHash("sha256").update(`${n}:${i}`).digest("hex"),
          ).join(""),
        };
        if (direction === "append") values.push(value);
        else values.unshift(value);
        config = (await saver.put(
          config,
          {
            v: 4,
            id: String(n).padStart(5, "0"),
            ts: new Date().toISOString(),
            channel_values: { messages: [...values] },
            channel_versions: { messages: n },
            versions_seen: {},
          },
          { source: "loop", step: n, parents: {} },
          { messages: n },
        )) as typeof config;
        await saver.putWrites(config, [["messages", [...values]]], `task-${n}`);
        if (n === 79) halfway = bytes();
      }
      const total = bytes();
      console.log(
        `${direction}: 80=${halfway} bytes, 160=${total} bytes, ratio=${(total / halfway).toFixed(2)}`,
      );
      expect(total / halfway).toBeLessThan(2.9);
      expect((await saver.getTuple(config))?.checkpoint.channel_values.messages).toEqual(values);
      const history = [];
      for await (const tuple of saver.list({ configurable: { thread_id: "growth" } }))
        history.push(tuple);
      expect(history).toHaveLength(160);
      for (const tuple of history) {
        const count = Number(tuple.checkpoint.id) + 1;
        const expected =
          direction === "append" ? values.slice(0, count) : values.slice(160 - count);
        expect(tuple.checkpoint.channel_values.messages).toEqual(expected);
        expect(tuple.pendingWrites?.[0]?.[2]).toEqual(expected);
      }
    } finally {
      backend.close();
    }
  },
  30000,
);
