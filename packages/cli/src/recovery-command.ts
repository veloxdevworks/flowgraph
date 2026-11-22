import { Command } from "commander";
import { resolve } from "node:path";
import { inspectThreadUsage, inspectThreadReplay } from "@flowgraph/core";
import { listMediaJournals } from "@flowgraph/media";
import { openThreadDatabase, inspectClaim, type ThreadDatabaseOptions } from "./thread-command.js";

export function buildRecoveryCommand(): Command {
  return new Command("recover").description("Read-only discovery of crash blockers, receipts, media identities and checkpoint ids")
    .argument("[graph]")
    .requiredOption("--thread <id>", "Thread id")
    .option("--backend <backend>", "Host checkpoint backend: sqlite|postgres")
    .option("--path <database>", "Host checkpoint database")
    .option("--workspace <path>", "Override the graph's original execution workspace")
    .action(async (graph: string | undefined, opts: ThreadDatabaseOptions & { thread:string; workspace?:string }) => {
      const db = await openThreadDatabase(graph, opts);
      try {
        const workspace=opts.workspace?resolve(opts.workspace):db.workspace;
        const config = { configurable:{thread_id:opts.thread,checkpoint_ns:""} };
        const checkpoints = [];
        for await (const tuple of db.saver.list(config)) checkpoints.push({id:tuple.checkpoint.id, createdAt:tuple.checkpoint.ts, parentId:tuple.parentConfig?.configurable?.checkpoint_id});
        const [claim,usage,replay,media] = await Promise.all([
          inspectClaim(db.saver,opts.thread), inspectThreadUsage(db.saver,opts.thread), inspectThreadReplay(db.saver,opts.thread), listMediaJournals(workspace,opts.thread),
        ]);
        console.log(JSON.stringify({threadId:opts.thread,workspace,claim,usage,replay:replayInspection(replay),media,checkpoints}));
      } finally { await db.close(); }
    });
}
export function parseTask(task: string): unknown { try { return JSON.parse(task); } catch { return task; } }

export function replayInspection(rows:Array<{task:string;entries:Record<string,unknown>}>,full=false) {
  return rows.map(row=>({...row,taskIdentity:parseTask(row.task),...(full?{}:{
    entries:Object.fromEntries(Object.entries(row.entries).filter(([,v])=>!!v&&typeof v==="object"&&(v as {__fg?:string}).__fg==="PendingStep")),
    completedSlots:Object.keys(row.entries).filter(key=>!(row.entries[key]&&typeof row.entries[key]==="object"&&(row.entries[key] as {__fg?:string}).__fg==="PendingStep")),
  })}));
}
