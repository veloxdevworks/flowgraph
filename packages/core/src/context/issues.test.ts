import { describe, it, expect } from "vitest";
import { capIssueLines } from "./issues.js";
import { bytesEstimator as est } from "./estimator.js";

const lines = Array.from({ length: 30 }, (_, i) => `- [warning] CODE_${i}: message ${i} ${"m".repeat(80)}.`);

describe("capIssueLines", () => {
  it("returns the lines unchanged when they fit", () => {
    expect(capIssueLines(lines.slice(0, 2), 1000, est)).toEqual(lines.slice(0, 2));
  });

  it("keeps the newest lines and counts the rest", () => {
    const out = capIssueLines(lines, 200, est);
    expect(est(out.join("\n"))).toBeLessThanOrEqual(200);
    expect(out.at(-1)).toBe(lines.at(-1));
    const kept = out.length - 1;
    expect(out[0]).toBe(`- [${30 - kept} earlier issues were left out to fit the context budget.]`);
    expect(out.slice(1)).toEqual(lines.slice(30 - kept));
  });

  it("cuts a single line that is too long on its own", () => {
    const out = capIssueLines(["x".repeat(4000)], 50, est);
    expect(out).toHaveLength(1);
    expect(est(out[0]!)).toBeLessThanOrEqual(50);
  });

  it("is deterministic", () => {
    expect(capIssueLines(lines, 150, est)).toEqual(capIssueLines(lines, 150, est));
  });
});
