#!/usr/bin/env node
// Reads a tzdata.zi file and rewrites packages/core/src/runtime/time-zones.ts.
// Run by hand after a tzdata release. CI does not run this script.
//
//   node scripts/generate-time-zones.mjs path/to/tzdata.zi
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(root, "packages/core/src/runtime/time-zones.ts");
const abbreviationsPath = join(root, "packages/core/src/runtime/cron-schedule.ts");

/** Abbreviations named by REJECTED_TIME_ZONE_ABBREVIATIONS in cron-schedule.ts. */
export function rejectedTimeZoneAbbreviations(source) {
  const block = source.match(/REJECTED_TIME_ZONE_ABBREVIATIONS = \[([\s\S]*?)\]/);
  if (!block) throw new Error("REJECTED_TIME_ZONE_ABBREVIATIONS was not found in cron-schedule.ts");
  return new Set([...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]));
}

/**
 * Zone and Link names from a tzdata.zi file. `Z`/`Zone` lines contribute the
 * zone. `L`/`Link` lines contribute the target and the link name. Factory and
 * `omit` (the rejected abbreviations) are dropped. Names are sorted.
 */
export function timeZoneNamesFromZi(text, omit) {
  const names = new Set();
  const add = (name) => {
    if (name && name !== "Factory" && !omit.has(name)) names.add(name);
  };
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/#.*$/, "").trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const kind = parts[0];
    if (kind === "Z" || kind === "Zone") add(parts[1]);
    else if (kind === "L" || kind === "Link") {
      add(parts[1]);
      add(parts[2]);
    }
  }
  return [...names].sort();
}

/** Source for time-zones.ts. `version` is the tzdata release, when the file states one. */
export function timeZoneModule(names, version) {
  const release = version ?? "the tzdata release that produced the file";
  const lines = [
    "/**",
    version
      ? ` * IANA time zone names from tzdata ${version}, which is in the public domain.`
      : " * IANA time zone names from tzdata, which is in the public domain.",
    " *",
    " * Refresh by hand, not in CI:",
    " *   node scripts/generate-time-zones.mjs path/to/tzdata.zi",
    " *",
    version
      ? ` * Source: https://data.iana.org/time-zones/releases/tzdata${version}.tar.gz`
      : " * Source: a tzdata release tarball.",
    " * `tzdata.zi` is the text file from `make tzdata.zi` in that release.",
    " * The script keeps Zone and Link names and drops Factory and the abbreviations",
    " * listed in cron-schedule.ts. UTC and GMT stay. backzone is not part of that file.",
    ` * This list was generated from ${release}.`,
    " */",
    "export const TIME_ZONE_NAMES: readonly string[] = [",
    ...names.map((name) => `  ${JSON.stringify(name)},`),
    "];",
    "",
  ];
  return lines.join("\n");
}

function main() {
  const zi = process.argv[2];
  if (!zi) {
    console.error("usage: node scripts/generate-time-zones.mjs path/to/tzdata.zi");
    process.exit(1);
  }
  const text = readFileSync(resolve(zi), "utf8");
  const omit = rejectedTimeZoneAbbreviations(readFileSync(abbreviationsPath, "utf8"));
  const version = text.match(/^#\s*version\s+(\S+)/m)?.[1];
  const names = timeZoneNamesFromZi(text, omit);
  writeFileSync(outputPath, timeZoneModule(names, version));
  console.log(`${names.length} time zones written to ${outputPath}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
