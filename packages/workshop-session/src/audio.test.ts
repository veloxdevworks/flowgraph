import { describe, expect, it } from "vitest";
import { floatToPcm16Base64, resampleToRate } from "./audio.js";

describe("workshop audio helpers", () => {
  it("resamples and encodes pcm16", () => {
    const input = new Float32Array([0, 0.5, -0.5, 1]);
    const out = resampleToRate(input, 48_000, 24_000);
    expect(out.length).toBe(2);
    const b64 = floatToPcm16Base64(out);
    expect(b64.length).toBeGreaterThan(0);
  });
});
