import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import type { CompileOptions, InterruptInfo } from "@veloxdevworks/flowgraph-core";
import { printInfo } from "./ui.js";
import { lazyOptionalImport } from "./optional-deps.js";

const loadCheckpointSqlite = lazyOptionalImport<typeof import("@veloxdevworks/flowgraph-checkpoint-sqlite")>(
  "@veloxdevworks/flowgraph-checkpoint-sqlite",
  "Install it: pnpm add @veloxdevworks/flowgraph-checkpoint-sqlite",
);

/**
 * Build a durable checkpointer for CLI runs based on the graph's runtime config.
 * sqlite → persistent file (resume survives process restarts). Otherwise leaves
 * the compiler default (in-memory).
 */
export async function checkpointerOption(
  spec: GraphSpec,
): Promise<Pick<CompileOptions, "checkpointer">> {
  const ck = spec.runtime?.checkpoint;
  if (ck?.enabled === false) return { checkpointer: "none" };
  if (ck?.backend === "sqlite") {
    const checkpoint = await loadCheckpointSqlite();
    const dbPath = ck.path ?? ".flowgraph/checkpoints.db";
    return { checkpointer: checkpoint.createSqliteCheckpointer(dbPath) };
  }
  return {};
}

/** Prompt text shown before collecting an interrupt answer. */
export function formatInterruptPrompt(it: InterruptInfo): string {
  const kind = it.kind ?? "approval";
  const reason = it.reason ?? it.id;

  if (kind === "question") {
    return `${reason}\nYour answer: `;
  }

  if (kind === "choice" && it.choices?.length) {
    const lines = it.choices.map((c, i) => `  ${i + 1}. ${c}`).join("\n");
    return `${reason}\n${lines}\nEnter choice (number or text): `;
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
 * Interactive resolver for `--on-interrupt prompt`. Asks the operator for a
 * value on the terminal and returns it as the interrupt's resume value.
 */
export async function promptResolver(interrupts: InterruptInfo[]): Promise<unknown> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const it = interrupts[0];
    if (!it) return { approved: true };

    if (interrupts.length > 1) {
      printInfo(`${interrupts.length} interrupts pending; answering the first.`);
    }

    if (it.payload && typeof it.payload === "object") {
      const data = (it.payload as { data?: unknown }).data;
      if (data !== undefined) printInfo(`  context: ${JSON.stringify(data)}`);
    }

    const prompt = formatInterruptPrompt(it);
    const answer = await rl.question(prompt);
    return parseInterruptAnswer(it, answer);
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
      payload: it.payload,
    })),
  };
}
