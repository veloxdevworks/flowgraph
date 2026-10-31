/**
 * Shared cases for thread-owner registries (who started each thread id).
 * Every implementation (in-memory, sqlite, postgres) runs the same suite.
 */
import { describe, expect, it } from "vitest";
import type { ThreadOwnerRegistry } from "@flowgraph/core";

export interface ThreadOwnerRegistryHarness {
  registry: ThreadOwnerRegistry;
  cleanup?: () => void | Promise<void>;
  /** A second handle on the same storage (another host); durable registries only. */
  other?: () => Promise<ThreadOwnerRegistry>;
}

/** Shared cases for thread-owner registries: the first principal to claim a thread id owns it. */
export function describeThreadOwnerRegistryConformance(name: string, make: () => Promise<ThreadOwnerRegistryHarness>): void {
  const withRegistry = (fn: (r: ThreadOwnerRegistry, h: ThreadOwnerRegistryHarness) => Promise<void>) => async () => {
    const h = await make();
    try {
      await fn(h.registry, h);
    } finally {
      await h.cleanup?.();
    }
  };

  describe(`thread owner registry conformance: ${name}`, () => {
    it("the first claim owns a thread; later claims see that owner", withRegistry(async (r) => {
      expect(await r.get("t1")).toBeUndefined();
      const a = await r.claim("t1", "iss|alice", "acme", 1_000);
      expect(a).toEqual({ threadId: "t1", owner: "iss|alice", org: "acme", createdAt: 1_000, created: true });
      expect(await r.claim("t1", "iss|alice", "acme", 2_000)).toMatchObject({ owner: "iss|alice", created: false, createdAt: 1_000 });
      expect(await r.claim("t1", "iss|bob", "globex", 3_000)).toMatchObject({ owner: "iss|alice", org: "acme", created: false });
      expect(await r.get("t1")).toEqual({ threadId: "t1", owner: "iss|alice", org: "acme", createdAt: 1_000 });
    }));

    it("thread ids are exact: no case folding or character replacement", withRegistry(async (r) => {
      await r.claim("a/b", "iss|alice", "acme");
      expect((await r.claim("a_b", "iss|bob", "acme")).owner).toBe("iss|bob");
      expect((await r.claim("A/b", "iss|bob", "acme")).owner).toBe("iss|bob");
      expect((await r.get("a/b"))?.owner).toBe("iss|alice");
    }));

    it("accepts an empty org", withRegistry(async (r) => {
      expect(await r.claim("t-noorg", "iss|alice", "")).toMatchObject({ org: "", created: true });
    }));

    it("concurrent claims agree on one owner, across hosts when durable", withRegistry(async (r, h) => {
      const others = h.other ? await Promise.all([h.other(), h.other()]) : [r, r];
      const all = [r, ...others];
      const claims = await Promise.all(Array.from({ length: 12 }, (_, i) => all[i % all.length]!.claim("race", `iss|u${i}`, "acme")));
      expect(new Set(claims.map((c) => c.owner)).size).toBe(1);
      expect(claims.filter((c) => c.created)).toHaveLength(1);
      if (h.other) expect((await (await h.other()).get("race"))?.owner).toBe(claims[0]!.owner);
    }));

    it("rejects empty or unstorable arguments", withRegistry(async (r) => {
      await expect(r.claim("", "o", "acme")).rejects.toMatchObject({ code: "MEMORY_THREAD_OWNER_INVALID" });
      await expect(r.claim("t", "", "acme")).rejects.toMatchObject({ code: "MEMORY_THREAD_OWNER_INVALID" });
      await expect(r.get("")).rejects.toMatchObject({ code: "MEMORY_THREAD_OWNER_INVALID" });
      await expect(r.claim("t\u0000x", "o", "acme")).rejects.toMatchObject({ code: "MEMORY_NUL_CHARACTER" });
    }));
  });
}
