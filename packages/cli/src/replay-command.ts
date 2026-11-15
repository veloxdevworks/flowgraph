import { Command } from "commander";
import { inspectThreadReplay, resolveThreadReplay } from "@flowgraph/core";
import { replayInspection } from "./recovery-command.js";
import { openThreadDatabase, type ThreadDatabaseOptions } from "./thread-command.js";
interface Options extends ThreadDatabaseOptions {
  full?:boolean;
  thread: string;
  task?: string;
  slot?: string;
  receipt?: string;
  result?: string;
  notApplied?: boolean;
  ownerStopped?: boolean;
}
export function buildReplayCommand(): Command {
  const command = new Command("replay").description(
    "Inspect and reconcile unfinished tool/shell operations",
  );
  for (const action of ["inspect", "resolve"] as const) {
    const sub = command
      .command(`${action} [graph]`).description(action === "inspect" ? "Read unresolved operation identities; omit historical output unless --full" : "Reconcile one exact operation receipt with its raw result or confirmed non-application")
      .requiredOption("--thread <id>", "Thread id")
      .option("--backend <backend>", "Host checkpoint backend")
      .option("--path <database>", "Host checkpoint path");
    if (action === "inspect") sub.option("--full","Include completed historical results, including shell stdout");
    if (action === "resolve") sub.option("--task <key>", "Exact task key from inspection")
      .option("--slot <key>", "Unfinished operation slot")
      .option("--receipt <id>", "Exact unresolved receipt")
      .option("--result <json>", "Recovered operation result")
      .option("--not-applied", "Confirm operation was stopped and not applied")
      .option("--owner-stopped", "Attest owner and external work are stopped/reconciled");
    sub.action(async (graph: string | undefined, opts: Options) => {
        const db = await openThreadDatabase(graph, opts);
        try {
          if (action === "inspect") {
            console.log(JSON.stringify(replayInspection(await inspectThreadReplay(db.saver, opts.thread),opts.full)));
            return;
          }
          if (!opts.ownerStopped || !opts.task || !opts.slot || !opts.receipt)
            throw new Error(
              "Stop/reconcile owner and external work, then pass --owner-stopped with exact --task, --slot and --receipt",
            );
          if ((opts.result !== undefined) === !!opts.notApplied)
            throw new Error("Choose --result <json> or --not-applied");
          await resolveThreadReplay(
            db.saver,
            opts.thread,
            opts.task,
            opts.slot,
            opts.receipt,
            opts.notApplied ? { notApplied: true } : { result: JSON.parse(opts.result!) },
          );
          console.log(JSON.stringify({ resolved: true }));
        } finally {
          await db.close();
        }
      });
  }
  return command;
}
