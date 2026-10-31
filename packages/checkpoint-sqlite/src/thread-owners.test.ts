import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describeThreadOwnerRegistryConformance } from "@flowgraph/testing/thread-owner-conformance";
import { openSqliteBackend } from "./index.js";
import { createSqliteThreadOwnerRegistry, openDatabase } from "./memory.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describeThreadOwnerRegistryConformance("sqlite", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-owners-"));
  const file = path.join(dir, "owners.db");
  const dbs = [openDatabase(file)];
  return {
    registry: createSqliteThreadOwnerRegistry(dbs[0]!),
    other: async () => {
      const db = openDatabase(file);
      dbs.push(db);
      return createSqliteThreadOwnerRegistry(db);
    },
    cleanup: () => {
      for (const db of dbs) db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
});

describe("sqlite backend thread owners", () => {
  it("openSqliteBackend keeps thread owners in the same file across reopen", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-owners-open-"));
    dirs.push(dir);
    const file = path.join(dir, "checkpoints.db");
    const a = await openSqliteBackend(file);
    expect((await a.threadOwners.claim("t1", "iss|alice", "acme")).created).toBe(true);
    a.close();
    const b = await openSqliteBackend(file);
    try {
      expect(await b.threadOwners.claim("t1", "iss|bob", "acme")).toMatchObject({ owner: "iss|alice", created: false });
      expect(b.db.prepare(`SELECT MAX(version) AS v FROM fg_schema_migrations WHERE component='memory'`).get()).toEqual({ v: 5 });
    } finally {
      b.close();
    }
  });
});
