import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INHERITED_ENV, pickHostEnv } from "./child-env.js";

afterEach(() => vi.unstubAllEnvs());

describe("DEFAULT_INHERITED_ENV", () => {
  it("includes operational path and locale names and excludes identity and secret-like names", () => {
    const names = new Set<string>(DEFAULT_INHERITED_ENV);
    for (const required of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SystemRoot", "WINDIR"]) {
      expect(names.has(required)).toBe(true);
    }
    expect(names.has("USER")).toBe(false);
    expect(names.has("SHELL")).toBe(false);
    for (const name of names) {
      expect(name).not.toMatch(/key|token|secret|password|credential|auth/i);
    }
  });
});

describe("pickHostEnv", () => {
  it("copies only names that are present and skips a missing decoy", () => {
    vi.stubEnv("HOME", "/tmp/fgqa-home");
    vi.stubEnv("TMPDIR", "/tmp/fgqa-tmpdir");
    vi.stubEnv("FGQA_DECOY", "decoy-only");
    const env = pickHostEnv(["HOME", "TMPDIR", "FGQA_DECOY_ABSENT"]);
    expect(env.HOME).toBe("/tmp/fgqa-home");
    expect(env.TMPDIR).toBe("/tmp/fgqa-tmpdir");
    expect(Object.hasOwn(env, "FGQA_DECOY_ABSENT")).toBe(false);
    expect(Object.hasOwn(env, "FGQA_DECOY")).toBe(false);
  });
});
