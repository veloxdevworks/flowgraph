import { describe, it, expect } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { compileGraph, registerFunction, type GraphSpec } from "@veloxdevworks/flowgraph-core";
import { otelSink } from "./index.js";

function demoSpec(): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "otel-demo" },
    state: { channels: { greeting: { type: "string", reducer: "lastWrite" } } },
    nodes: [
      { id: "hello", type: "function", with: { fn: "otelHello" } },
      { id: "world", type: "function", with: { fn: "otelWorld" } },
    ],
    edges: [
      { from: "START", to: "hello" },
      { from: "hello", to: "world" },
      { from: "world", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
}

describe("otelSink", () => {
  it("emits nested run + node spans for a run", async () => {
    registerFunction("otelHello", () => ({ greeting: "hi" }));
    registerFunction("otelWorld", () => ({ greeting: "world" }));

    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const tracer = provider.getTracer("test");

    const compiled = await compileGraph(demoSpec(), {
      sinks: [otelSink({ tracer, metricsEnabled: false })],
      checkpointer: "none",
    });
    const res = await compiled.run({});
    expect(res.status).toBe("completed");

    const spans = exporter.getFinishedSpans();
    const names = spans.map((s) => s.name).sort();
    expect(names).toContain("run otel-demo");
    expect(names).toContain("node hello");
    expect(names).toContain("node world");

    // node spans are children of the run span
    const root = spans.find((s) => s.name === "run otel-demo")!;
    const node = spans.find((s) => s.name === "node hello")!;
    expect(node.parentSpanContext?.spanId ?? (node as unknown as { parentSpanId?: string }).parentSpanId)
      .toBe(root.spanContext().spanId);

    // flowgraph.* attributes present
    expect(node.attributes["flowgraph.node.id"]).toBe("hello");
    expect(node.attributes["flowgraph.graph"]).toBe("otel-demo");

    await provider.shutdown();
  });
});
