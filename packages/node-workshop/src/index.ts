import { registry } from "@flowgraph/core";
import { workshopNode } from "./node.js";

/** Register the `workshop` node type with `@flowgraph/core` (idempotent). Runs on import. */
export function registerWorkshopNode(): void {
  if (!registry.has(workshopNode.type)) registry.register(workshopNode);
}

registerWorkshopNode();

export {
  workshopNode,
  normalizeAgenda,
  mapWorkshopResume,
  WORKSHOP_MAX_PATCH_BYTES,
} from "./node.js";
export {
  WorkshopAgendaItemSchema,
  WorkshopVoiceSchema,
  WorkshopLimitsSchema,
  WorkshopWithSchema,
  type WorkshopWith,
} from "./schema.js";
export type {
  WorkshopAgendaItem,
  WorkshopVoiceHints,
  WorkshopLimits,
  WorkshopDiff,
  WorkshopContract,
  WorkshopTranscriptTurn,
  WorkshopResume,
  WorkshopResult,
  WorkshopFormUi,
} from "./workshop-contract.js";
export {
  checkWorkshopOutput,
  uncoveredAgendaItems,
  WORKSHOP_PARTIAL_END_REASONS,
  type WorkshopOutputCheck,
} from "./workshop-output.js";
