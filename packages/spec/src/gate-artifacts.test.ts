import { describe, expect, it } from "vitest";
import { HitlWithSchema } from "./schema.js";

describe("gate artifact review schemas", () => {
  it("hitl accepts select none/one/many and rejects anything else", () => {
    for (const select of ["none", "one", "many"]) {
      expect(HitlWithSchema.safeParse({ message: "m", select }).success).toBe(true);
    }
    expect(HitlWithSchema.safeParse({ message: "m", select: "all" }).success).toBe(false);
    expect(HitlWithSchema.parse({ message: "m" }).select).toBeUndefined();
  });
});
