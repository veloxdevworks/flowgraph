import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { describeThreadOwnerRegistryConformance } from "@flowgraph/testing/thread-owner-conformance";
import { openPostgresBackend, createPostgresThreadOwnerRegistry } from "./index.js";

const DB = process.env["FLOWGRAPH_TEST_POSTGRES_URL"];

const schemas: string[] = [];
let admin: pg.Pool | undefined;
function freshSchema(): string {
  const s = `fgo_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  schemas.push(s);
  return s;
}
afterAll(async () => {
  if (!admin) return;
  for (const s of schemas) await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  await admin.end();
});

describe.skipIf(!DB)("postgres thread owners (integration)", () => {
  beforeAll(() => {
    admin = new pg.Pool({ connectionString: DB, max: 2 });
  });

  describeThreadOwnerRegistryConformance("postgres", async () => {
    const schema = freshSchema();
    const pools = [new pg.Pool({ connectionString: DB, max: 4 })];
    return {
      registry: await createPostgresThreadOwnerRegistry(pools[0]!, { schema }),
      other: async () => {
        const p = new pg.Pool({ connectionString: DB, max: 4 });
        pools.push(p);
        return createPostgresThreadOwnerRegistry(p, { schema });
      },
      cleanup: async () => {
        for (const p of pools) await p.end();
      },
    };
  });

  it("openPostgresBackend exposes the thread-owner registry in its schema, shared across hosts", async () => {
    const schema = freshSchema();
    const a = await openPostgresBackend({ connectionString: DB!, schema });
    const b = await openPostgresBackend({ connectionString: DB!, schema });
    try {
      expect((await a.threadOwners.claim("t1", "iss|alice", "acme")).created).toBe(true);
      expect(await b.threadOwners.claim("t1", "iss|bob", "acme")).toMatchObject({ owner: "iss|alice", created: false });
      expect((await b.threadOwners.get("t1"))?.owner).toBe("iss|alice");
    } finally {
      await a.close();
      await b.close();
    }
  });
});
