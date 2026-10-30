import { describe, it, expect } from "vitest";
import { isSetupRaceError, retrySetupRace } from "./setup-lock.js";

const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

describe("retrySetupRace", () => {
  it("re-runs setup after a duplicate or already-exists error from an overlapping setup", async () => {
    for (const code of ["23505", "42710", "42P07", "42P06"]) {
      expect(isSetupRaceError(pgError(code))).toBe(true);
      let calls = 0;
      const out = await retrySetupRace(async () => {
        if (++calls === 1) throw pgError(code);
        return "done";
      });
      expect([code, out, calls]).toEqual([code, "done", 2]);
    }
  });

  it("never swallows an unrelated error", async () => {
    for (const err of [pgError("42501"), pgError("57P01"), new Error("boom"), "not an error"]) {
      let calls = 0;
      await expect(
        retrySetupRace(async () => {
          calls++;
          throw err;
        }),
      ).rejects.toBe(err);
      expect(calls).toBe(1);
    }
  });

  it("gives up after its attempts and throws the last race error", async () => {
    let calls = 0;
    const last = pgError("23505");
    await expect(
      retrySetupRace(async () => {
        calls++;
        throw last;
      }, 2),
    ).rejects.toBe(last);
    expect(calls).toBe(2);
  });
});
