import { AsyncLocalStorage } from "node:async_hooks";

const environments = new AsyncLocalStorage<NodeJS.ProcessEnv>();

/** Environment for this invocation. Hosts can isolate overlapping runs without mutating process.env. */
export function currentEnvironment(): NodeJS.ProcessEnv {
  return environments.getStore() ?? process.env;
}

/** Snapshot the host environment plus this invocation's overrides for its asynchronous lifetime. */
export function withEnvironment<T>(env: NodeJS.ProcessEnv | undefined, action: () => T): T {
  return environments.run({ ...currentEnvironment(), ...env }, action);
}
