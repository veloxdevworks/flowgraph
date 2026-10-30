import { createInMemoryMemoryBackend } from "@flowgraph/core";
import { describeMemoryBackendConformance } from "./memory-conformance.js";

describeMemoryBackendConformance("in-memory", async () => ({ backend: createInMemoryMemoryBackend() }));
