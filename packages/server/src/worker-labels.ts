/**
 * Worker placement labels (ADR-0020 §6): the custom labels an operator declares for this server,
 * their periodic checks, and the labels the server advertises on `GET /worker/labels`.
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  CORE_VERSION,
  detectBuiltinLabels,
  hostLabels,
  parseCustomLabels,
  parseDuration,
  runLabelChecks,
  type CustomLabelsConfig,
  type LabelCheckResult,
} from "@flowgraph/core";
import { errorFields, log } from "./metrics.js";

export const DEFAULT_LABEL_CHECK_INTERVAL_MS = 10 * 60_000;

export interface WorkerLabelsResponse {
  labels: string[];
  checks: Record<string, LabelCheckResult>;
  flowgraphVersion: string;
}

function describeError(err: unknown): string {
  const issues = (err as { issues?: Array<{ path: Array<string | number>; message: string }> }).issues;
  if (Array.isArray(issues)) return issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
  return err instanceof Error ? err.message : String(err);
}

/**
 * Custom labels from `FLOWGRAPH_WORKER_LABELS` (comma-separated, trusted) and
 * `FLOWGRAPH_WORKER_LABELS_FILE` (YAML/JSON: `{ "app:cc5": { check, every } }`, optionally under a
 * top-level `labels:` key, or a plain list). Throws a clear message on invalid config.
 */
export function workerLabelsFromEnv(env: NodeJS.ProcessEnv): CustomLabelsConfig | undefined {
  const merged: CustomLabelsConfig = {};
  const inline = (env.FLOWGRAPH_WORKER_LABELS ?? "").split(",").map((l) => l.trim()).filter(Boolean);
  if (inline.length) {
    try {
      Object.assign(merged, parseCustomLabels(inline));
    } catch (err) {
      throw new Error(`FLOWGRAPH_WORKER_LABELS: ${describeError(err)}`);
    }
  }
  const file = env.FLOWGRAPH_WORKER_LABELS_FILE?.trim();
  if (file) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      throw new Error(`FLOWGRAPH_WORKER_LABELS_FILE: cannot read "${file}": ${(err as Error).message}`);
    }
    try {
      let doc: unknown = parseYaml(raw) ?? {};
      if (doc && typeof doc === "object" && !Array.isArray(doc) && "labels" in doc) doc = (doc as { labels: unknown }).labels ?? {};
      Object.assign(merged, parseCustomLabels(doc)); // the file's entries (with checks) win over bare env labels
    } catch (err) {
      throw new Error(`FLOWGRAPH_WORKER_LABELS_FILE "${file}": ${describeError(err)}`);
    }
  }
  return Object.keys(merged).length ? merged : undefined;
}

export interface WorkerLabelManagerOptions {
  custom?: CustomLabelsConfig | undefined;
  /** Per-check timeout (default 10s). */
  checkTimeoutMs?: number | undefined;
  /** Built-in label detection override (tests). */
  detect?: () => Promise<string[]>;
}

/** Holds the host's labels and the latest check results; re-runs checked labels on their `every`. */
export class WorkerLabelManager {
  private builtin: string[] = [];
  private results: Record<string, LabelCheckResult> = {};
  private timers: NodeJS.Timeout[] = [];
  private started: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly opts: WorkerLabelManagerOptions = {}) {}

  private get custom(): CustomLabelsConfig {
    return this.opts.custom ?? {};
  }

  /** Detect built-in labels, run every check once, then schedule re-checks. Idempotent. */
  start(): Promise<void> {
    this.started ??= this.init();
    return this.started;
  }

  private async init(): Promise<void> {
    const [builtin, results] = await Promise.all([
      (this.opts.detect ?? (() => detectBuiltinLabels()))().catch((err: unknown) => {
        log("warn", "worker-labels.builtin.failed", errorFields(err));
        return [] as string[];
      }),
      runLabelChecks(this.custom, { timeoutMs: this.opts.checkTimeoutMs ?? 10_000 }),
    ]);
    this.builtin = builtin;
    this.results = results;
    for (const [label, r] of Object.entries(results)) {
      if (!r.ok) log("warn", "worker-labels.check.failed", { label, error: r.error });
    }
    if (this.stopped) return;
    for (const [label, def] of Object.entries(this.custom)) {
      if (!def.check) continue;
      const every = def.every ? parseDuration(def.every) : DEFAULT_LABEL_CHECK_INTERVAL_MS;
      let running = false;
      const timer = setInterval(() => {
        if (running || this.stopped) return;
        running = true;
        void runLabelChecks({ [label]: def }, { timeoutMs: this.opts.checkTimeoutMs ?? 10_000 })
          .then((r) => {
            if (!this.stopped) Object.assign(this.results, r);
          })
          .catch((err: unknown) => log("warn", "worker-labels.recheck.failed", { label, ...errorFields(err) }))
          .finally(() => {
            running = false;
          });
      }, every);
      timer.unref();
      this.timers.push(timer);
    }
  }

  /** Cancel re-check timers. Safe to call more than once. */
  stop(): void {
    this.stopped = true;
    for (const t of this.timers.splice(0)) clearInterval(t);
  }

  get timerCount(): number {
    return this.timers.length;
  }

  async snapshot(): Promise<WorkerLabelsResponse> {
    await this.start();
    return {
      labels: hostLabels(this.builtin, this.custom, this.results),
      checks: { ...this.results },
      flowgraphVersion: CORE_VERSION,
    };
  }
}
