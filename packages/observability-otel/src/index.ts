/**
 * @veloxdevworks/flowgraph-observability-otel
 *
 * Maps the flowgraph event tree to OpenTelemetry signals with zero user
 * instrumentation:
 *   - Traces: a span per run / node, nested via the event scope. Intelligent
 *     steps, tool calls, skills and logs attach as span events.
 *   - Metrics: counters/histograms for node runs, errors, durations, tokens,
 *     interrupts.
 *
 * Follows OTel GenAI semantic conventions for LLM attributes where applicable,
 * plus a small `flowgraph.*` namespace. Uses only `@opentelemetry/api` so it
 * drops into any configured SDK/exporter. `startOtel()` provides a turnkey
 * OTLP setup (the SDK packages are loaded lazily and must be installed).
 */

import {
  trace,
  context as otelContext,
  SpanStatusCode,
  SpanKind,
  metrics,
  type Span,
  type Context,
  type Tracer,
  type Meter,
  type Counter,
  type Histogram,
  type Attributes,
} from "@opentelemetry/api";

// EventSink is structurally `(event) => void | Promise<void>`. We keep the
// event type local so this package needn't hard-depend on core's value exports.
interface FlowgraphEventLike {
  type: string;
  ts: string;
  runId: string;
  threadId?: string | undefined;
  graph: string;
  scope: { nodeId?: string; nodeType?: string; attempt?: number };
  data: unknown;
  seq: number;
}
type EventSink = (event: FlowgraphEventLike) => void | Promise<void>;

const PKG_VERSION = "0.1.0";

// --- Semantic attribute keys --------------------------------------------------
const ATTR = {
  graph: "flowgraph.graph",
  runId: "flowgraph.run.id",
  threadId: "flowgraph.thread.id",
  nodeId: "flowgraph.node.id",
  nodeType: "flowgraph.node.type",
  attempt: "flowgraph.attempt",
  provider: "flowgraph.provider",
  // OTel GenAI semconv (subset)
  genaiSystem: "gen_ai.system",
  genaiModel: "gen_ai.request.model",
  genaiInTokens: "gen_ai.usage.input_tokens",
  genaiOutTokens: "gen_ai.usage.output_tokens",
  genaiTotalTokens: "gen_ai.usage.total_tokens",
} as const;

export interface OtelSinkOptions {
  /** Tracer to use. Defaults to the global tracer "flowgraph". */
  tracer?: Tracer;
  /** Meter to use. Defaults to the global meter "flowgraph". */
  meter?: Meter;
  /** Disable metric recording (spans only). */
  metricsEnabled?: boolean;
}

interface NodeSpanState {
  span: Span;
  ctx: Context;
  start: number;
}

interface RunSpanState {
  root: Span;
  rootCtx: Context;
  nodes: Map<string, NodeSpanState>;
}

/**
 * An EventSink that emits OpenTelemetry spans + metrics for a run.
 * Safe to share across concurrent runs (state keyed by runId).
 */
