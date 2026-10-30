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
    name: "read_artifact",
    description: "Read a workshop artifact path via the governed host (sidecar or server).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  },
  {
    type: "function",
    name: "finish",
    description: "End the workshop. Call only when the output schema is satisfied or the human asks to stop.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "completed | skipped | timeout | human_ended" },
      },
    },
  },
] as const;

export type FacilitatorToolName = (typeof FACILITATOR_TOOLS)[number]["name"];

export type FacilitatorToolCall = {
  name: FacilitatorToolName | string;
  callId: string;
  args: Record<string, unknown>;
};

export function applyFacilitatorTool(
  state: {
    draft: Record<string, unknown>;
    coverage: Record<string, boolean | string>;
    endedReason?: string;
  },
  call: FacilitatorToolCall,
): { ok: boolean; result: unknown; finish?: boolean } {
  if (call.name === "update_draft") {
    const patch = call.args["patch"];
    if (patch && typeof patch === "object" && !Array.isArray(patch)) {
      state.draft = { ...state.draft, ...(patch as Record<string, unknown>) };
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
    state.endedReason = reason;
    return { ok: true, result: { endedReason: reason }, finish: true };
  }
  return { ok: false, result: { error: `unknown tool ${call.name}` } };
}
