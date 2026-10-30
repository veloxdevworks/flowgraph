/**
 * Message helpers: tool-call grouping, conversion between LangChain messages
 * (as stored in `type: messages` channels) and provider-neutral messages, and
 * deterministic ids for messages an agent appends to its history channel.
 */
import { createHash } from "node:crypto";
import {
  AIMessage,
  HumanMessage,
  RemoveMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { ContextMessage } from "./types.js";

/** Id prefix of the running-summary message an agent keeps in its history channel. */
export const SUMMARY_ID_PREFIX = "fg-summary-";

export function summaryMessageId(channel: string): string {
  return `${SUMMARY_ID_PREFIX}${channel}`;
}

/**
 * Split messages into units that are kept or dropped as a whole: an assistant
 * message with tool calls plus the tool results answering it, or any other
 * single message. Tool results with no matching call, and calls whose results
 * are missing, are returned as `invalid` (vendors reject both).
 */
export function toUnits(messages: ContextMessage[]): { units: ContextMessage[][]; invalid: ContextMessage[] } {
  const units: ContextMessage[][] = [];
  const invalid: ContextMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const want = new Set(m.toolCalls.map((c) => c.id));
      const results: ContextMessage[] = [];
      const stray: ContextMessage[] = [];
      let j = i + 1;
      while (j < messages.length && messages[j]!.role === "tool") {
        const t = messages[j]!;
        if (t.toolCallId !== undefined && want.has(t.toolCallId)) {
          want.delete(t.toolCallId);
          results.push(t);
        } else {
          stray.push(t);
        }
        j++;
      }
      if (want.size === 0) units.push([m, ...results]);
      else invalid.push(m, ...results);
      invalid.push(...stray);
      i = j;
      continue;
    }
    if (m.role === "tool") invalid.push(m);
    else units.push([m]);
    i++;
  }
  return { units, invalid };
}

type LcLike = {
  _getType?: () => string;
  getType?: () => string;
  type?: unknown;
  role?: unknown;
  content?: unknown;
  id?: unknown;
  name?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  additional_kwargs?: unknown;
};

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""))
      .join("");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

function roleOf(m: LcLike): ContextMessage["role"] | undefined {
  const raw = m._getType?.() ?? m.getType?.() ?? (typeof m.type === "string" ? m.type : undefined) ?? m.role;
  switch (raw) {
    case "human":
    case "user":
      return "user";
    case "ai":
    case "assistant":
      return "assistant";
    case "system":
      return "system";
    case "tool":
      return "tool";
    default:
      return undefined;
  }
}

/** Convert one stored message (LangChain instance or plain object). Unknown kinds return undefined. */
export function fromStoredMessage(raw: unknown): ContextMessage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = raw as LcLike;
  const role = roleOf(m);
  if (!role) return undefined;
  const out: ContextMessage = { role, content: contentText(m.content) };
  if (typeof m.id === "string") out.id = m.id;
  if (typeof m.name === "string") out.name = m.name;
  if (role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
    out.toolCalls = (m.tool_calls as Array<{ id?: unknown; name?: unknown; args?: unknown }>).map((c, k) => ({
      id: typeof c.id === "string" ? c.id : `call_${k}`,
      name: String(c.name ?? ""),
      args: c.args ?? {},
    }));
  }
  if (role === "tool" && typeof m.tool_call_id === "string") out.toolCallId = m.tool_call_id;
  if (role === "system") {
    const kw = m.additional_kwargs as Record<string, unknown> | undefined;
    const meta = kw?.["flowgraph"];
    if (meta && typeof meta === "object") out.meta = meta as Record<string, unknown>;
  }
  return out;
}

/** Build a LangChain message for a neutral one (used for channel writes and the LangChain provider). */
export function toLangChainMessage(m: ContextMessage): BaseMessage {
  const id = m.id !== undefined ? { id: m.id } : {};
  const name = m.name !== undefined ? { name: m.name } : {};
  switch (m.role) {
    case "system":
      return new SystemMessage({
        content: m.content,
        ...id,
        ...name,
        ...(m.meta ? { additional_kwargs: { flowgraph: m.meta } } : {}),
      });
    case "user":
      return new HumanMessage({ content: m.content, ...id, ...name });
    case "assistant":
      return new AIMessage({
        content: m.content,
        ...id,
        ...name,
        tool_calls: (m.toolCalls ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          args: (c.args && typeof c.args === "object" ? c.args : {}) as Record<string, unknown>,
          type: "tool_call" as const,
        })),
      });
    case "tool":
      return new ToolMessage({ content: m.content, tool_call_id: m.toolCallId ?? "", ...id, ...name });
  }
}

export function removeMessage(id: string): BaseMessage {
  return new RemoveMessage({ id });
}

/**
 * Deterministic id for a message appended to a history channel. The same node
 * appending the same turn after the same last message gets the same id, so a
 * replayed or resumed node upserts instead of duplicating.
 */
export function historyMessageId(channel: string, nodeId: string, prevId: string, index: number, m: ContextMessage): string {
  const h = createHash("sha256")
    .update([channel, nodeId, prevId, String(index), m.role, m.content, JSON.stringify(m.toolCalls ?? null), m.toolCallId ?? ""].join("\u0000"))
    .digest("hex")
    .slice(0, 24);
  return `fg-${h}`;
}

/** Plain-text transcript, for providers that take a single prompt and for summarizers. */
export function renderTranscript(messages: ContextMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === "assistant" && m.toolCalls?.length) {
        const calls = m.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(", ");
        return `assistant: ${m.content ? `${m.content} ` : ""}[called ${calls}]`;
      }
      if (m.role === "tool") return `tool result${m.toolCallId ? ` (${m.toolCallId})` : ""}: ${m.content}`;
      return `${m.role}: ${m.content}`;
    })
    .join("\n");
}
