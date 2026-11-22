import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TIME_ZONE_NAMES } from "./time-zones.js";
import { rejectedTimeZoneAbbreviations, timeZoneModule, timeZoneNamesFromZi } from "../../../../scripts/generate-time-zones.mjs";

const abbreviations = rejectedTimeZoneAbbreviations(
  readFileSync(resolve(import.meta.dirname, "cron-schedule.ts"), "utf8"),
);

describe("time zone list generator", () => {
  it("reads Zone and Link names from a tzdata.zi file and drops Factory and abbreviations", () => {
    const zi = [
      "# version 2026f",
      "Z Africa/Abidjan 0 - GMT",
      "L Africa/Abidjan Africa/Timbuktu",
      "L Europe/Paris CET",
      "Z Factory 0 - GMT",
      "L Etc/UTC UTC",
      "L Etc/GMT GMT",
      "",
    ].join("\n");
    expect(timeZoneNamesFromZi(zi, abbreviations)).toEqual([
      "Africa/Abidjan",
      "Africa/Timbuktu",
      "Etc/GMT",
      "Etc/UTC",
      "Europe/Paris",
      "GMT",
      "UTC",
    ]);
    expect(timeZoneNamesFromZi(zi, abbreviations)).not.toContain("CET");
    expect(timeZoneNamesFromZi(zi, abbreviations)).not.toContain("Factory");
  });

  it("writes a header that says how to refresh the list", () => {
    const source = timeZoneModule(["UTC"], "2026f");
    expect(source).toContain("node scripts/generate-time-zones.mjs path/to/tzdata.zi");
    expect(source).toContain("Refresh by hand, not in CI");
    expect(source).toContain('"UTC"');
  });

  it("keeps the checked-in names inside the abbreviation rules", () => {
    for (const name of TIME_ZONE_NAMES) {
      expect(abbreviations.has(name)).toBe(false);
      expect(name).not.toBe("Factory");
    }
    expect(TIME_ZONE_NAMES).toContain("UTC");
    expect(TIME_ZONE_NAMES).toContain("GMT");
  });
});
