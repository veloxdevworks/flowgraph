# 17 — Agent Context Budgets

An agent node's prompt grows in two ways: its own tool loop (every tool call and result is sent back on the next model call), and conversation history carried across loop iterations or runs. Without limits, a long tool loop or a chat thread ends up sending hundreds of thousands of tokens per call, and then fails at the provider's context limit.

`with.context` bounds what an agent sends on each model call. `runtime.context` sets graph-wide defaults. Agents with neither send exactly what they did before.

## 1. Quick start

```yaml
state:
  channels:
    chat: { type: messages }
    question: { type: string }
    answer: { type: object }

nodes:
  - id: support
    type: agent
    provider: anthropic
    with:
      system: "You are a support agent."
      prompt: "{{ state.question }}"
      tools: [ { function: search_logs } ]
      context:
        history: chat            # read and extend this messages channel
        maxTokens: 16000         # per model call: system + tools + history + prompt + tool loop
        strategy: summarize      # none | last | trim | summarize
        toolResultMaxTokens: 3000
      output: { to: answer }

runtime:
  checkpoint: { backend: sqlite }
```

Each run on the same thread sees the earlier turns as real chat messages, the history channel stays bounded, and no call goes over 16000 tokens.

## 2. Options

| Key | Default | Meaning |
|-----|---------|---------|
| `maxTokens` | `16000` | Budget for one model call: system prompt (with memory recall and run issues), tool schemas, history, the prompt, this run's tool loop, and `reserveTokens`. |
| `reserveTokens` | `with.maxTokens`, else `0` | Room kept free for the reply. |
| `strategy` | `trim` | How to make room. See §3. |
| `lastN` | `20` | For `strategy: last`: how many history and tool-loop messages to keep, besides the prompt. |
| `toolResultMaxTokens` | none | Cut every tool result to this many tokens, with a `…[truncated: n of total tokens kept]` marker. |
| `summarize.provider` / `summarize.model` | none | Model used to write summaries (`strategy: summarize`). A registered provider name; a `model` alone uses the agent's provider. Without either, a deterministic extract is used. |
| `summarize.maxTokens` | `500` | Size of the running summary. |
| `summarize.instructions` | none | Extra instructions for the summary model. |
| `estimator` | `bytes` | Token estimator name. See §6. |
| `onOverflow` | `error` | When the parts that are never dropped (system, prompt, newest tool step) exceed the budget: `error` fails the node with `ContextOverflowError` (never retried); `warn` sends anyway and records a `CONTEXT_OVER_BUDGET` run issue. |
| `history` | none | A `type: messages` channel to read as prior conversation and append to. Node level only. |
| `record` | `turns` | What the agent appends to `history`: `turns` (the prompt and the final reply) or `all` (also tool calls and results). |
| `compact` | `true` | Remove messages the agent left out from `history` (folded into the summary under `summarize`). With `false` the channel keeps everything and only the calls are bounded. |

`runtime.context` accepts the same keys except `history`, `record` and `compact`. Node values win field by field (`summarize` is replaced as a whole).

## 3. Strategies

Messages are grouped into units that are always kept or dropped together: one message, or an assistant message with tool calls plus all of its tool results. A tool call is never sent without its result, or a result without its call. Kept history always starts at a user message.

Never dropped: the system text, the current prompt, and the newest tool step. Everything else is dropped oldest first, and once dropped stays dropped for the rest of the run.

- **`none`**: send everything; only the overflow check applies.
- **`last`**: keep the newest `lastN` messages, then trim further if still over budget.
- **`trim`**: drop the oldest units until the call fits. A line in the system text says how many messages were left out.
- **`summarize`**: when the call does not fit, drop the oldest units down to about 75% of the free budget and fold them into a running summary, shown in the system text under `## Earlier conversation (summary)`. The slack means the summarizer runs once every several calls, not every call. With `history`, the summary is stored in the channel as a system message with id `fg-summary-<channel>` and carried into later runs.

## 4. History channels

`history` names a `type: messages` channel. The agent reads it as chat turns (system messages in it are added to the system text), fits it into the budget, and after a successful run writes back, in one update:

- the new turn, with ids derived from the channel, node, previous message and content, so a replayed node upserts instead of duplicating;
- removals for the messages it left out (`compact: true`);
- the updated summary message (`strategy: summarize`).

