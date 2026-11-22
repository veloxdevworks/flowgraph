import {
  assertHostExecAllowed,
  assertNodeTypeAllowed,
  registry,
  SERVICES_CHANNEL,
} from "@flowgraph/core";
import { serviceNode } from "./node.js";
import { registerListServiceTools } from "./list-services.js";
import { registerServiceLifecycleTools } from "./service-tools.js";
import {
  startService,
  statusService,
  terminateThreadServices,
  type ServiceStartSpec,
} from "./service-manager.js";

/** Register the `service` node, agent tools, and run lifecycle hooks (idempotent). Runs on import. */
export function registerServiceNode(): void {
  if (!registry.has(serviceNode.type)) registry.register(serviceNode);
  registerListServiceTools();
  registerServiceLifecycleTools();
  registry.registerRunLifecycle("service-lifecycle", {
    async onRunEnd({ spec, threadId }) {
      const terminate = spec.runtime?.services?.terminateOnEnd ?? true;
      if (terminate) {
        try {
          await terminateThreadServices(threadId);
        } catch {
          /* best-effort cleanup — do not fail the run result */
        }
      }
    },
    async onHydrate({ spec, threadId, snapshotValues, nodePolicy }) {
      if (!spec.runtime?.services?.rehydrateOnResume) return;
      const intents = snapshotValues?.[SERVICES_CHANNEL];
      if (!intents || typeof intents !== "object") return;
      for (const [name, raw] of Object.entries(intents as Record<string, unknown>)) {
        if (!raw || typeof raw !== "object") continue;
        const current = statusService(threadId, name);
        if (current.status === "running") continue;
        const serviceSpec = raw as ServiceStartSpec;
        try {
          assertNodeTypeAllowed(nodePolicy, "service", `rehydrating service "${name}"`);
          assertHostExecAllowed(nodePolicy, `service "${name}"`, `rehydrating service "${name}"`);
          await startService(threadId, { ...serviceSpec, name });
        } catch (err) {
          (raw as Record<string, unknown>)["needsRestart"] = true;
          (raw as Record<string, unknown>)["rehydrateError"] = err instanceof Error ? err.message : String(err);
        }
      }
    },
  });
}

registerServiceNode();

export { serviceNode } from "./node.js";
export { ServiceReadySchema, ServiceWithSchema, type ServiceWith } from "./schema.js";
export {
  startService,
  stopService,
  restartService,
  statusService,
  terminateThreadServices,
  resetServiceManager,
  listThreadServices,
  threadIdOf,
  type ServiceReady,
  type ServiceStartSpec,
  type ServiceInfo,
  type ServiceStatusValue,
} from "./service-manager.js";
