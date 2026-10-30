/** Lightweight structured logging / metrics for the hosted run server. */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const STACK_CAP = 8_000;

function configuredLogLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const v = env.FLOWGRAPH_LOG_LEVEL?.trim().toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  return "info";
}

function cap(text: string): string {
  if (text.length <= STACK_CAP) return text;
  return `${text.slice(0, STACK_CAP)}…`;
}

/** Fields for logs only — never put `stack` / `cause` in HTTP JSON bodies. */
export function errorFields(err: unknown): { message: string; stack?: string; cause?: string } {
  if (!(err instanceof Error)) {
    return { message: String(err) };
  }
  const fields: { message: string; stack?: string; cause?: string } = {
    message: err.message,
  };
  if (err.stack) fields.stack = cap(err.stack);
  if (err.cause !== undefined) {
    const cause = err.cause;
    fields.cause = cap(cause instanceof Error ? (cause.stack ?? cause.message) : String(cause));
  }
  return fields;
}

export function log(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[configuredLogLevel()]) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...fields,
  });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export interface RunMetrics {
  runsStarted: number;
  runsCompleted: number;
  runsInterrupted: number;
  runsFailed: number;
  runsCancelled: number;
}

export function createMetrics(): RunMetrics & {
  recordStart(): void;
  recordResult(status: string): void;
  snapshot(): RunMetrics;
} {
  const m: RunMetrics = {
    runsStarted: 0,
    runsCompleted: 0,
    runsInterrupted: 0,
    runsFailed: 0,
    runsCancelled: 0,
  };
  return {
    ...m,
    recordStart() {
      m.runsStarted++;
      this.runsStarted = m.runsStarted;
    },
    recordResult(status: string) {
      if (status === "completed") {
        m.runsCompleted++;
        this.runsCompleted = m.runsCompleted;
      } else if (status === "interrupted") {
        m.runsInterrupted++;
        this.runsInterrupted = m.runsInterrupted;
      } else if (status === "error" || status === "failed") {
        m.runsFailed++;
        this.runsFailed = m.runsFailed;
      } else if (status === "cancelled" || status === "aborted") {
        m.runsCancelled++;
        this.runsCancelled = m.runsCancelled;
      }
    },
    snapshot() {
      return { ...m };
    },
  };
}