Providers that take chat messages (the built-in LangChain provider sets `capabilities.contextMessages`) receive history as `AgentRequest.messages`. Other providers receive it as a transcript at the top of the prompt:

```
Conversation so far:
user: …
assistant: …

---

<prompt>
```

**Map:** agents inside `map` run in parallel, so they read `history` but do not write it (run issue `CONTEXT_HISTORY_READ_ONLY`, lint `CONTEXT_HISTORY_IN_MAP`).

**Subgraphs:** map the channel in and out with `stateMap`. Turns a child appends reach the parent; ids keep the parent's copy free of duplicates. Removals made by a child's compaction do not propagate to the parent channel, so the parent's channel can be longer than the child's. The calls stay within budget either way.

## 5. Memory recall

`with.memory.recall` has its own `maxTokens` (default 1000). Under a context budget, recall is limited to half of `maxTokens − reserveTokens`, so recalled memory and conversation history share one budget. Lint `CONTEXT_MEMORY_OVER_BUDGET` warns when `memory.maxTokens` asks for more. Recalled memory is part of the system text and is never dropped.

## 6. Token estimates

The default estimator counts UTF-8 bytes / 4 (the same as memory recall). Each message adds 4 tokens of overhead plus its tool calls as JSON; tool schemas count as their JSON. Register a real tokenizer before compiling:

```ts
import { registerTokenEstimator } from "@flowgraph/core";
registerTokenEstimator("cl100k", (text) => encoder.encode(text).length);
```

```yaml
runtime:
  context: { estimator: cl100k, maxTokens: 120000 }
```

An unregistered estimator name fails the node with a message naming the registered ones.

## 7. Interrupt, resume and replay

Fitting is deterministic: each call depends only on the history channel, the prompt and the tool loop so far. On resume the agent refits every replayed step the same way, and summaries made by a model are kept in the agent's replay cache, so a run interrupted at every tool call sends the same inputs as a straight run and does not pay for a summary twice. This also holds when the process restarts between interrupt and resume.

## 8. Providers

| Provider | Tool loop bounded | History |
|----------|-------------------|---------|
| LangChain (built in) | yes, before every model call; tool results capped | chat messages |
| Scripted / mock | n/a | transcript in prompt |
| Claude SDK, Cursor SDK, CLI, `hub: deepagents` | no: they run their own loop; only the starting history and prompt are fitted | transcript in prompt |

Custom providers can opt in: set `capabilities.contextMessages: true` to receive `req.messages`, and call `ctx.context.fit(loop)` before each model call with the assistant and tool messages produced so far; it returns `{ system, messages, stats }` to send. Use `ctx.context.capToolResult(text)` on tool results.

## 9. Observability

Every fitted call emits `agent.context` with `budget`, `total`, `system`, `tools`, `reserve`, `history`, `prompt`, `loop`, `summary`, `keptMessages`, `droppedMessages` and `summarizedMessages`. Summary model usage is emitted as `agent.usage` with `purpose: "context.summary"` and counts toward `runtime.budget`.

Run issues: `CONTEXT_OVER_BUDGET`, `CONTEXT_SUMMARY_FAILED` (the summary model failed; a plain extract was used), `CONTEXT_HISTORY_READ_ONLY`.

## 10. Lint codes

| Code | Severity | When |
|------|----------|------|
| `CONTEXT_HISTORY_CHANNEL` | error | `history` is not a declared `type: messages` channel |
| `CONTEXT_BUDGET_TOO_SMALL` | error | `maxTokens` leaves no room after `reserveTokens`, or `summarize.maxTokens` is half the usable budget or more |
| `CONTEXT_BUDGET_TOO_SMALL` | warning | `toolResultMaxTokens` is not below the usable budget |
| `CONTEXT_MEMORY_OVER_BUDGET` | warning | `memory.maxTokens` is over half the usable budget; recall will be limited |
| `CONTEXT_OPTION_UNUSED` | warning | `lastN` without `strategy: last`, `summarize` without `strategy: summarize`, `record`/`compact` without `history` |
| `CONTEXT_HISTORY_IN_MAP` | warning | an agent inside `map` names a `history` channel |
| `CONTEXT_HUB_UNSUPPORTED` | warning | `hub: deepagents` with `with.context` |

Unknown keys and strategies are schema errors.
