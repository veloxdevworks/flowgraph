# `@veloxdevworks/flowgraph-observability-otel`

OpenTelemetry traces/metrics/logs sink for flowgraph events. Attach it programmatically — the CLI `--otel` flag is **not wired** in 0.1.

```bash
pnpm add @veloxdevworks/flowgraph-observability-otel
```

```ts
import { compileGraph } from "@veloxdevworks/flowgraph-core";
import { otelSink } from "@veloxdevworks/flowgraph-observability-otel";

const compiled = await compileGraph(spec, {
  sinks: [otelSink()],
});
```

`startOtel()` is a turnkey OTLP setup; the SDK packages it loads must be installed separately.
