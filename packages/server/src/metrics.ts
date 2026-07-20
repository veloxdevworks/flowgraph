/** Lightweight structured logging / metrics for the hosted run server. */

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogFields {
  [key: string]: unknown;
}

export function log(level: LogLevel, message: string, fields: LogFields = {}): void {
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
      } else if (status === "cancelled") {
        m.runsCancelled++;
        this.runsCancelled = m.runsCancelled;
      }
    },
    snapshot() {
      return { ...m };
    },
  };
}
