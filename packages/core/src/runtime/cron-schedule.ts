/**
 * Offline checks for cron trigger schedules and time zones. The engine does
 * not schedule triggers; these only reject values a host could not run.
 */

import { TIME_ZONE_NAMES } from "./time-zones.js";

export { TIME_ZONE_NAMES } from "./time-zones.js";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

interface CronField {
  name: string;
  min: number;
  max: number;
  /** Three-letter names; index 0 is `min`. */
  names?: string[];
}

const FIELDS: CronField[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS },
  // 0 and 7 are both Sunday.
  { name: "day of week", min: 0, max: 7, names: DAYS },
];

function fieldValue(text: string, field: CronField): number | undefined {
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n >= field.min && n <= field.max ? n : undefined;
  }
  const index = field.names?.indexOf(text.toUpperCase()) ?? -1;
  return index >= 0 ? field.min + index : undefined;
}

function fieldProblem(text: string, field: CronField): string | undefined {
  for (const item of text.split(",")) {
    const [range, step, extra] = item.split("/");
    if (extra !== undefined || range === undefined || range === "") return `${field.name} "${text}" is not valid`;
    if (step !== undefined && !/^[1-9]\d*$/.test(step)) return `${field.name} step "${step}" must be a positive whole number`;
    if (range === "*") continue;
    const [from, to, more] = range.split("-");
    if (more !== undefined) return `${field.name} "${item}" is not valid`;
    const start = fieldValue(from ?? "", field);
    if (start === undefined) return `${field.name} "${from}" is out of range (${field.min}-${field.max})`;
    if (to === undefined) continue;
    const end = fieldValue(to, field);
    if (end === undefined) return `${field.name} "${to}" is out of range (${field.min}-${field.max})`;
    if (end < start) return `${field.name} range "${range}" runs backwards`;
  }
  return undefined;
}

const SECONDS: CronField = { name: "second", min: 0, max: 59 };

const MACROS = new Set(["@yearly", "@annually", "@monthly", "@weekly", "@daily", "@hourly"]);

/**
 * Why a cron expression is invalid, or undefined when it is valid. Accepts the
 * five standard fields (minute hour day-of-month month day-of-week), an
 * optional leading seconds field, or one of the macros `@yearly`,
 * `@annually`, `@monthly`, `@weekly`, `@daily` and `@hourly`. Fields accept
 * `*`, numbers, ranges `a-b`, lists `a,b`, steps `/n`, and month and weekday names.
 */
export function cronScheduleProblem(schedule: string): string | undefined {
  const trimmed = schedule.trim();
  if (trimmed.startsWith("@")) {
    return MACROS.has(trimmed) ? undefined : `unknown macro "${trimmed}"; use one of ${[...MACROS].join(", ")}`;
  }
  const parts = trimmed === "" ? [] : trimmed.split(/\s+/);
  const fields = parts.length === FIELDS.length + 1 ? [SECONDS, ...FIELDS] : FIELDS;
  if (parts.length !== fields.length) {
    return `expected 5 fields (minute hour day-of-month month day-of-week), or 6 with leading seconds, got ${parts.length}`;
  }
  for (const [index, field] of fields.entries()) {
    const problem = fieldProblem(parts[index]!, field);
    if (problem) return problem;
  }
  return undefined;
}

/**
 * Abbreviations a cron timezone cannot use. Some engines accept them, and
 * tzdata links CET, EET, EST, HST, MET, MST, and WET, but they are not
 * Area/Location names. `UTC` and `GMT` are not in this list.
 */
export const REJECTED_TIME_ZONE_ABBREVIATIONS = [
  "ADT",
  "AEDT",
  "AEST",
  "AKDT",
  "AKST",
  "AST",
  "BST",
  "CDT",
  "CEST",
  "CET",
  "CST",
  "EDT",
  "EET",
  "EEST",
  "EST",
  "HST",
  "IST",
  "JST",
  "KST",
  "MDT",
  "MET",
  "MST",
  "PDT",
  "PST",
  "WEST",
  "WET",
] as const;

const REJECTED_TIME_ZONES = new Set<string>(REJECTED_TIME_ZONE_ABBREVIATIONS);
const KNOWN_TIME_ZONES = new Set<string>(TIME_ZONE_NAMES);

/**
 * True when `timeZone` is a tzdata Zone or Link name in its own case and
 * `Intl.DateTimeFormat` accepts it. `UTC` and `GMT` are in that set. A
 * different letter case ("Asia/KOLKATA", "Etc/Utc"), an abbreviation
 * ("EST", "CET", "MST"), and an offset ("+05:00") are rejected.
 */
export function isKnownTimeZone(timeZone: string): boolean {
  if (REJECTED_TIME_ZONES.has(timeZone) || !KNOWN_TIME_ZONES.has(timeZone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
