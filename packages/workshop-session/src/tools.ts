import { checkWorkshopOutput } from "@flowgraph/spec";
import { deepMerge, isPlainObject } from "./draft.js";
import type { WorkshopContract } from "./types.js";

/** Facilitator tools the realtime model may call to drive the workshop UI. */

export const FACILITATOR_TOOLS = [
  {
    type: "function",
    name: "update_draft",
    description: "Merge fields into the structured workshop output draft.",
    parameters: {
      type: "object",
      properties: {
        patch: { type: "object", description: "Partial output object to merge" },
      },
      required: ["patch"],
    },
  },
  {
    type: "function",
    name: "cover_agenda_item",
    description: "Mark an agenda item covered, with optional notes.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        notes: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    type: "function",
    name: "add_risk",
    description: "Record a surfaced risk on the draft.",
    parameters: {
      type: "object",
      properties: {
        risk: { type: "string" },
      },
      required: ["risk"],
    },
  },
  {
    type: "function",
    name: "finish",
    description:
      "End the workshop. Call only when the output schema is satisfied or the human asks to stop. If it returns an error, the session is still open: ask the human for what is missing.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "completed | skipped | timeout | human_ended" },
      },
    },
  },
] as const;

/**
 * Optional tool: only advertise it when the client actually serves artifact reads
 * (pass `tools: [...FACILITATOR_TOOLS, READ_ARTIFACT_TOOL]` to `WorkshopSession.start`
 * and answer `read_artifact` in `onToolCall`). `applyFacilitatorTool` does not handle it.
 */
export const READ_ARTIFACT_TOOL = {
  type: "function",
  name: "read_artifact",
  description: "Read a workshop artifact path via the governed host (sidecar or server).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
    },
    required: ["path"],
  },
} as const;

export type FacilitatorTool = (typeof FACILITATOR_TOOLS)[number] | typeof READ_ARTIFACT_TOOL;

export type FacilitatorToolName = FacilitatorTool["name"];

export type FacilitatorToolCall = {
  name: FacilitatorToolName | string;
  callId: string;
  args: Record<string, unknown>;
};

export type FacilitatorToolOptions = {
  /** `contract.schema`: `finish` is refused while the draft does not satisfy it. */
  schema?: Record<string, unknown> | undefined;
  /** `contract.allowPartial`: `finish` may end early with an unfinished draft. */
  allowPartial?: boolean | undefined;
};

export function applyFacilitatorTool(
  state: {
    draft: Record<string, unknown>;
    coverage: Record<string, boolean | string>;
    endedReason?: string;
  },
  call: FacilitatorToolCall,
  opts: FacilitatorToolOptions = {},
): { ok: boolean; result: unknown; finish?: boolean } {
  if (call.name === "update_draft") {
    const patch = call.args["patch"];
    if (isPlainObject(patch)) {
      state.draft = deepMerge(state.draft, patch);
    }
    return { ok: true, result: { draft: state.draft } };
  }
  if (call.name === "cover_agenda_item") {
    const id = String(call.args["id"] ?? "");
    const notes = typeof call.args["notes"] === "string" ? call.args["notes"] : true;
    if (id) state.coverage[id] = notes;
    return { ok: true, result: { coverage: state.coverage } };
  }
  if (call.name === "add_risk") {
    const risk = String(call.args["risk"] ?? "");
    const existing = Array.isArray(state.draft["risks"]) ? (state.draft["risks"] as unknown[]) : [];
    if (risk) state.draft = { ...state.draft, risks: [...existing, risk] };
    return { ok: true, result: { risks: state.draft["risks"] } };
  }
  if (call.name === "finish") {
    const reason = typeof call.args["reason"] === "string" ? call.args["reason"] : "completed";
    const check = checkWorkshopOutput(state.draft, {
      schema: opts.schema,
      endedReason: reason,
      allowPartial: opts.allowPartial,
      label: "draft",
    });
    if (check.error) {
      return { ok: false, result: { error: `Session not ended. ${check.error}` } };
    }
    state.endedReason = reason;
    return { ok: true, result: { endedReason: reason }, finish: true };
  }
  return { ok: false, result: { error: `unknown tool ${call.name}` } };
}

/** A tool definition as sent to a chat or realtime model. */
export type FacilitatorToolDef = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/** True when the schema declares `properties.risks` as an array. */
export function schemaHasRisksList(schema: Record<string, unknown> | undefined): boolean {
  const props = schema?.["properties"];
  if (!isPlainObject(props)) return false;
  const risks = props["risks"];
  return isPlainObject(risks) && risks["type"] === "array";
}

/** Names the controller itself serves (everything except `read_artifact`). */
export const CONTROLLER_TOOL_NAMES = [
  "set_field",
  "update_draft",
  "append_to_list",
  "cover_agenda_item",
  "add_risk",
  "finish",
] as const;

/**
 * Schema-aware facilitator tools for a contract (ADR-0018 section 5):
 * `set_field`, `update_draft`, `append_to_list`, `cover_agenda_item` (ids limited to the
 * agenda), `finish`, `add_risk` (only when the schema has a `risks` array) and, opt-in,
 * `read_artifact`.
 */
export function workshopTools(
  contract: Pick<WorkshopContract, "agenda" | "schema">,
  opts: { readArtifact?: boolean } = {},
): FacilitatorToolDef[] {
  const props = contract.schema?.["properties"];
  const fieldNames = isPlainObject(props) ? Object.keys(props) : [];
  const fieldHint = fieldNames.length ? ` Top-level fields: ${fieldNames.join(", ")}.` : "";
  const ids = contract.agenda.map((a) => a.id);
  const tools: FacilitatorToolDef[] = [
    {
      type: "function",
      name: "set_field",
      description: `Set one value in the output draft at a dot path (e.g. "owner.name"). Missing parent objects are created.${fieldHint}`,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Dot path into the draft" },
          value: { description: "Any JSON value" },
        },
        required: ["path", "value"],
      },
    },
    {
      type: "function",
      name: "update_draft",
      description:
        "Deep-merge a partial object into the output draft. Nested objects merge; arrays and scalars are replaced.",
      parameters: {
        type: "object",
        properties: { patch: { type: "object", description: "Partial output object to merge" } },
        required: ["patch"],
      },
    },
    {
      type: "function",
      name: "append_to_list",
      description: "Append one item to an array field of the draft (created if absent).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Dot path of the array field" },
          item: { description: "Any JSON value" },
        },
        required: ["path", "item"],
      },
    },
    {
      type: "function",
      name: "cover_agenda_item",
      description: "Mark an agenda item covered, with optional notes.",
      parameters: {
        type: "object",
        properties: {
          id: ids.length ? { type: "string", enum: ids } : { type: "string" },
          notes: { type: "string" },
        },
        required: ["id"],
      },
    },
  ];
  if (schemaHasRisksList(contract.schema)) {
    tools.push({
      type: "function",
      name: "add_risk",
      description: "Record a surfaced risk (alias of append_to_list on \"risks\").",
      parameters: { type: "object", properties: { risk: { type: "string" } }, required: ["risk"] },
    });
  }
  tools.push({
    type: "function",
    name: "finish",
    description:
      "End the workshop. It is refused (the session stays open) while the draft does not satisfy the output schema or agenda coverage; the result lists what is missing. Only an early stop requested by the human may use human_ended.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", enum: ["completed", "human_ended", "timeout", "skipped"] },
      },
    },
  });
  if (opts.readArtifact) tools.push({ ...READ_ARTIFACT_TOOL, parameters: { ...READ_ARTIFACT_TOOL.parameters } });
  return tools;
}
