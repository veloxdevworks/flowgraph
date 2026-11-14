import { Command } from "commander";
import { hostname } from "node:os";
import { inspectThreadRun, releaseThreadRun, loadGraph } from "@flowgraph/core";
import { checkpointerOption } from "./interrupts.js";
import { loadDotenvFromCwd } from "./env.js";

async function database(graph: string) {
  loadDotenvFromCwd(process.cwd());
  const { spec, diagnostics } = await loadGraph(graph);
  if (!spec) throw new Error(diagnostics.map(d => d.message).join("; "));
  if (spec.runtime?.checkpoint?.enabled === false || !["sqlite", "postgres"].includes(spec.runtime?.checkpoint?.backend ?? "memory")) {
    throw new Error("Thread recovery requires a graph configured with durable SQLite or PostgreSQL checkpoints");
  }
  const { checkpointer } = await checkpointerOption(spec, { onNotice: message => console.error(message) });
  if (!checkpointer || typeof checkpointer !== "object") throw new Error("No durable checkpoint database was opened");
  return {
    saver: checkpointer,
    async close() {
      const resource = checkpointer as unknown as { end?: () => Promise<void>; db?: { close(): void } };
      if (resource.end) await resource.end(); else resource.db?.close();
    },
  };
}
function ownerIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as { code?: string }).code !== "ESRCH"; }
}
export function buildThreadCommand(): Command {
  const command = new Command("thread").description("Inspect and explicitly reconcile execution claims");
  command.command("inspect <graph>").requiredOption("--thread <id>", "Thread id").action(async (graph: string, opts: { thread: string }) => {
    const db = await database(graph);
    try { console.log(JSON.stringify({ threadId: opts.thread, claim: await inspectThreadRun(db.saver, opts.thread) ?? null })); }
    finally { await db.close(); }
  });
  command.command("release <graph>")
    .requiredOption("--thread <id>", "Thread id")
    .requiredOption("--token <token>", "Exact inspected ownership token")
    .option("--owner-stopped", "Attest the owner is stopped and any external work has been reconciled")
    .action(async (graph: string, opts: { thread: string; token: string; ownerStopped?: boolean }) => {
      if (!opts.ownerStopped) throw new Error("Inspect the claim and stop/reconcile its owner and external work first, then pass --owner-stopped with the exact --token");
      const db = await database(graph);
      try {
        const claim = await inspectThreadRun(db.saver, opts.thread);
        if (!claim || claim.token !== opts.token) throw new Error("Claim token does not match; inspect the current owner before retrying");
        if (claim.owner?.host === hostname() && ownerIsAlive(claim.owner.pid)) throw new Error(`Owner pid ${claim.owner.pid} is still alive on this host; stop it before releasing its execution claim`);
        if (!await releaseThreadRun(db.saver, opts.thread, opts.token)) throw new Error("Claim changed before release; no other owner was released");
        console.log(JSON.stringify({ threadId: opts.thread, released: true }));
      } finally { await db.close(); }
    });
  return command;
}
