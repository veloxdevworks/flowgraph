import { expect, it } from "vitest";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { fromStoredMessage } from "./messages.js";
it("turns a JSON/HTTP assistant message into inspectable role/content/tool calls", () => {
  const raw = JSON.parse(
    JSON.stringify(
      new AIMessage({
        content: "answer",
        tool_calls: [{ id: "call-1", name: "lookup", args: { id: 4 } }],
      }),
    ),
  );
  expect(fromStoredMessage(raw)).toMatchObject({
    role: "assistant",
    content: "answer",
    toolCalls: [{ id: "call-1", name: "lookup", args: { id: 4 } }],
  });
});
it("preserves the tool call link after serializing a tool message", () => {
  const raw = JSON.parse(
    JSON.stringify(new ToolMessage({ content: "result", tool_call_id: "call-1" })),
  );
  expect(fromStoredMessage(raw)).toMatchObject({
    role: "tool",
    content: "result",
    toolCallId: "call-1",
  });
});
