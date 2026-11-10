/**
 * Remote execution of a placed node (ADR-0020 §8). One executor per node decided `remote`.
 *
 * The compiler (non-subgraph nodes) and the `subgraph` factory (subgraphs) hand it the child spec
 * and the child's input; it dispatches (or reconnects to) the child run on the worker, forwards the
 * child's events into the parent bus, and returns the child's final state. Seeding the child and
 * merging its state back stay with the callers, so remote and in-process share one contract.
 */

import type { GraphSpec, NodeSpec } from "@flowgraph/spec";
import type { NodeRunContext } from "../context.js";
import type { EventScope, EventType } from "../events.js";
import { isTimeoutError } from "../runtime/retry.js";
import { resolvePlacements, wrapNodeAsGraph, type PlacementDecision } from "./resolve.js";
import { stageIn, stageOut, StagingError, type StagedIn, type StagingErrorCode } from "./staging.js";
import type { Topology } from "./topology.js";
import type { TransportTarget, WorkerEvent, WorkerOutcome, WorkerTransport } from "./transport.js";

/** The server caps thread ids at 234 characters (its graph store file names). */
export const MAX_CHILD_THREAD_ID_LENGTH = 234;

export type PlacementRuntimeCode =
  | "REMOTE_NODE_FAILED"
  | "REMOTE_NODE_CANCELLED"
  | "PLACEMENT_GATE_UNSUPPORTED"
  | "PLACEMENT_THREAD_ID_TOO_LONG"
  | StagingErrorCode;

export class PlacementRuntimeError extends Error {
  /** Mirrors the engine's "do not retry" marker (`isNonRetryable`). */
  readonly retryable?: false;
  constructor(
    readonly code: PlacementRuntimeCode,
    message: string,
    opts: { retryable?: false; cause?: unknown } = {},
  ) {
    super(`${code}: ${message}`, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "PlacementRuntimeError";
    if (opts.retryable === false) this.retryable = false;
  }
}

/** Where a node's child ran. Carried on events as `scope.placement`. */
export interface PlacementInfo {
  target: string;
  childThreadId: string;
}

export interface RemoteExecuteArgs {
  ctx: NodeRunContext;
  /** Bundled child graph to run on the worker. */
  spec: GraphSpec;
  /** The child's run input (already projected by the caller). */
  input: Record<string, unknown>;
  /**
   * True when `spec` is the one-node wrapper of a non-subgraph node: the wrapper's own node
   * lifecycle events duplicate the parent's and are not forwarded.
   */
  wrapper?: boolean;
}

export interface RemoteNodeExecutor {
  readonly nodeId: string;
  /** Target the node was placed on at compile time. */
  readonly initialTarget: string;
  /** Child thread id of attempt 1 for a parent thread; `node.start` carries it before the node runs. */
  plannedChildThreadId(parentThreadId: string | undefined): string | undefined;
  /**
   * Stages the artifacts in `args.input` to the worker (ADR-0020 section 10), runs the child to
   * completion and returns its final state (reserved channels stripped). Artifacts in the state
   * are not fetched: pass what flows back into the parent to `stageOut`.
   */
  execute(args: RemoteExecuteArgs): Promise<Record<string, unknown>>;
  /**
   * Fetches the files of the `Artifact` records in `value` from the child that `execute` ran on `ctx`
   * (same node attempt) into this workspace and returns `value` with the records rewritten. Fails the
   * node with `ARTIFACT_STAGE_OUT_FAILED`. Call it on the values that flow back, not the whole child state.
   */
  stageOut<T>(ctx: NodeRunContext, value: T): Promise<T>;
}

export interface RemoteExecutorDeps {
  node: NodeSpec;
  decision: PlacementDecision;
  topology?: Topology | undefined;
  transport: WorkerTransport;
  localLabels: string[];
  loadChild?: ((ref: string) => GraphSpec | undefined) | undefined;
}

export function childThreadIdFor(parentThreadId: string, nodeId: string, attempt: number): string {
  return `${parentThreadId}/${nodeId}/${attempt}`;
}

const NOT_FORWARDED = new Set<string>(["run.start", "run.end", "run.error", "run.aborted", "run.paused", "run.continued", "interrupt.raised", "interrupt.resumed"]);
const WRAPPER_DUPLICATES = new Set<string>(["node.start", "node.end", "node.error", "node.skipped"]);

/**
 * The wrapper for a non-subgraph node with its runtime-resolved input (see `wrapNodeAsGraph`):
 * the node's static `input` keys plus any the run produced (for example from a `node:before` hook).
 */
export function wrapperSpecForNode(node: NodeSpec, input: Record<string, unknown>): GraphSpec {
  const declared = (node as { input?: unknown }).input;
  const staticKeys = declared != null && typeof declared === "object" && !Array.isArray(declared) ? Object.keys(declared) : [];
  return wrapNodeAsGraph(node, [...staticKeys, ...Object.keys(input)]);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

export function createRemoteNodeExecutor(deps: RemoteExecutorDeps): RemoteNodeExecutor {
  const { node, transport } = deps;
  const nodeId = node.id;
  const initialTarget = deps.decision.target ?? "";
  /** Preferred target for the next attempt; changes when a transport failure forces a re-resolve. */
  let currentTarget = initialTarget;
  let stale = false;
  /** Files staged in per child run, so a record that comes back unchanged keeps its coordinator path. */
  const stagedIn = new Map<string, StagedIn>();

  const targetOf = (name: string): TransportTarget => {
    const t = deps.topology?.targets?.[name];
    if (!t) throw new PlacementRuntimeError("REMOTE_NODE_FAILED", `node "${nodeId}": target "${name}" is not in the topology`);
    return { name, ...t };
  };

  /** Matching runs again for this node only (ADR §7). */
  async function reResolve(): Promise<void> {
    const single = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: `re-resolve-${nodeId}` },
      nodes: [node],
      edges: [],
    } as unknown as GraphSpec;
    const { decisions, diagnostics } = await resolvePlacements(single, {
      localLabels: deps.localLabels,
      ...(deps.topology ? { topology: deps.topology } : {}),
      transport,
      ...(deps.loadChild ? { loadChild: deps.loadChild } : {}),
    });
    const d = decisions[0];
    if (!d || d.kind !== "remote" || !d.target) {
      const why = diagnostics.map((x) => x.message).join("\n") || `placement resolved to "${d?.kind ?? "nothing"}"`;
      throw new PlacementRuntimeError("REMOTE_NODE_FAILED", `node "${nodeId}": no worker is available after a transport failure\n${why}`);
    }
    currentTarget = d.target;
    stale = false;
  }

