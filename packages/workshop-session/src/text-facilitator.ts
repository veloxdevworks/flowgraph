import type { WorkshopController } from "./controller.js";
import type { FacilitatorToolDef } from "./tools.js";

export type FacilitatorToolRequest = { id: string; name: string; args: Record<string, unknown> };

export type FacilitatorMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: FacilitatorToolRequest[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/** One chat turn with tools. The only thing a host supplies to run a text facilitator. */
export interface FacilitatorModel {
  respond(req: {
    system: string;
    messages: FacilitatorMessage[];
    tools: FacilitatorToolDef[];
    signal?: AbortSignal;
  }): Promise<{ text?: string; toolCalls: FacilitatorToolRequest[] }>;
}

export type TextFacilitatorOptions = {
  /** Max model calls per user turn (tool loop guard). Default 8. */
  maxSteps?: number;
  /** Serve `read_artifact`; when set the tool is advertised. */
  readArtifact?: (path: string) => Promise<unknown> | unknown;
};

export type TextFacilitatorReply = {
  /** Assistant text produced during this turn (may be empty if the session ended silently). */
  reply: string;
  ended: boolean;
  /** True when the step cap stopped the loop before the model gave a final answer. */
  stepLimitReached?: boolean;
};

const START_KICK = "(The human has just joined. Open the workshop: greet them briefly and start on the agenda.)";
const RESUME_KICK = "(The session was interrupted and has resumed. Briefly say where we are and continue.)";

/** Drives a `WorkshopController` with a text `FacilitatorModel`. */
export class TextFacilitator {
  private messages: FacilitatorMessage[] = [];
  private readonly maxSteps: number;

  constructor(
    readonly controller: WorkshopController,
    private readonly model: FacilitatorModel,
    private readonly opts: TextFacilitatorOptions = {},
  ) {
    this.maxSteps = Math.max(1, opts.maxSteps ?? 8);
    // Restored controller: rebuild the conversation from the transcript.
    for (const t of controller.state.transcript) {
      if (t.role === "user") this.messages.push({ role: "user", content: t.text });
      else if (t.role === "assistant") this.messages.push({ role: "assistant", content: t.text });
    }
  }

  /** Conversation so far (read-only copy). */
  get history(): readonly FacilitatorMessage[] {
    return [...this.messages];
  }

  /** The facilitator's opening (or, after `restore`, resuming) message. */
  async start(opts: { signal?: AbortSignal } = {}): Promise<TextFacilitatorReply> {
    const resumed = this.messages.length > 0;
    this.messages.push({ role: "user", content: resumed ? RESUME_KICK : START_KICK });
    return this.run(opts.signal);
  }

  /** Send the human's text and run the model/tool loop until the model answers or the session ends. */
  async send(userText: string, opts: { signal?: AbortSignal } = {}): Promise<TextFacilitatorReply> {
    if (this.controller.ended) throw new Error("workshop session already ended");
    this.controller.addTurn({ role: "user", text: userText });
    this.messages.push({ role: "user", content: userText });
    return this.run(opts.signal);
  }

  private async run(signal?: AbortSignal): Promise<TextFacilitatorReply> {
    const c = this.controller;
    const texts: string[] = [];
    for (let step = 0; step < this.maxSteps; step++) {
      if (signal?.aborted) throw abortError();
      const res = await this.model.respond({
        system: c.instructions(),
        messages: this.messages,
        tools: c.tools({ readArtifact: Boolean(this.opts.readArtifact) }),
        ...(signal ? { signal } : {}),
      });
      const text = res.text?.trim() ?? "";
      const calls = res.toolCalls ?? [];
      this.messages.push({ role: "assistant", content: text, ...(calls.length ? { toolCalls: calls } : {}) });
      if (text) {
        texts.push(text);
        c.addTurn({ role: "assistant", text });
      }
      if (calls.length === 0) return { reply: texts.join("\n\n"), ended: c.ended };
      for (const call of calls) {
        const out = await this.runTool(call);
        this.messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify(out) });
      }
      if (c.ended) return { reply: texts.join("\n\n"), ended: true };
    }
    return { reply: texts.join("\n\n"), ended: c.ended, stepLimitReached: true };
  }

  private async runTool(call: FacilitatorToolRequest): Promise<unknown> {
    if (call.name === "read_artifact" && this.opts.readArtifact) {
      try {
        return { ok: true, content: await this.opts.readArtifact(String(call.args["path"] ?? "")) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    const r = this.controller.apply({ name: call.name, callId: call.id, args: call.args });
    return { ok: r.ok, ...r.result };
  }
}

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}
