import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { GraphSpec } from "@flowgraph/spec";
import type { CompileOptions, InterruptInfo, MemoryIdentity } from "@flowgraph/core";
import { resolveMemoryIdentity } from "./memory-identity.js";
import { printInfo } from "./ui.js";
import { lazyOptionalImport } from "./optional-deps.js";

const loadCheckpointSqlite = lazyOptionalImport<typeof import("@flowgraph/checkpoint-sqlite")>(
  "@flowgraph/checkpoint-sqlite",
  "Install it: pnpm add @flowgraph/checkpoint-sqlite",
);

const loadCheckpointPostgres = lazyOptionalImport<typeof import("@flowgraph/checkpoint-postgres")>(
  "@flowgraph/checkpoint-postgres",
  "Install it: pnpm add @flowgraph/checkpoint-postgres",
);

/** Checkpoint backends whose database the CLI can also keep memory in. */
export const CLI_MEMORY_BACKENDS = ["sqlite"] as const;

export interface CheckpointerOptionExtras {
  /** Directory the memory project is resolved from (git origin, .flowgraph/config.yaml). */
  cwd?: string;
  /** Resolve (org, project, user) for memory. Defaults to resolveMemoryIdentity(). */
  identity?: () => MemoryIdentity;
  /** Called with the identity notice (e.g. no git origin) when memory is used. */
  onNotice?: (msg: string) => void;
}

/**
 * Build a durable checkpointer for CLI runs based on the graph's runtime config.
 * sqlite → persistent file, which also holds runtime.memory / durable ctx.store;
 * postgres → DATABASE_URL / connectionString (no memory yet).
 */
export async function checkpointerOption(
  spec: GraphSpec,
  extras: CheckpointerOptionExtras = {},
): Promise<Pick<CompileOptions, "checkpointer" | "memory">> {
  const ck = spec.runtime?.checkpoint;
  if (ck?.enabled === false) return { checkpointer: "none" };
  if (ck?.backend === "sqlite") {
    const checkpoint = await loadCheckpointSqlite();
    const dbPath = ck.path ?? ".flowgraph/checkpoints.db";
    if (!usesDurableMemory(spec)) return { checkpointer: checkpoint.createSqliteCheckpointer(dbPath) };
    const sqlite = await checkpoint.openSqliteBackend(dbPath);
    let identity: MemoryIdentity;
    if (extras.identity) identity = extras.identity();
    else {
      const resolved = resolveMemoryIdentity(extras.cwd ? { cwd: extras.cwd } : {});
      if (resolved.notice) (extras.onNotice ?? printInfo)(resolved.notice);
      identity = { org: resolved.org, project: resolved.project, ...(resolved.user ? { user: resolved.user } : {}) };
    }
    return { checkpointer: sqlite.checkpointer, memory: { backend: sqlite.memory, identity } };
  }
  if (ck?.backend === "postgres") {
    const checkpoint = await loadCheckpointPostgres();
    const connectionString =
      ck.path ??
      process.env["DATABASE_URL"] ??
      process.env["FLOWGRAPH_DATABASE_URL"];
    if (!connectionString) {
      throw new Error(
        "runtime.checkpoint.backend is postgres but no connection string was set. " +
          "Pass runtime.checkpoint.path or set DATABASE_URL.",
      );
    }
    return { checkpointer: await checkpoint.createPostgresCheckpointer(connectionString) };
  }
  return {};
}

/** True when the graph keeps memory in the checkpoint database. */
function usesDurableMemory(spec: GraphSpec): boolean {
  const mem = spec.runtime?.memory;
  if (mem) return (mem.backend ?? "checkpoint") === "checkpoint";
  const st = spec.runtime?.store;
  return !!st && st.enabled !== false && (st.backend === "sqlite" || st.backend === "postgres");
}

function interruptData(it: InterruptInfo): Record<string, unknown> | undefined {
  const payload = it.payload;
  if (!payload || typeof payload !== "object") return undefined;
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  return data as Record<string, unknown>;
}

/** Prompt text shown before collecting an interrupt answer. */
export function formatInterruptPrompt(it: InterruptInfo): string {
  const body = formatInterruptBody(it);
  if (!it.validationError) return body;
  const budget = it.maxAttempts ? ` (attempt ${it.attempt ?? "?"} of ${it.maxAttempts})` : "";
  return `Previous answer rejected${budget}: ${it.validationError}\n${body}`;
}

