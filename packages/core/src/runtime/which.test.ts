import { describe, expect, it } from "vitest";
import { checkBinOnPath, isMissingBinaryError, toolNotFoundMessage } from "./which.js";

describe("checkBinOnPath", () => {
  it("finds a known binary", async () => {
    expect(await checkBinOnPath(process.platform === "win32" ? "cmd" : "sh")).toBe(true);
  });

  it("returns false for a missing binary", async () => {
    expect(await checkBinOnPath("definitely-not-a-real-bin-xyz")).toBe(false);
  });

  it("rejects names that look like shell metacharacters", async () => {
    expect(await checkBinOnPath("go; rm -rf /")).toBe(false);
  });
});

describe("isMissingBinaryError / toolNotFoundMessage", () => {
  it("detects ENOENT", () => {
    const err = Object.assign(new Error("spawn go ENOENT"), { code: "ENOENT" });
    expect(isMissingBinaryError(err)).toBe(true);
    expect(isMissingBinaryError(new Error("command not found"))).toBe(true);
    expect(isMissingBinaryError(new Error("permission denied"))).toBe(false);
  });

  it("formats a message", () => {
    expect(toolNotFoundMessage("go")).toContain("go");
  });
});
