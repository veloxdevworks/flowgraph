import type { FacilitatorMessage, FacilitatorModel } from "../text-facilitator.js";

export type OpenAICompatibleModelOptions = {
  apiKey: string;
  /** Required: the package does not pick a model. */
  model: string;
  /** Default https://api.openai.com/v1 */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
};

export function redactSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}

function toOpenAIMessages(system: string, messages: FacilitatorMessage[]): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "tool") out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    else {
      out.push({
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((t) => ({
                id: t.id,
                type: "function",
                function: { name: t.name, arguments: JSON.stringify(t.args) },
              })),
            }
          : {}),
      });
    }
  }
  return out;
}

/** Chat Completions with tools: OpenAI, xAI, and other compatible endpoints via `baseUrl`. */
export function openAICompatibleModel(opts: OpenAICompatibleModelOptions): FacilitatorModel {
  if (!opts.model) throw new Error("openAICompatibleModel: 'model' is required");
  const base = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  return {
    async respond({ system, messages, tools, signal }) {
      const f = opts.fetchImpl ?? fetch;
      const res = await f(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.apiKey}`,
          ...opts.headers,
        },
        body: JSON.stringify({
          model: opts.model,
          messages: toOpenAIMessages(system, messages),
          ...(tools.length
            ? {
                tools: tools.map((t) => ({
                  type: "function",
                  function: { name: t.name, description: t.description, parameters: t.parameters },
                })),
              }
            : {}),
        }),
        ...(signal ? { signal } : {}),
      });
      const raw = await res.text();
      if (!res.ok) {
        throw new Error(`chat completion failed (${res.status}): ${redactSecret(raw, opts.apiKey).slice(0, 500)}`);
      }
      let json: {
        choices?: {
          message?: {
            content?: string | null;
            tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
          };
        }[];
      };
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error("chat completion returned non-JSON");
      }
      const msg = json.choices?.[0]?.message;
      if (!msg) throw new Error("chat completion returned no choices");
      const toolCalls = (msg.tool_calls ?? []).map((t, i) => {
        let args: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(t.function?.arguments || "{}");
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        } catch {
          // malformed arguments: let the tool report what is missing
        }
        return { id: t.id ?? `call_${i}`, name: t.function?.name ?? "", args };
      });
      return { ...(msg.content ? { text: msg.content } : {}), toolCalls };
    },
  };
}
