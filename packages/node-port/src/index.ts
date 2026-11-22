import { registry } from "@flowgraph/core";
import { portNode } from "./node.js";

/** Register the `port` node type with `@flowgraph/core` (idempotent). Runs on import. */
export function registerPortNode(): void {
  if (!registry.has(portNode.type)) registry.register(portNode);
}

registerPortNode();

export { portNode, PortWithSchema, type PortWith } from "./node.js";
export { findFreePorts, type FindFreePortsOptions } from "./port.js";
