import { registerMediaNodes, registerMediaVendors } from "@flowgraph/media";
import { registerDemoNode } from "@flowgraph/node-demo";
import { registerPortNode } from "@flowgraph/node-port";
import { registerServiceNode } from "@flowgraph/node-service";
import { registerWorkshopNode } from "@flowgraph/node-workshop";
import { registerWorktreeNode } from "@flowgraph/node-worktree";
import { registerLocalToolsSchema } from "@flowgraph/tools-fs";

/**
 * Register all default preview product node packages in the CLI process
 * so existing YAML graphs keep working out of the box.
 */
export function registerDefaultProductNodes(): void {
  registerPortNode();
  registerServiceNode();
  registerWorktreeNode();
  registerDemoNode();
  registerWorkshopNode();
  registerMediaNodes();
  registerMediaVendors();
  registerLocalToolsSchema();
}

registerDefaultProductNodes();
