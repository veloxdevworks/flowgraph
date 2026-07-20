/**
 * Re-export output helpers for node implementations.
 * Implementation lives in runtime/ so validate-graph can share it without a cycle.
 */
export {
  applyOutput,
  isOutputNone,
  OUTPUTS_CHANNEL,
  type ApplyOutputOpts,
} from "../runtime/apply-output.js";