export function otelSink(opts: OtelSinkOptions = {}): EventSink {
  const tracer = opts.tracer ?? trace.getTracer("flowgraph", PKG_VERSION);
  const meter = opts.meter ?? metrics.getMeter("flowgraph", PKG_VERSION);
  const metricsEnabled = opts.metricsEnabled !== false;

  let nodeRuns: Counter | undefined;
  let nodeErrors: Counter | undefined;
  let nodeDuration: Histogram | undefined;
  let runDuration: Histogram | undefined;
  let tokens: Counter | undefined;
  let interrupts: Counter | undefined;
  if (metricsEnabled) {
    nodeRuns = meter.createCounter("flowgraph.node.runs", { description: "Node executions" });
    nodeErrors = meter.createCounter("flowgraph.node.errors", { description: "Node errors" });
    nodeDuration = meter.createHistogram("flowgraph.node.duration", { unit: "ms", description: "Node duration" });
    runDuration = meter.createHistogram("flowgraph.run.duration", { unit: "ms", description: "Run duration" });
    tokens = meter.createCounter("flowgraph.tokens", { description: "LLM tokens consumed" });
    interrupts = meter.createCounter("flowgraph.interrupts", { description: "HITL interrupts raised" });
  }

  const runs = new Map<string, RunSpanState>();

  const baseAttrs = (ev: FlowgraphEventLike): Attributes => {
    const a: Attributes = { [ATTR.graph]: ev.graph, [ATTR.runId]: ev.runId };
    if (ev.threadId) a[ATTR.threadId] = ev.threadId;
    return a;
  };

  const nodeAttrs = (ev: FlowgraphEventLike): Attributes => {
    const a = baseAttrs(ev);
    if (ev.scope.nodeId) a[ATTR.nodeId] = ev.scope.nodeId;
    if (ev.scope.nodeType) a[ATTR.nodeType] = ev.scope.nodeType;
    if (ev.scope.attempt !== undefined) a[ATTR.attempt] = ev.scope.attempt;
    return a;
  };

  const activeNodeSpan = (ev: FlowgraphEventLike): Span | undefined => {
    const rs = runs.get(ev.runId);
    if (!rs) return undefined;
    if (ev.scope.nodeId) return rs.nodes.get(ev.scope.nodeId)?.span;
    return rs.root;
  };

  return (ev) => {
    try {
      switch (ev.type) {
        case "run.start": {
          const root = tracer.startSpan(`run ${ev.graph}`, { kind: SpanKind.INTERNAL, attributes: baseAttrs(ev) });
          const rootCtx = trace.setSpan(otelContext.active(), root);
          runs.set(ev.runId, { root, rootCtx, nodes: new Map() });
          break;
        }
        case "node.start": {
          const rs = runs.get(ev.runId);
          if (!rs || !ev.scope.nodeId) break;
          const span = tracer.startSpan(
            `node ${ev.scope.nodeId}`,
            { kind: SpanKind.INTERNAL, attributes: nodeAttrs(ev) },
            rs.rootCtx,
          );
          rs.nodes.set(ev.scope.nodeId, { span, ctx: trace.setSpan(rs.rootCtx, span), start: Date.now() });
          nodeRuns?.add(1, nodeAttrs(ev));
          break;
        }
        case "node.end": {
          const rs = runs.get(ev.runId);
          const ns = ev.scope.nodeId ? rs?.nodes.get(ev.scope.nodeId) : undefined;
          if (ns) {
            nodeDuration?.record(Date.now() - ns.start, nodeAttrs(ev));
            ns.span.setStatus({ code: SpanStatusCode.OK });
            ns.span.end();
            rs?.nodes.delete(ev.scope.nodeId!);
          }
          break;
        }
        case "node.error": {
          const rs = runs.get(ev.runId);
          const ns = ev.scope.nodeId ? rs?.nodes.get(ev.scope.nodeId) : undefined;
          const msg = (ev.data as { error?: string })?.error ?? "node error";
          nodeErrors?.add(1, nodeAttrs(ev));
          if (ns) {
            ns.span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
            ns.span.recordException(msg);
            ns.span.end();
            rs?.nodes.delete(ev.scope.nodeId!);
          }
          break;
        }
        case "node.retry":
        case "node.timeout":
        case "node.skipped": {
          activeNodeSpan(ev)?.addEvent(ev.type, toAttrs(ev.data));
          break;
        }
        case "agent.step": {
          const span = activeNodeSpan(ev);
          if (span) {
            const d = ev.data as { provider?: string; model?: string };
            if (d.provider) {
              span.setAttribute(ATTR.provider, d.provider);
              span.setAttribute(ATTR.genaiSystem, d.provider);
            }
            if (d.model) span.setAttribute(ATTR.genaiModel, d.model);
            span.addEvent("agent.step", toAttrs(ev.data));
          }
          break;
        }
        case "agent.tool.call":
        case "agent.tool.result":
        case "agent.token": {
          activeNodeSpan(ev)?.addEvent(ev.type, toAttrs(ev.data));
          break;
        }
        case "agent.usage": {
          const span = activeNodeSpan(ev);
          const u = ev.data as { promptTokens?: number; completionTokens?: number; totalTokens?: number };
          if (span) {
            if (u.promptTokens !== undefined) span.setAttribute(ATTR.genaiInTokens, u.promptTokens);
            if (u.completionTokens !== undefined) span.setAttribute(ATTR.genaiOutTokens, u.completionTokens);
            if (u.totalTokens !== undefined) span.setAttribute(ATTR.genaiTotalTokens, u.totalTokens);
          }
          if (u.totalTokens) tokens?.add(u.totalTokens, nodeAttrs(ev));
          break;
        }
        case "skill.start":
        case "skill.end":
        case "skill.error":
        case "skill.preflight": {
          activeNodeSpan(ev)?.addEvent(ev.type, toAttrs(ev.data));
          break;
        }
        case "interrupt.raised": {
          interrupts?.add(1, baseAttrs(ev));
          (activeNodeSpan(ev) ?? runs.get(ev.runId)?.root)?.addEvent("interrupt.raised", toAttrs(ev.data));
          break;
        }
        case "interrupt.resumed":
        case "hook.invoked":
        case "hook.error":
        case "log": {
          (activeNodeSpan(ev) ?? runs.get(ev.runId)?.root)?.addEvent(ev.type, toAttrs(ev.data));
          break;
        }
        case "run.end": {
          const rs = runs.get(ev.runId);
          if (rs) {
            // close any dangling node spans
            for (const ns of rs.nodes.values()) ns.span.end();
            const dur = (ev.data as { durationMs?: number })?.durationMs;
            if (dur !== undefined) runDuration?.record(dur, baseAttrs(ev));
            rs.root.setStatus({ code: SpanStatusCode.OK });
            rs.root.end();
            runs.delete(ev.runId);
          }
          break;
        }
        case "run.error":
        case "run.aborted": {
          const rs = runs.get(ev.runId);
          if (rs) {
            const msg = (ev.data as { error?: string })?.error ?? "run error";
            for (const ns of rs.nodes.values()) ns.span.end();
            rs.root.setStatus({ code: SpanStatusCode.ERROR, message: msg });
            rs.root.end();
            runs.delete(ev.runId);
          }
          break;
        }
      }
    } catch {
      // Observability must never break a run.
    }
  };
}

