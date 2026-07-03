import pc from "picocolors";
import type { Diagnostic } from "@veloxdevworks/flowgraph-spec";

export function printDiagnostics(diagnostics: Diagnostic[], filePath?: string): void {
  if (diagnostics.length === 0) return;
  for (const d of diagnostics) {
    const location = filePath ? `${filePath}${d.path ? `:${d.path}` : ""}` : d.path ?? "";
    const prefix =
      d.severity === "error"
        ? pc.red("error")
        : d.severity === "warning"
          ? pc.yellow("warning")
          : pc.cyan("info");
    const loc = location ? pc.dim(` (${location})`) : "";
    console.error(`  ${prefix} [${d.code}] ${d.message}${loc}`);
  }
}

export function printBanner(text: string): void {
  console.log(pc.bold(pc.cyan(text)));
}

export function printSuccess(text: string): void {
  console.log(pc.green("✓") + " " + text);
}

export function printError(text: string): void {
  console.error(pc.red("✗") + " " + text);
}

export function printInfo(text: string): void {
  console.log(pc.dim(text));
}

export function printWarning(text: string): void {
  console.log(pc.yellow("⚠") + " " + text);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
