import { Command } from "commander";
import { resolve } from "node:path";
import { acquireThreadRun, createFileJournal, resolveMediaSubmission } from "@flowgraph/core";
import { openThreadDatabase, type ThreadDatabaseOptions } from "./thread-command.js";

interface Options extends ThreadDatabaseOptions {
  thread: string;
  node: string;
  fingerprint: string;
  workspace: string;
  submission?: string;
  handle?: string;
  notSubmitted?: boolean;
  ownerStopped?: boolean;
}
export function buildMediaCommand(): Command {
  const command = new Command("media").description(
    "Inspect and reconcile uncertain media submissions",
  );
  for (const action of ["inspect", "resolve"] as const) {
    command
      .command(`${action} [graph]`)
      .requiredOption("--thread <id>", "Thread id")
      .requiredOption("--node <id>", "Media node id")
      .requiredOption("--fingerprint <hash>", "Request fingerprint from custom.media.job events")
      .option("--workspace <path>", "Original execution workspace", process.cwd())
      .option("--backend <backend>", "Host checkpoint backend")
      .option("--path <database>", "Host checkpoint path")
      .option("--submission <id>", "Exact inspected submission id")
      .option("--handle <json>", "Recovered vendor handle, optionally with completed artifacts")
      .option("--not-submitted", "Vendor confirms request was not accepted")
      .option("--owner-stopped", "Attest owner and external work are stopped/reconciled")
      .action(async (graph: string | undefined, opts: Options) => {
        const journal = createFileJournal({
          workspace: resolve(opts.workspace),
          scope: opts.thread,
          nodeId: opts.node,
          fingerprint: opts.fingerprint,
        });
        if (action === "inspect") {
          console.log(JSON.stringify((await journal.read()) ?? null));
          return;
        }
        if (!opts.ownerStopped || !opts.submission)
          throw new Error(
            "Stop/reconcile the owner and external request, then pass --owner-stopped and the exact --submission",
          );
        if (!!opts.handle === !!opts.notSubmitted)
          throw new Error("Choose --handle <json> or --not-submitted");
        const db = await openThreadDatabase(graph, opts);
        try {
          const claim = await acquireThreadRun(db.saver, opts.thread);
          try {
            await resolveMediaSubmission(
              journal,
              opts.submission,
              opts.notSubmitted ? { notSubmitted: true } : { handle: JSON.parse(opts.handle!) },
            );
          } finally {
            await claim.release();
          }
          console.log(JSON.stringify({ resolved: true }));
        } finally {
          await db.close();
        }
      });
  }
  return command;
}