/** Coerce arbitrary event data into flat OTel-safe attributes. */
function toAttrs(data: unknown): Attributes {
  const out: Attributes = {};
  if (data == null || typeof data !== "object") {
    if (data !== undefined) out["value"] = String(data);
    return out;
  }
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (v == null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else out[k] = JSON.stringify(v).slice(0, 1024);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Turnkey OTLP setup (SDK packages loaded lazily; install them to use this).
// ---------------------------------------------------------------------------

export interface OtelSetupOptions {
  serviceName?: string;
  /** OTLP/HTTP traces endpoint, e.g. http://localhost:4318/v1/traces */
  traceEndpoint?: string;
  /** OTLP/HTTP metrics endpoint, e.g. http://localhost:4318/v1/metrics */
  metricEndpoint?: string;
}

export interface OtelHandle {
  shutdown(): Promise<void>;
}

/**
 * Configure a global tracer + meter provider exporting via OTLP/HTTP.
 * Requires `@opentelemetry/sdk-trace-node`, `@opentelemetry/sdk-trace-base`,
 * `@opentelemetry/sdk-metrics`, `@opentelemetry/resources`, and the OTLP
 * exporters to be installed. Returns a handle with `shutdown()`.
 */
export async function startOtel(opts: OtelSetupOptions = {}): Promise<OtelHandle> {
  // Non-literal specifiers keep tsc from resolving these optional deps.
  const load = (name: string): Promise<Record<string, unknown>> => import(name);

  const serviceName = opts.serviceName ?? "flowgraph";
  const resourcesMod = await load("@opentelemetry/resources");
  const resourceFromAttributes = resourcesMod["resourceFromAttributes"] as
    | ((attrs: Record<string, unknown>) => unknown)
    | undefined;
  const resource = resourceFromAttributes?.({ "service.name": serviceName });

  const traceBase = await load("@opentelemetry/sdk-trace-base");
  const traceNode = await load("@opentelemetry/sdk-trace-node");
  const traceExporterMod = await load("@opentelemetry/exporter-trace-otlp-http");
  const OTLPTraceExporter = traceExporterMod["OTLPTraceExporter"] as new (cfg: unknown) => unknown;
  const BatchSpanProcessor = traceBase["BatchSpanProcessor"] as new (exp: unknown) => unknown;
  const NodeTracerProvider = traceNode["NodeTracerProvider"] as new (cfg: unknown) => {
    register(): void;
    shutdown(): Promise<void>;
  };

  const spanProcessor = new BatchSpanProcessor(
    new OTLPTraceExporter(opts.traceEndpoint ? { url: opts.traceEndpoint } : {}),
  );
  const tracerProvider = new NodeTracerProvider({
    ...(resource ? { resource } : {}),
    spanProcessors: [spanProcessor],
  });
  tracerProvider.register();

  const metricsMod = await load("@opentelemetry/sdk-metrics");
  const metricExporterMod = await load("@opentelemetry/exporter-metrics-otlp-http");
  const OTLPMetricExporter = metricExporterMod["OTLPMetricExporter"] as new (cfg: unknown) => unknown;
  const PeriodicExportingMetricReader = metricsMod["PeriodicExportingMetricReader"] as new (cfg: unknown) => unknown;
  const MeterProvider = metricsMod["MeterProvider"] as new (cfg: unknown) => {
    shutdown(): Promise<void>;
  };
  const meterProvider = new MeterProvider({
    ...(resource ? { resource } : {}),
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(opts.metricEndpoint ? { url: opts.metricEndpoint } : {}),
      }),
    ],
  });
  metrics.setGlobalMeterProvider(meterProvider as unknown as Parameters<typeof metrics.setGlobalMeterProvider>[0]);

  return {
    async shutdown() {
      await tracerProvider.shutdown();
      await meterProvider.shutdown();
    },
  };
}
