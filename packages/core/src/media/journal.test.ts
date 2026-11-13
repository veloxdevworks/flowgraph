import { describe, expect, it } from "vitest";
import { fingerprintRequest } from "./journal.js";
import type { MediaRequest } from "./types.js";

const REQ: MediaRequest = {
  modality: "image",
  model: "m-1",
  prompt: "a small lighthouse, painterly",
  inputs: [{ identity: "sha256:abc" } as MediaRequest["inputs"][number]],
  count: 2,
  size: "1024x1024",
  seed: 7,
  params: { b: 1, a: { d: 2, c: 3 } },
};

describe("fingerprintRequest", () => {
  it("is byte-identical to the pre-variant fingerprint when no variant is given", () => {
    // Computed with the code as it was BEFORE `variant` existed. If this changes,
    // every in-flight journal entry misses and a resumed run re-submits paid jobs.
    expect(fingerprintRequest("art", REQ, 0)).toBe("5c5a044b5d64437f");
    expect(fingerprintRequest("art", REQ, 0, undefined)).toBe("5c5a044b5d64437f");
    expect(fingerprintRequest("art", REQ, 0, null)).toBe("5c5a044b5d64437f");
    expect(fingerprintRequest("art", REQ, 0, "")).toBe("5c5a044b5d64437f");
  });

  it("changes with a variant, and differs per variant value", () => {
    const base = fingerprintRequest("art", REQ, 0);
    const v1 = fingerprintRequest("art", REQ, 0, "1");
    const v2 = fingerprintRequest("art", REQ, 0, "2");
    expect(v1).not.toBe(base);
    expect(v2).not.toBe(base);
    expect(v1).not.toBe(v2);
    expect(fingerprintRequest("art", REQ, 0, 1)).toBe(v1);
  });
});
