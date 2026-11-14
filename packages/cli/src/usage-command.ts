import { Command } from "commander";
import { inspectThreadUsage, resolveThreadUsage, type TokenUsage } from "@flowgraph/core";
import { openThreadDatabase, type ThreadDatabaseOptions } from "./thread-command.js";

function amount(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!raw.trim() || !Number.isFinite(value) || value < 0 || name === "tokens" && !Number.isSafeInteger(value)) throw new Error(`Invalid ${name}; use a finite non-negative ${name === "tokens" ? "integer" : "number"}`);
  return value;
}
export function buildUsageCommand(): Command {
  const command = new Command("usage").description("Inspect and explicitly reconcile paid-call receipts");
  command.command("inspect [graph]").requiredOption("--thread <id>", "Thread id").option("--backend <backend>", "Host checkpoint backend: sqlite|postgres").option("--path <database>", "Host checkpoint path/connection string").action(async (graph: string | undefined, opts: { thread: string } & ThreadDatabaseOptions) => {
    const db = await openThreadDatabase(graph, opts);
    try { console.log(JSON.stringify({ threadId: opts.thread, usage: await inspectThreadUsage(db.saver, opts.thread) })); }
    finally { await db.close(); }
  });
  command.command("resolve [graph]")
    .requiredOption("--thread <id>", "Thread id")
    .requiredOption("--receipt <id>", "Exact pending/unresolved receipt from inspection")
    .option("--backend <backend>", "Host checkpoint backend: sqlite|postgres")
    .option("--path <database>", "Host checkpoint path/connection string")
    .option("--tokens <n>", "Reconciled total tokens for this receipt")
    .option("--cost-usd <n>", "Reconciled USD charged for this receipt")
    .option("--not-billed", "Provider confirms the request was not accepted/billed")
    .option("--owner-stopped", "Attest owner/external work is stopped or reconciled")
    .action(async (graph: string | undefined, opts: { thread: string; receipt: string; tokens?: string; costUsd?: string; notBilled?: boolean; ownerStopped?: boolean } & ThreadDatabaseOptions) => {
      if (!opts.ownerStopped) throw new Error("Stop/reconcile the owner and provider outcome, then pass --owner-stopped. Release an inspected crash claim with 'flowgraph thread release' first.");
      if (opts.notBilled && (opts.tokens !== undefined || opts.costUsd !== undefined)) throw new Error("Use --not-billed or explicit --tokens/--cost-usd, not both");
      const tokens = amount(opts.tokens, "tokens"), cost = amount(opts.costUsd, "cost-usd");
      if (!opts.notBilled && tokens === undefined && cost === undefined) throw new Error("Report --tokens and/or --cost-usd, or explicitly --not-billed");
      const usage: TokenUsage = opts.notBilled ? { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0 } : { ...(tokens === undefined ? {} : { totalTokens: tokens }), ...(cost === undefined ? {} : { costUSD: cost }) };
      const db = await openThreadDatabase(graph, opts);
      try { console.log(JSON.stringify({ threadId: opts.thread, usage: await resolveThreadUsage(db.saver, opts.thread, opts.receipt, usage) })); }
      finally { await db.close(); }
    });
  return command;
}
