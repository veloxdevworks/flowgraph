import { describe, it, expect } from "vitest";
import { createPostgresCheckpointer, openPostgresBackend, PostgresSaver } from "./index.js";

const DB = process.env["FLOWGRAPH_TEST_POSTGRES_URL"];

// Live Postgres integration runs when FLOWGRAPH_TEST_POSTGRES_URL is set (CI sets it).
describe.skipIf(!DB)("postgres checkpointer (integration)", () => {
  it("creates a durable checkpointer and runs setup", async () => {
    const cp = await createPostgresCheckpointer(DB!);
    expect(cp).toBeTruthy();
    expect(typeof cp.put).toBe("function");
    await (cp as unknown as PostgresSaver).end();
  });
});

describe("postgres checkpointer (unit)", () => {
  it("requires a connection string", async () => {
    await expect(createPostgresCheckpointer("")).rejects.toThrow(/connection string/);
  });
  it("openPostgresBackend requires a connection string or pool", async () => {
    await expect(openPostgresBackend({})).rejects.toThrow(/connection string or pool/);
  });
});
