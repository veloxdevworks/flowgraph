import type { FacilitatorMessage, FacilitatorModel } from "../text-facilitator.js";
import { redactSecret } from "./openai-compatible.js";

export type AnthropicModelOptions = {
  apiKey: string;
  /** Required: the package does not pick a model. */
  model: string;
  /** Default https://api.anthropic.com */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Default 2048. */
  maxTokens?: number;
};

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };
type Msg = { role: "user" | "assistant"; content: Block[] };

/** Map to Messages API turns: tool results ride in user turns, same-role turns are merged. */
export function toAnthropicMessages(messages: FacilitatorMessage[]): Msg[] {
  const out: Msg[] = [];
  const push = (role: Msg["role"], blocks: Block[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === "user") push("user", [{ type: "text", text: m.content }]);
    else if (m.role === "tool") push("user", [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }]);
    else {
      const blocks: Block[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const t of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: t.id, name: t.name, input: t.args });
      if (blocks.length) push("assistant", blocks);
    }
  }
  // tool_result blocks must precede text within a user turn
  for (const m of out) {
    if (m.role === "user") m.content.sort((a, b) => Number(b.type === "tool_result") - Number(a.type === "tool_result"));
  }
  if (out[0]?.role === "assistant") out.unshift({ role: "user", content: [{ type: "text", text: "(begin)" }] });
  return out;
}

/** Anthropic Messages API with `tool_use` / `tool_result` blocks. */
export function anthropicModel(opts: AnthropicModelOptions): FacilitatorModel {
  if (!opts.model) throw new Error("anthropicModel: 'model' is required");
  const base = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  return {
    async respond({ system, messages, tools, signal }) {
      const f = opts.fetchImpl ?? fetch;
      const res = await f(`${base}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: opts.maxTokens ?? 2048,
          system,
          messages: toAnthropicMessages(messages),
          ...(tools.length
            ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) }
            : {}),
        }),
        ...(signal ? { signal } : {}),
      });
      const raw = await res.text();
      if (!res.ok) {
        throw new Error(`messages request failed (${res.status}): ${redactSecret(raw, opts.apiKey).slice(0, 500)}`);
      }
      let json: { content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> };
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error("messages response was not JSON");
      }
      const text: string[] = [];
      const toolCalls: { id: string; name: string; args: Record<string, unknown> }[] = [];
      for (const b of json.content ?? []) {
        if (b.type === "text" && b.text) text.push(b.text);
        else if (b.type === "tool_use") {
          const input = b.input && typeof b.input === "object" && !Array.isArray(b.input) ? b.input : {};
          toolCalls.push({ id: b.id ?? `toolu_${toolCalls.length}`, name: b.name ?? "", args: input as Record<string, unknown> });
        }
      }
      return { ...(text.length ? { text: text.join("\n") } : {}), toolCalls };
    },
  };
}
