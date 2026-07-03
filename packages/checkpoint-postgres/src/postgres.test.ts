import { describe, it, expect } from "vitest";
import { createPostgresCheckpointer } from "./index.js";

const DB = process.env["FLOWGRAPH_TEST_POSTGRES_URL"];

// Live Postgres integration is opt-in via env to keep CI dependency-free.
describe.skipIf(!DB)("postgres checkpointer (integration)", () => {
  it("creates a durable checkpointer and runs setup", async () => {
    const cp = await createPostgresCheckpointer(DB!);
    expect(cp).toBeTruthy();
    expect(typeof cp.put).toBe("function");
  });
});

describe("postgres checkpointer (unit)", () => {
  it("requires a connection string", async () => {
    await expect(createPostgresCheckpointer("")).rejects.toThrow(/connection string/);
  });
});
