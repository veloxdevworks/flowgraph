/**
 * Load `.env` from the graph working directory into process.env.
 * Does not override variables already set in the shell.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export function loadDotenvFromCwd(cwd: string): void {
  const file = path.join(cwd, ".env");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return;
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}
