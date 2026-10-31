import { createInMemoryThreadOwnerRegistry } from "@flowgraph/core";
import { describeThreadOwnerRegistryConformance } from "./thread-owner-conformance.js";

describeThreadOwnerRegistryConformance("in-memory", async () => ({ registry: createInMemoryThreadOwnerRegistry() }));
