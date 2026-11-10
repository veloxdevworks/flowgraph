/**
 * Placement labels (ADR-0020 §6): built-in detection, custom labels with checks, and the
 * effective label set a host advertises.
 */

import { execFile } from "node:child_process";
import { z } from "zod";
import { DurationSchema, PLACEMENT_LABEL_PATTERN } from "@flowgraph/spec";
import { registry } from "../registry.js";
import { CORE_VERSION } from "../version.js";
import { checkBinOnPath } from "../runtime/which.js";
import "../nodes/index.js"; // built-in node types must be registered before we list them

export const RESERVED_LABEL_NAMESPACES = ["os", "arch", "gpu", "flowgraph", "nodeType", "plugin"] as const;

export interface DetectBuiltinLabelsOptions {
  /** Override `process.platform` (tests). */
  platform?: NodeJS.Platform;
  /** Override `process.arch` (tests). */
  arch?: string;
  /** Override core's version (tests). */
  version?: string;
  /** Override the registered node types (tests). Default: every type in the node registry. */
  nodeTypes?: string[];
  /**
   * Loaded plugin names. Core keeps no runtime record of loaded plugins (`imports[].nodes`
   * registers factories without remembering their package), so the host passes them.
   */
  plugins?: string[];
}

export interface DetectGpuOptions extends DetectBuiltinLabelsOptions {
  /** Per-probe timeout; default 2000ms. */
  probeTimeoutMs?: number;
  /** Override the `nvidia-smi` lookup (tests). */
  hasBinary?: (name: string) => Promise<boolean>;
}

function osLabel(platform: string): string {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return platform;
}

function majorMinor(version: string): string {
  const [major = "0", minor = "0"] = version.split(".");
  return `${major}.${minor}`;
}

/** Labels that need no I/O. */
export function detectBuiltinLabelsSync(opts: DetectBuiltinLabelsOptions = {}): string[] {
  const labels = [
    `os:${osLabel(opts.platform ?? process.platform)}`,
    `arch:${opts.arch ?? process.arch}`,
    `flowgraph:${majorMinor(opts.version ?? CORE_VERSION)}`,
  ];
  for (const type of opts.nodeTypes ?? registry.types()) labels.push(`nodeType:${type}`);
  for (const name of opts.plugins ?? []) labels.push(`plugin:${name}`);
  return [...new Set(labels)].filter((l) => PLACEMENT_LABEL_PATTERN.test(l));
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** Sync labels plus best-effort `gpu:` probes. Never throws. */
export async function detectBuiltinLabels(opts: DetectGpuOptions = {}): Promise<string[]> {
  const labels = detectBuiltinLabelsSync(opts);
  try {
    const platform = opts.platform ?? process.platform;
    const arch = opts.arch ?? process.arch;
    const timeout = opts.probeTimeoutMs ?? 2000;
    if (platform === "darwin" && arch === "arm64") labels.push("gpu:apple");
    const has = opts.hasBinary ?? checkBinOnPath;
    if (await withTimeout(has("nvidia-smi"), timeout, false)) labels.push("gpu:nvidia");
  } catch {
    // best effort
  }
  return [...new Set(labels)];
}

// ---------------------------------------------------------------------------
// Custom labels
// ---------------------------------------------------------------------------

export function isReservedLabel(label: string): boolean {
  const ns = label.split(":", 1)[0] ?? "";
  return (RESERVED_LABEL_NAMESPACES as readonly string[]).includes(ns);
}

const CustomLabelEntrySchema = z
  .object({
    check: z.array(z.string()).min(1).optional().describe("argv (no shell); exit 0 means the label holds"),
    every: DurationSchema.optional().describe("Re-check interval (host schedules; default 10m)"),
  })
  .strict();

/**
 * `{ "app:cc5": { check, every } }`. A plain list of labels (`[app:blender]`) is accepted
 * and means "trusted as declared".
 */
export const CustomLabelsConfigSchema = z.preprocess(
  (v) => (Array.isArray(v) ? Object.fromEntries(v.map((l) => [l, {}])) : v),
  z.record(CustomLabelEntrySchema).superRefine((rec, ctx) => {
    for (const label of Object.keys(rec)) {
      if (!PLACEMENT_LABEL_PATTERN.test(label)) {
        ctx.addIssue({ code: "custom", path: [label], message: `Invalid placement label "${label}": use namespace:value, e.g. app:cc5` });
      } else if (isReservedLabel(label)) {
        ctx.addIssue({
          code: "custom",
          path: [label],
          message: `Label "${label}" is in a reserved namespace (${RESERVED_LABEL_NAMESPACES.join(", ")}); those are detected, not declared`,
        });
      }
    }
  }),
);

export type CustomLabelsConfig = Record<string, { check?: string[]; every?: string }>;

export function parseCustomLabels(input: unknown): CustomLabelsConfig {
  return CustomLabelsConfigSchema.parse(input) as CustomLabelsConfig;
}

export interface LabelCheckResult {
  ok: boolean;
  /** ISO timestamp. */
  checkedAt: string;
  error?: string;
}

export interface RunLabelChecksOptions {
  /** Per-check timeout; default 10000. */
  timeoutMs?: number;
  now?: () => Date;
}

function runArgv(argv: string[], timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    if (!cmd) return resolve({ ok: false, error: "empty check command" });
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, killSignal: "SIGKILL" }, (err, _out, stderr) => {
        if (!err) return resolve({ ok: true });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
        if (e.killed) return resolve({ ok: false, error: `check timed out after ${timeoutMs}ms` });
        if (e.code === "ENOENT") return resolve({ ok: false, error: `check command not found: ${cmd}` });
        const tail = String(stderr ?? "").trim().split("\n").pop();
        resolve({
          ok: false,
          error: `check exited ${typeof e.code === "number" ? e.code : "abnormally"}${tail ? `: ${tail.slice(0, 200)}` : ""}`,
        });
      });
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** Run every custom label's check (argv, no shell). Labels without a check are `ok`. */
export async function runLabelChecks(
  config: CustomLabelsConfig,
  opts: RunLabelChecksOptions = {},
): Promise<Record<string, LabelCheckResult>> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const now = opts.now ?? (() => new Date());
  const entries = await Promise.all(
    Object.entries(config).map(async ([label, def]): Promise<[string, LabelCheckResult]> => {
      if (!def.check) return [label, { ok: true, checkedAt: now().toISOString() }];
      const r = await runArgv(def.check, timeoutMs);
      return [label, { ok: r.ok, checkedAt: now().toISOString(), ...(r.error ? { error: r.error } : {}) }];
    }),
  );
  return Object.fromEntries(entries);
}

/** Effective labels: built-in plus custom labels whose check passed (or that have none). */
export function hostLabels(
  builtin: string[],
  custom: CustomLabelsConfig = {},
  checkResults: Record<string, LabelCheckResult> = {},
): string[] {
  const out = [...builtin];
  for (const label of Object.keys(custom)) {
    const r = checkResults[label];
    if (custom[label]!.check && !r?.ok) continue; // a check that has not passed does not count
    out.push(label);
  }
  return [...new Set(out)];
}
