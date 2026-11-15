import { Command } from "commander";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { inspectThreadRun, releaseThreadRun, loadGraph, readThreadWorkspace, resolveGraphWorkspace, type GraphSpec } from "@flowgraph/core";
import { checkpointerOption } from "./interrupts.js";
import { loadDotenvFromCwd } from "./env.js";

export interface ThreadDatabaseOptions { backend?: string; path?: string; thread?: string }
export async function openThreadDatabase(graph: string | undefined, overrides: ThreadDatabaseOptions = {}) {
  loadDotenvFromCwd(process.cwd());
  let spec: GraphSpec;
  if (graph) {
    const loaded = await loadGraph(graph);
    if (!loaded.spec) throw new Error(loaded.diagnostics.map(d => d.message).join("; "));
    spec = loaded.spec;
  } else {
    // checkpointerOption reads backend/memory configuration; no graph is compiled.
    spec = { apiVersion: "flowgraph/v1", kind: "Graph", metadata: { name: "maintenance" }, nodes: [], edges: [] } as GraphSpec;
  }
  if (overrides.backend || overrides.path) {
    const prior = spec.runtime?.checkpoint;
    const backend = overrides.backend ?? prior?.backend;
    if (backend !== "sqlite" && backend !== "postgres") throw new Error("Use --backend sqlite|postgres with --path for a host-configured database");
    const selectedPath = overrides.path ?? (backend === prior?.backend ? prior.path : undefined);
    if (backend === "sqlite" && !selectedPath) throw new Error("SQLite maintenance needs --path or a graph checkpoint path");
    const { path: _previousPath, ...checkpoint } = prior ?? {};
    spec = { ...spec, runtime: { ...spec.runtime, checkpoint: { ...checkpoint, enabled: true, backend, ...(selectedPath ? { path: selectedPath } : {}) } } };
  }
  if (spec.runtime?.checkpoint?.enabled === false || !["sqlite", "postgres"].includes(spec.runtime?.checkpoint?.backend ?? "memory")) {
    throw new Error("Provide a durable-checkpoint graph, or --backend sqlite|postgres --path <database>");
  }
  const { checkpointer } = await checkpointerOption(spec, { onNotice: message => console.error(message) });
  if (!checkpointer || typeof checkpointer !== "object") throw new Error("No durable checkpoint database was opened");
  const close = async () => {
    const resource = checkpointer as unknown as { end?: () => Promise<void>; db?: { close(): void } };
    if (resource.end) await resource.end(); else resource.db?.close();
  };
  let workspace: string;
  try {
    workspace = (overrides.thread ? await readThreadWorkspace(checkpointer, overrides.thread) : undefined)
      ?? resolveGraphWorkspace(spec, graph ? dirname(resolve(graph)) : process.cwd());
  } catch (error) { await close(); throw error; }
  return {
    saver: checkpointer, spec, workspace, close,
  };
}
function ownerIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as { code?: string }).code !== "ESRCH"; }
}
export async function inspectClaim(saver: object, thread: string) {
  const claim = await inspectThreadRun(saver, thread);
  return claim ? { ...claim, ownerStatus: claim.owner?.host === hostname() ? (ownerIsAlive(claim.owner.pid) ? "alive" : "dead") : "unknown" } : null;
}
export function buildThreadCommand(): Command {
  const command = new Command("thread").description("Inspect and explicitly reconcile execution claims");
  command.command("inspect [graph]").description("Read the execution claim and same-host owner status without changing it").requiredOption("--thread <id>", "Thread id").option("--backend <backend>", "Host checkpoint backend: sqlite|postgres").option("--path <database>", "Host checkpoint path/connection string").action(async (graph: string | undefined, opts: { thread: string } & ThreadDatabaseOptions) => {
    const db = await openThreadDatabase(graph, opts);
    try { console.log(JSON.stringify({ threadId: opts.thread, workspace: db.workspace, claim: await inspectClaim(db.saver, opts.thread) })); }
    finally { await db.close(); }
  });
  command.command("release [graph]").description("Release an inspected crash claim after stopping and reconciling its owner")
    .requiredOption("--thread <id>", "Thread id")
    .requiredOption("--token <token>", "Exact token from thread inspect or recover")
    .option("--backend <backend>", "Host checkpoint backend: sqlite|postgres")
    .option("--path <database>", "Host checkpoint path/connection string")
    .option("--owner-stopped", "Attest the owner is stopped and any external work has been reconciled")
    .action(async (graph: string | undefined, opts: { thread: string; token: string; ownerStopped?: boolean } & ThreadDatabaseOptions) => {
      if (!opts.ownerStopped) throw new Error("Inspect the claim and stop/reconcile its owner and external work first, then pass --owner-stopped with the exact --token");
      const db = await openThreadDatabase(graph, opts);
      try {
        const claim = await inspectThreadRun(db.saver, opts.thread);
        if (!claim) { console.log(JSON.stringify({threadId:opts.thread,released:false,alreadyReleased:true,message:"No claim is held; already released."})); return; }
        if (claim.token !== opts.token) throw new Error("Claim token does not match; inspect the current owner before retrying");
        if (claim.owner?.host === hostname() && ownerIsAlive(claim.owner.pid)) throw new Error(`Owner pid ${claim.owner.pid} is still alive on this host; stop it before releasing its execution claim`);
        if (!await releaseThreadRun(db.saver, opts.thread, opts.token)) throw new Error("Claim changed before release; no other owner was released");
        console.log(JSON.stringify({ threadId: opts.thread, released: true }));
      } finally { await db.close(); }
    });
  return command;
}
