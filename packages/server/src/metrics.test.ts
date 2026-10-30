import { afterEach, describe, expect, it, vi } from "vitest";
import { errorFields, log } from "./metrics.js";

describe("errorFields", () => {
  it("includes message, stack, and cause", () => {
    const cause = new Error("root");
    const err = new Error("outer", { cause });
    const fields = errorFields(err);
    expect(fields.message).toBe("outer");
    expect(fields.stack).toContain("Error: outer");
    expect(fields.cause).toContain("root");
  });

  it("stringifies non-Error values", () => {
    expect(errorFields("boom")).toEqual({ message: "boom" });
  });
});

describe("log level", () => {
  afterEach(() => {
    delete process.env.FLOWGRAPH_LOG_LEVEL;
    vi.restoreAllMocks();
  });

  it("suppresses debug when level is info", () => {
    process.env.FLOWGRAPH_LOG_LEVEL = "info";
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    log("debug", "hidden");
    expect(spy).not.toHaveBeenCalled();
    log("info", "shown");
    expect(spy).toHaveBeenCalled();
  });
});
