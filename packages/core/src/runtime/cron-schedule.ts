/**
 * Offline checks for cron trigger schedules and time zones. The engine does
 * not schedule triggers; these only reject values a host could not run.
 */

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
 * IANA names `Intl.supportedValuesOf("timeZone")` often leaves out, spelled
 * in their own case. `GMT` is accepted on its own, the same zone as `Etc/GMT`.
 */
const TIME_ZONE_LINKS = [
  "UTC",
  "GMT",
  "Etc/UTC",
  "Etc/GMT",
  "Etc/GMT0",
  "Etc/GMT+0",
  "Etc/GMT-0",
  "Asia/Kolkata",
  "Europe/Kyiv",
  "US/Mountain",
  "America/Nuuk",
  "Asia/Ho_Chi_Minh",
  "America/Argentina/Buenos_Aires",
  ...Array.from({ length: 14 }, (_, index) => [`Etc/GMT+${index + 1}`, `Etc/GMT-${index + 1}`]).flat(),
];

let timeZoneNames: ReadonlySet<string> | undefined;

function knownTimeZoneNames(): ReadonlySet<string> {
  if (timeZoneNames) return timeZoneNames;
  const names = new Set<string>(TIME_ZONE_LINKS);
  try {
    for (const name of Intl.supportedValuesOf("timeZone")) names.add(name);
  } catch {
    // A runtime without this list still accepts the link names above.
  }
  timeZoneNames = names;
  return names;
}

/**
 * True when `timeZone` is an exact IANA name this runtime knows, such as
 * "America/Denver", "Asia/Kolkata", "Etc/GMT+5", "GMT" or "UTC". The check is
 * the name itself against `Intl.supportedValuesOf("timeZone")` plus the link
 * names above, so a different letter case ("Asia/KOLKATA", "Etc/Utc") is
 * rejected. Abbreviations ("EST") and offsets ("+05:00") are rejected.
 */
export function isKnownTimeZone(timeZone: string): boolean {
  if (!knownTimeZoneNames().has(timeZone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