function formatInterruptBody(it: InterruptInfo): string {
  const kind = it.kind ?? "approval";
  const reason = it.reason ?? it.id;
  const data = interruptData(it);

  if (kind === "question") {
    return `${reason}\nYour answer: `;
  }

  if (kind === "choice" && it.choices?.length) {
    const lines = it.choices.map((c, i) => `  ${i + 1}. ${c}`).join("\n");
    return `${reason}\n${lines}\nEnter choice (number or text): `;
  }

  if (kind === "form") {
    const schema = data?.["schema"];
    const hint = schema ? `\nJSON Schema: ${JSON.stringify(schema)}` : "";
    return `${reason}${hint}\nPaste JSON form values: `;
  }

  if (kind === "review") {
    const stat = typeof data?.["diffStat"] === "string" ? `\n${data["diffStat"]}` : "";
    const artifacts = Array.isArray(data?.["artifactRefs"])
      ? `\nArtifacts: ${(data["artifactRefs"] as string[]).join(", ")}`
      : "";
    const decisions = Array.isArray(data?.["decision"])
      ? (data["decision"] as string[]).join(", ")
      : "approve, request-changes";
    return `${reason}${stat}${artifacts}\nDecision (${decisions}) or JSON { "decision", "feedback" }: `;
  }

  if (kind === "workshop") {
    const agenda = Array.isArray(data?.["agenda"])
      ? (data["agenda"] as Array<{ title?: string } | string>)
          .map((item, i) => {
            const title = typeof item === "string" ? item : String(item?.title ?? `item ${i + 1}`);
            return `  ${i + 1}. ${title}`;
          })
          .join("\n")
      : "";
    const schema = data?.["schema"];
    const hint = schema ? `\nJSON Schema: ${JSON.stringify(schema)}` : "";
    const agendaBlock = agenda ? `\nAgenda:\n${agenda}` : "";
    return `${reason}${agendaBlock}${hint}\nPaste JSON { "output", "transcript?", "coverage?", "endedReason?" } or the output object: `;
  }

  const tool = typeof data?.["tool"] === "string" ? data["tool"] : undefined;
  if (tool) {
    const args = data?.["args"] !== undefined ? ` ${JSON.stringify(data["args"])}` : "";
    return `Interrupt: ${reason}\nTool: ${tool}${args}\nApprove? (yes/no, or JSON resume value): `;
  }

  return `Interrupt: ${reason}\nApprove? (yes/no, or JSON resume value): `;
}

/** Parse a raw terminal answer into the resume value for an interrupt kind. */
export function parseInterruptAnswer(it: InterruptInfo, raw: string): unknown {
  const trimmed = raw.trim();
  const kind = it.kind ?? "approval";

  if (kind === "question") {
    if (trimmed === "") return { answer: "" };
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && "answer" in (parsed as object)) {
        return parsed;
      }
    } catch {
      /* use plain text */
    }
    return { answer: trimmed };
  }

  if (kind === "choice") {
    const choices = it.choices ?? [];
    if (trimmed === "") return { choice: choices[0] ?? "" };
    const idx = Number(trimmed) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < choices.length) {
      return { choice: choices[idx] };
    }
    if (choices.includes(trimmed)) return { choice: trimmed };
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && "choice" in (parsed as object)) {
        return parsed;
      }
    } catch {
      /* fall through */
    }
    return { choice: trimmed };
  }

  if (kind === "form") {
    if (trimmed === "") return {};
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* fall through */
    }
    return { value: trimmed };
  }

  if (kind === "review") {
    const lower = trimmed.toLowerCase();
    if (lower === "approve" || lower === "yes" || lower === "y") {
      return { decision: "approve" };
    }
    if (lower === "request-changes" || lower === "reject" || lower === "no" || lower === "n") {
      return { decision: "request-changes" };
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* fall through */
    }
    return { decision: trimmed };
  }

  if (kind === "workshop") {
    if (trimmed === "") return { output: {} };
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* fall through */
    }
    return { output: { notes: trimmed } };
  }

  // approval / custom / default
  if (trimmed === "" || trimmed.toLowerCase() === "yes" || trimmed.toLowerCase() === "y") {
    return { approved: true };
  }
  if (trimmed.toLowerCase() === "no" || trimmed.toLowerCase() === "n") {
    return { approved: false };
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

/**
 * Combine per-interrupt parsed answers into a Command resume value.
 * A single interrupt stays a scalar; two or more become an id-keyed map.
 */
export function combineInterruptAnswers(
  interrupts: InterruptInfo[],
  values: unknown[],
): unknown {
  if (interrupts.length === 0) return { approved: true };
  if (interrupts.length === 1) return values[0];
  const map: Record<string, unknown> = {};
  for (let i = 0; i < interrupts.length; i++) {
    map[interrupts[i]!.id] = values[i];
  }
  return map;
}

/**
 * Interactive resolver for `--on-interrupt prompt`. Asks the operator for a
 * value on the terminal and returns it as the interrupt's resume value.
 * Multiple pending interrupts become an id-keyed resume map.
 */
export async function promptResolver(interrupts: InterruptInfo[]): Promise<unknown> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    if (interrupts.length === 0) return { approved: true };

    if (interrupts.length > 1) {
      printInfo(`${interrupts.length} interrupts pending; answering each in turn.`);
    }

    const answers: Record<string, unknown> = {};
    for (const it of interrupts) {
      if (it.payload && typeof it.payload === "object") {
        const data = (it.payload as { data?: unknown }).data;
        if (data !== undefined) printInfo(`  context: ${JSON.stringify(data)}`);
      }
      const prompt = formatInterruptPrompt(it);
      const answer = await rl.question(prompt);
      answers[it.id] = parseInterruptAnswer(it, answer);
    }

    return combineInterruptAnswers(
      interrupts,
      interrupts.map((it) => answers[it.id]),
    );
  } finally {
    rl.close();
  }
}

/** Shape returned by `flowgraph resume --list --json`. */
export function serializePendingInterrupts(
  threadId: string,
  interrupts: InterruptInfo[],
): { threadId: string; interrupts: Array<Record<string, unknown>> } {
  return {
    threadId,
    interrupts: interrupts.map((it) => ({
      id: it.id,
      kind: it.kind ?? "approval",
      reason: it.reason,
      choices: it.choices,
      ...(it.validationError
        ? {
            validationError: it.validationError,
            attempt: it.attempt,
            maxAttempts: it.maxAttempts,
            ...(it.exhausted ? { exhausted: true } : {}),
          }
        : {}),
      payload: it.payload,
    })),
  };
}
