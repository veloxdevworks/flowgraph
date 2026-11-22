import { FailWithSchema } from "@flowgraph/spec";
import { stringifyRendered } from "@flowgraph/expr";
import { defineNode } from "../registry.js";
import { FlowFailureError } from "../runtime/failure.js";

export const failNode = defineNode({
  type: "fail",
  configSchema: FailWithSchema,
  capabilities: { terminal: true, hostAccess: false },
  build(_build, _node, config) {
    return {
      contract: {},
      capabilities: { terminal: true, hostAccess: false },
      async run(_state, ctx) {
        const reason = stringifyRendered(ctx.render(config.reason));
        throw new FlowFailureError(reason.trim() || "Run failed");
      },
    };
  },
});
