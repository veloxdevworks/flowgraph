/**
 * Register all built-in node types with the global registry.
 */
import { registry } from "../registry.js";
import { routerNode } from "./router.js";
import { httpNode } from "./http.js";
import { codeNode } from "./code.js";
import { waitNode } from "./wait.js";
import { skillNode } from "./skill.js";
import { intelligentNode } from "./intelligent.js";
import { subgraphNode } from "./subgraph.js";
import { mapNode } from "./map.js";
import { mcpNode } from "./mcp.js";
import { hitlNode } from "./hitl.js";
import { webhookNode } from "./webhook.js";
import "../providers/ask-human.js";

// Register built-ins (idempotent — guard against double-import)
const BUILT_INS = [routerNode, httpNode, codeNode, waitNode, skillNode, intelligentNode, subgraphNode, mapNode, mcpNode, hitlNode, webhookNode];
for (const node of BUILT_INS) {
  if (!registry.has(node.type)) registry.register(node);
}

export { routerNode, httpNode, codeNode, waitNode, skillNode, intelligentNode, subgraphNode, mapNode, mcpNode, hitlNode, webhookNode };
