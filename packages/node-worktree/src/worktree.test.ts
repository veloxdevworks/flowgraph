import { describe, expect, it } from "vitest";
import { WorktreeWithSchema } from "./index.js";

describe("WorktreeWithSchema", () => {
  it("defaults action to add and accepts remove/status", () => {
    expect(WorktreeWithSchema.parse({ branch: "feat/x", path: "wt" }).action).toBe("add");
    expect(WorktreeWithSchema.safeParse({ action: "remove", path: "wt" }).success).toBe(true);
    expect(WorktreeWithSchema.safeParse({ action: "status" }).success).toBe(true);
  });
});
