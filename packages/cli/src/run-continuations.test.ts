import { expect, it } from "vitest";
import type { RunResult } from "@flowgraph/core";
import { awaitAutomaticContinuations, continuationMailbox } from "./run-continuations.js";

function interrupted(): RunResult {
  return {
    status: "interrupted",
    threadId: "t",
    runId: "r",
    state: {},
    durationMs: 0,
    interrupts: [],
  };
}

it("treats an already-aborted signal as an aborted webhook wait", async () => {
  const result = await awaitAutomaticContinuations(
    interrupted(),
    continuationMailbox(),
    undefined,
    AbortSignal.abort(),
  );
  expect(result.status).toBe("aborted");
  expect(result.threadId).toBe("t");
});