  async function execute(args: RemoteExecuteArgs): Promise<Record<string, unknown>> {
    const { ctx, spec, input } = args;
    const parentThreadId = ctx.meta.threadId;
    if (!parentThreadId) {
      throw new PlacementRuntimeError("REMOTE_NODE_FAILED", `node "${nodeId}": the run has no thread id, so the child run cannot be named`, { retryable: false });
    }
    const attempt = ctx.attempt;
    const childThreadId = childThreadIdFor(parentThreadId, nodeId, attempt);
    if (childThreadId.length > MAX_CHILD_THREAD_ID_LENGTH) {
      throw new PlacementRuntimeError(
        "PLACEMENT_THREAD_ID_TOO_LONG",
        `child thread id for node "${nodeId}" is ${childThreadId.length} characters (limit ${MAX_CHILD_THREAD_ID_LENGTH}); use a shorter thread id or node id`,
        { retryable: false },
      );
    }
    const signal = ctx.signal;
    if (signal?.aborted) throw abortReason(signal);

    if (stale) await reResolve();

    // Record before dispatching, so a re-executed node reuses the target and child id and attaches.
    let fresh = false;
    const recorded = await ctx.once<PlacementInfo>(`placement:${nodeId}:${attempt}`, () => {
      fresh = true;
      return { target: currentTarget, childThreadId };
    });
    const placement: PlacementInfo = { target: recorded.target, childThreadId: recorded.childThreadId };
    (ctx as NodeRunContext & { _placement?: PlacementInfo })._placement = placement;
    const tt = targetOf(placement.target);
    const where = `target "${placement.target}"`;

    const ac = new AbortController();
    let started = !fresh; // a recorded dispatch may already be running
    let outcomeKnown = false;
    let cancelSent = false;
    let cancelledByUs = false;
    const requestCancel = (): Promise<void> => {
      if (cancelSent || outcomeKnown || !started) return Promise.resolve();
      cancelSent = true;
      cancelledByUs = true;
      return transport.cancel(tt, placement.childThreadId).catch(() => undefined);
    };
    const onAbort = () => {
      ac.abort();
      void requestCancel();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      if (fresh) {
        // Artifacts go first, and a missing file fails the node before anything is dispatched.
        let dispatchInput = input;
        try {
          const r = await stageIn({ transport, target: tt, workspace: ctx.workspace, value: input, signal: ac.signal });
          dispatchInput = r.value as Record<string, unknown>;
          if (r.staged.size > 0) stagedIn.set(placement.childThreadId, r.staged);
        } catch (err) {
          if (err instanceof StagingError) {
            // A transport failure makes the next attempt match again; a missing file does not.
            if (err.code === "ARTIFACT_STAGE_IN_FAILED") stale = true;
            throw new PlacementRuntimeError(err.code, `node "${nodeId}": ${err.message}`, { ...(err.code === "ARTIFACT_MISSING" ? { retryable: false as const } : {}), cause: err });
          }
          if (signal?.aborted) throw abortReason(signal);
          throw err;
        }
        let res;
        try {
          res = await transport.dispatch(tt, {
            childThreadId: placement.childThreadId,
            spec,
            input: dispatchInput,
            label: `${ctx.meta.graph}/${nodeId}`,
          });
        } catch (err) {
          stale = true;
          throw new PlacementRuntimeError("REMOTE_NODE_FAILED", `node "${nodeId}" could not be dispatched to ${where}: ${msg(err)}`, { cause: err });
        }
        started = true;
        // `exists`: the worker already has this child id (reconnect, not re-send) -> attach below.
        void res;
      }
      if (signal?.aborted) {
        await requestCancel();
        throw abortReason(signal);
      }

      const attachment = transport.attach(tt, placement.childThreadId, { signal: ac.signal });
      const forwarding = (async () => {
        try {
          for await (const ev of attachment.events) forwardEvent(ctx, ev, placement, nodeId, args.wrapper === true);
        } catch {
          /* the result carries the failure */
        }
      })();

      let outcome: WorkerOutcome;
      try {
        outcome = await attachment.result;
      } catch (err) {
        await forwarding;
        if (signal?.aborted) throw abortReason(signal);
        stale = true;
        throw new PlacementRuntimeError("REMOTE_NODE_FAILED", `node "${nodeId}" lost contact with ${where}: ${msg(err)}`, { cause: err });
      }
      outcomeKnown = true;
      await forwarding;

      switch (outcome.status) {
        case "completed":
          return outcome.state ?? {};
        case "error": {
          const e = outcome.error;
          throw new PlacementRuntimeError(
            "REMOTE_NODE_FAILED",
            `node "${nodeId}" failed on ${where}: ${e?.message ?? "child run failed"}${e?.code ? ` (${e.code})` : ""}`,
          );
        }
        case "cancelled":
          if (cancelledByUs || signal?.aborted) throw abortReason(signal);
          throw new PlacementRuntimeError("REMOTE_NODE_CANCELLED", `the child run of node "${nodeId}" was cancelled on ${where}`);
        case "interrupted": {
          // The child is paused, so cancelling it is safe (ADR phase 1: no gate forwarding).
          outcomeKnown = false;
          await requestCancel();
          outcomeKnown = true;
          throw new PlacementRuntimeError(
            "PLACEMENT_GATE_UNSUPPORTED",
            `node "${nodeId}" paused for a human on ${where}; gates inside placed subgraphs are forwarded in phase 2 (ADR-0020 section 8), so the child run was cancelled`,
            { retryable: false },
          );
        }
        default:
          throw new PlacementRuntimeError("REMOTE_NODE_FAILED", `node "${nodeId}": ${where} reported an unknown outcome`);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async function stageOutValue<T>(ctx: NodeRunContext, value: T): Promise<T> {
    const placement = (ctx as NodeRunContext & { _placement?: PlacementInfo })._placement;
    const parentThreadId = ctx.meta.threadId;
    if (!placement || !parentThreadId) return value;
    try {
      const r = await stageOut({
        transport,
        target: targetOf(placement.target),
        childThreadId: placement.childThreadId,
        workspace: ctx.workspace,
        parentThreadId,
        nodeId,
        value,
        staged: stagedIn.get(placement.childThreadId),
        signal: ctx.signal,
      });
      return r.value as T;
    } catch (err) {
      if (err instanceof StagingError) throw new PlacementRuntimeError(err.code, `node "${nodeId}": ${err.message}`, { cause: err });
      if (ctx.signal?.aborted) throw abortReason(ctx.signal);
      throw err;
    } finally {
      stagedIn.delete(placement.childThreadId);
    }
  }

  return {
    nodeId,
    initialTarget,
    plannedChildThreadId: (parent) => (parent ? childThreadIdFor(parent, nodeId, 1) : undefined),
    execute,
    stageOut: stageOutValue,
  };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function abortReason(signal: AbortSignal | undefined): Error {
  const r = signal?.reason;
  if (r instanceof Error) return r;
  if (isTimeoutError(r)) return r;
  return Object.assign(new Error("Aborted"), { name: "AbortError" });
}

/** Nest a worker event under the placed node, as in-process subgraph children are (`parentSpanId`). */
function forwardEvent(ctx: NodeRunContext, ev: WorkerEvent, placement: PlacementInfo, nodeId: string, wrapper: boolean): void {
  const type = ev.type;
  if (typeof type !== "string" || NOT_FORWARDED.has(type)) return;
  const inner = isPlainObject(ev["scope"]) ? (ev["scope"] as EventScope) : {};
  if (wrapper && WRAPPER_DUPLICATES.has(type) && (inner.nodeId === undefined || inner.nodeId === nodeId)) return;
  ctx.events.emit(type as EventType, ev.data, { ...inner, parentSpanId: nodeId, placement: { ...placement } });
}
