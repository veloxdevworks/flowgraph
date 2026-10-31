/**
 * Summarizing left-out messages with a model. The agent node wraps this with
 * its replay cache, so a resumed or replayed run reuses the stored summary
 * instead of calling the model again.
 */
import type { NodeRunContext } from "../context.js";
import type { AgentRequest, ProviderAdapter, TokenUsage } from "../providers/types.js";
import { truncateToTokens, type TokenEstimator } from "./estimator.js";
import { renderTranscript } from "./messages.js";
import type { SummarizeRequest } from "./window.js";

/** Longest single message passed to the summarizer, in tokens. */
const MESSAGE_CAP_TOKENS = 1000;

export function summaryInstructions(maxTokens: number, extra?: string): string {
  return [
    "You maintain a running summary of a conversation between a user, an assistant, and tools.",
    "Merge the new messages into the summary. Keep facts, decisions, open questions, names, ids, numbers and file paths;",
    "drop pleasantries and repeated tool output. Write plain text, newest information last.",
    `Stay under about ${maxTokens} tokens. Reply with the summary only.`,
    ...(extra ? [extra] : []),
  ].join(" ");
}

/** Build the summarizer prompt; long messages and transcripts are cut so the call itself stays bounded. */
export function summaryPrompt(req: SummarizeRequest, est: TokenEstimator): string {
  const transcriptCap = Math.max(4000, req.maxTokens * 8);
  const capped = req.messages.map((m) => ({ ...m, content: truncateToTokens(m.content, MESSAGE_CAP_TOKENS, est, () => " …") }));
  let transcript = renderTranscript(capped);
  if (est(transcript) > transcriptCap) {
    // keep the newest part
    const chars = Array.from(transcript);
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (est(chars.slice(mid).join("")) <= transcriptCap) hi = mid;
      else lo = mid + 1;
    }
    transcript = `…\n${chars.slice(lo).join("")}`;
  }
  return [
    req.previous ? `Summary so far:\n${req.previous}` : "Summary so far: (none)",
    `New messages:\n${transcript}`,
  ].join("\n\n");
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    for (const k of ["summary", "text", "content", "output"]) if (typeof o[k] === "string") return o[k] as string;
  }
  return JSON.stringify(output ?? "");
}

/** One summarizer model call with no tools. */
export async function summarizeWithProvider(
  provider: ProviderAdapter,
  req: SummarizeRequest,
  opts: {
    node: NodeRunContext;
    model?: string | undefined;
    instructions?: string | undefined;
    estimator: TokenEstimator;
    signal?: AbortSignal | undefined;
  },
): Promise<{ text: string; usage?: TokenUsage | undefined }> {
  const agentReq: AgentRequest = {
    system: summaryInstructions(req.maxTokens, opts.instructions),
    prompt: summaryPrompt(req, opts.estimator),
    tools: [],
    model: opts.model,
    maxSteps: 1,
    maxTokens: req.maxTokens * 2,
    permission: "deny",
  };
  const refuse = async (): Promise<never> => {
    throw new Error("the context summarizer cannot call tools");
  };
  const result = await provider.run(agentReq, {
    node: opts.node,
    invokeTool: refuse,
    checkToolCall: refuse,
    reportToolResult: async (_n, _a, r) => r,
    emit: () => {},
    signal: opts.signal,
  });
  if (result.stopReason === "error") throw new Error("the context summarizer returned an error");
  return { text: outputText(result.output), usage: result.usage };
}
