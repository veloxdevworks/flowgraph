import { createRequire } from "node:module";

/**
 * Core's own version. `../package.json` resolves from both `src/` (tests) and the
 * bundled `dist/index.js`, because this module sits one level below the package root in each.
 */
function read(): string {
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const CORE_VERSION: string = read();
