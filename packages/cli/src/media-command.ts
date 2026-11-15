import { Command } from "commander";
import { resolve, dirname } from "node:path";
import { acquireThreadRun, createFileJournal, listMediaJournals, loadGraph, resolveGraphWorkspace, resolveMediaSubmission, UsageLedger } from "@flowgraph/core";
import { openThreadDatabase, type ThreadDatabaseOptions } from "./thread-command.js";
interface Options extends ThreadDatabaseOptions {
  thread:string; node?:string; fingerprint?:string; workspace?:string;
  submission?:string; handle?:string; notSubmitted?:boolean; ownerStopped?:boolean; receipt?:string; costUsd?:string;
}
async function workspaceFor(graph:string|undefined, workspace:string|undefined) {
  if (workspace) return resolve(workspace);
  if (!graph) throw new Error("Provide a graph to resolve runtime.workspace, or an explicit --workspace");
  const loaded=await loadGraph(graph);
  if (!loaded.spec) throw new Error(loaded.diagnostics.map(d=>d.message).join("; "));
  return resolveGraphWorkspace(loaded.spec,dirname(resolve(graph)));
}
function base(command:Command) {
  return command.requiredOption("--thread <id>","Thread id").option("--node <id>","Media node id (omit to discover all journals)")
    .option("--fingerprint <hash>","Request fingerprint (omit to discover identities)").option("--workspace <path>","Original execution workspace; defaults to the graph's runtime.workspace");
}
export function buildMediaCommand(): Command {
  const command=new Command("media").description("Discover and reconcile uncertain media submissions");
  base(command.command("inspect [graph]").description("Read journal identities or one exact media journal")).action(async(graph:string|undefined,opts:Options)=>{
    const workspace=await workspaceFor(graph,opts.workspace);
    if (opts.node && opts.fingerprint) {
      const entry=await createFileJournal({workspace,scope:opts.thread,nodeId:opts.node,fingerprint:opts.fingerprint}).read();
      if (!entry) throw Object.assign(new Error(`No media journal in workspace ${workspace} for node ${opts.node}, fingerprint ${opts.fingerprint}; run media inspect without --node/--fingerprint to discover identities.`),{code:"MEDIA_JOURNAL_NOT_FOUND"});
      console.log(JSON.stringify(entry));
    } else {
      const rows=(await listMediaJournals(workspace,opts.thread)).filter(row=>(!opts.node||row.nodeId===opts.node)&&(!opts.fingerprint||row.fingerprint===opts.fingerprint));
      console.log(JSON.stringify({threadId:opts.thread,workspace,journals:rows}));
    }
  });
  base(command.command("resolve [graph]").description("Reconcile an exact vendor submission and its matching usage receipt")).option("--backend <backend>","Host checkpoint backend").option("--path <database>","Host checkpoint database")
    .requiredOption("--submission <id>","Exact inspected submission identity")
    .option("--handle <json>","Recovered vendor handle, optionally with done artifacts and costUSD")
    .option("--not-submitted","Vendor confirms the request was never accepted; uncertainty alone is insufficient")
    .option("--receipt <id>","Usage receipt when multiple legacy receipts match")
    .option("--cost-usd <n>","Confirmed vendor charge for a recovered handle")
    .option("--owner-stopped","Attest owner and external work are stopped/reconciled")
    .action(async(graph:string|undefined,opts:Options)=>{
      if (!opts.node||!opts.fingerprint||!opts.ownerStopped) throw new Error("Stop/reconcile the owner and external request, then pass --owner-stopped and exact --node/--fingerprint/--submission identities");
      if (!!opts.handle===!!opts.notSubmitted) throw new Error("Choose --handle <json> or --not-submitted");
      const handle=opts.handle?JSON.parse(opts.handle):undefined;
      const cost=opts.costUsd===undefined?handle?.costUSD:Number(opts.costUsd);
      if (cost!==undefined&&(!Number.isFinite(cost)||cost<0)) throw new Error("cost-usd must be a finite non-negative number");
      const workspace=await workspaceFor(graph,opts.workspace),db=await openThreadDatabase(graph,opts);
      try {
        const claim=await acquireThreadRun(db.saver,opts.thread);
        try {
          const ledger=await UsageLedger.open(db.saver,opts.thread), usage=ledger.inspect();
          const candidates=Object.entries({...usage.pending,...usage.unresolved}).filter(([,r])=>r.kind==="media"&&(r.reference?r.reference===opts.fingerprint:r.nodeId===opts.node));
          const receipt=opts.receipt??(candidates.length===1?candidates[0]![0]:undefined);
          if (candidates.length>1&&!receipt) throw new Error("Multiple media usage receipts match; inspect usage and pass --receipt before resolving");
          if (opts.receipt&&!candidates.some(([id])=>id===opts.receipt)&&!usage.resolved?.[opts.receipt]) throw new Error("Receipt does not match this media request");
          if (receipt&&!opts.notSubmitted&&cost===undefined) throw new Error("A matching usage receipt needs the confirmed --cost-usd (or handle.costUSD) to settle the vendor outcome");
          await resolveMediaSubmission(createFileJournal({workspace,scope:opts.thread,nodeId:opts.node,fingerprint:opts.fingerprint}),opts.submission!,opts.notSubmitted?{notSubmitted:true}:{handle:{...handle,...(cost===undefined?{}:{costUSD:cost})}});
          if (receipt) await ledger.resolve(receipt,{costUSD:opts.notSubmitted?0:cost!,...(opts.notSubmitted?{totalTokens:0,inputTokens:0,outputTokens:0}:{})});
          console.log(JSON.stringify({resolved:true,receipt:receipt??null,usage:ledger.snapshot()}));
        } finally { await claim.release(); }
      } finally { await db.close(); }
    });
  return command;
}
