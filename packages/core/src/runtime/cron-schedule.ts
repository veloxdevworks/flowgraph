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

/**
 * Why a standard 5-field cron expression (minute hour day-of-month month
 * day-of-week) is invalid, or undefined when it is valid. Fields accept `*`,
 * numbers, ranges `a-b`, lists `a,b`, steps `/n`, and month and weekday names.
 */
export function cronScheduleProblem(schedule: string): string | undefined {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== FIELDS.length || parts[0] === "") {
    return `expected 5 fields (minute hour day-of-month month day-of-week), got ${parts[0] === "" ? 0 : parts.length}`;
  }
  for (const [index, field] of FIELDS.entries()) {
    const problem = fieldProblem(parts[index]!, field);
    if (problem) return problem;
  }
  return undefined;
}

/** True when the runtime's Intl data knows `timeZone` (an IANA name such as "America/Denver", or "UTC"). */
export function isKnownTimeZone(timeZone: string): boolean {
  if (!timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
