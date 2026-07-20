/**
 * Register all built-in node types with the global registry.
 */
import { registry } from "../registry.js";
import { routerNode } from "./router.js";
import { httpNode } from "./http.js";
import { demoNode } from "./demo.js";
import { functionNode } from "./function.js";
import { shellNode } from "./shell.js";
import { serviceNode } from "./service.js";
import { portNode } from "./port.js";
import { scriptNode } from "./script.js";
import { waitNode } from "./wait.js";
import { skillNode } from "./skill.js";
import { agentNode } from "./agent.js";
import { subgraphNode } from "./subgraph.js";
import { mapNode } from "./map.js";
import { mcpNode } from "./mcp.js";
import { hitlNode } from "./hitl.js";
import { webhookNode } from "./webhook.js";
import "../providers/ask-human.js";
import "../providers/list-services.js";
import "../providers/service-tools.js";

// Register built-ins (idempotent — guard against double-import)
const BUILT_INS = [
  routerNode,
  httpNode,
  demoNode,
  functionNode,
  shellNode,
  serviceNode,
  portNode,
  scriptNode,
  waitNode,
  skillNode,
  agentNode,
  subgraphNode,
  mapNode,
  mcpNode,
  hitlNode,
  webhookNode,
];
for (const node of BUILT_INS) {
  if (!registry.has(node.type)) registry.register(node);
}

/** @deprecated Use functionNode */
export const codeNode = functionNode;
/** @deprecated Use agentNode */
export const intelligentNode = agentNode;

export {
  routerNode,
  httpNode,
  demoNode,
  functionNode,
  shellNode,
  serviceNode,
  portNode,
  scriptNode,
  waitNode,
  skillNode,
  agentNode,
  subgraphNode,
  mapNode,
  mcpNode,
  hitlNode,
  webhookNode,
};
