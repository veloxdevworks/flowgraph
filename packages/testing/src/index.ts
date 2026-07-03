/**
 * In-memory test harness for flowgraph graphs.
 */

import * as path from "node:path";
import { loadGraph, validateSpec, compileGraph, loadGraphImports } from "@veloxdevworks/flowgraph-core";
import type { FlowgraphEvent, CompiledGraph, CompileOptions, InterruptInfo, InterruptPolicy } from "@veloxdevworks/flowgraph-core";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";

export interface TestCompileOptions {
  store?: CompileOptions["store"];
}

export interface TestRunOptions {
  input?: Record<string, unknown>;
  threadId?: string;
  onInterrupt?: InterruptPolicy;
  resolveInterrupt?: (interrupts: InterruptInfo[]) => Promise<unknown> | unknown;
  store?: CompileOptions["store"];
}

export interface TestRunResult {
  status: "completed" | "interrupted" | "error";
  state: Record<string, unknown>;
  events: FlowgraphEvent[];
  interrupts?: InterruptInfo[] | undefined;
  error?: Error | undefined;
  durationMs: number;
}

/**
 * Compile a graph in-memory for tests, returning the compiled graph plus a
 * shared events array. The same in-memory checkpointer is reused, so
 * `run()` then `resume()` on the returned graph exercises the HITL flow.
 */
export async function compileForTest(
  spec: GraphSpec,
  opts: TestCompileOptions = {},
): Promise<{ compiled: CompiledGraph; events: FlowgraphEvent[] }> {
  const events: FlowgraphEvent[] = [];
  const compiled = await compileGraph(spec, {
    checkpointer: "memory",
    store: opts.store ?? "memory",
    sinks: [(ev) => { events.push(ev); }],
  });
  return { compiled, events };
}

/**
 * Run a graph spec in-memory and collect all events.
 * Useful for unit and integration tests.
 */
export async function runInMemory(
  spec: GraphSpec,
  opts: TestRunOptions = {},
): Promise<TestRunResult> {
  const collectedEvents: FlowgraphEvent[] = [];

  const compiled = await compileGraph(spec, {
    checkpointer: "memory",
    store: opts.store ?? "memory",
    sinks: [(ev) => { collectedEvents.push(ev); }],
  });

  const runOpts: Parameters<CompiledGraph["run"]>[0] = {};
  if (opts.input !== undefined) runOpts.input = opts.input;
  if (opts.threadId !== undefined) runOpts.threadId = opts.threadId;
  if (opts.onInterrupt !== undefined) runOpts.onInterrupt = opts.onInterrupt;
  if (opts.resolveInterrupt !== undefined) runOpts.resolveInterrupt = opts.resolveInterrupt;

  const result = await compiled.run(runOpts);
  const testResult: TestRunResult = {
    status: result.status,
    state: result.state,
    events: collectedEvents,
    durationMs: result.durationMs,
  };
  if (result.interrupts !== undefined) testResult.interrupts = result.interrupts;
  if (result.error !== undefined) testResult.error = result.error;
  return testResult;
}

/**
 * Load a graph from a YAML file and run it in-memory.
 */
export async function runGraphFile(
  filePath: string,
  opts: TestRunOptions & { cwd?: string } = {},
): Promise<TestRunResult> {
  const { spec, diagnostics } = await loadGraph(filePath, opts.cwd !== undefined ? { cwd: opts.cwd } : {});
  if (!spec) {
    throw new Error(`Failed to load graph: ${diagnostics.map((d) => d.message).join("; ")}`);
  }
  const cwd = opts.cwd ?? path.dirname(path.resolve(filePath));
  await loadGraphImports(spec, { cwd });
  const lintDiags = validateSpec(spec);
  const errors = lintDiags.filter((d) => d.severity === "error");
  if (errors.length > 0) {
    throw new Error(`Graph has errors: ${errors.map((e) => e.message).join("; ")}`);
  }
  return runInMemory(spec, opts);
}

/**
 * Helper: filter events by type.
 */
export function eventsOfType<T = unknown>(
  events: FlowgraphEvent[],
  type: string,
): FlowgraphEvent<T>[] {
  return events.filter((e) => e.type === type) as FlowgraphEvent<T>[];
}

export { loadGraph, validateSpec, loadGraphImports };
export type { GraphSpec, InterruptInfo };
