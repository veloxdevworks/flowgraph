import {
  waitForWebhookResume,
  type RunResult,
  type StateSnapshot,
} from "@flowgraph/core";
import { terminateThreadServices } from "@flowgraph/node-service";

/** The engine may finish a timed wait before the CLI begins awaiting it. */
export function continuationMailbox() {
  let latest: RunResult | undefined;
  const listeners = new Set<(result: RunResult) => void>();
  return {
    publish(result: RunResult) {
      latest = result;
      for (const listener of listeners) listener(result);
    },
    take() {
      const result = latest;
      latest = undefined;
      return result;
    },
    subscribe(listener: (result: RunResult) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Await only automatic continuations; a human gate still returns exit code 3. */
export async function awaitAutomaticContinuations(
  initial: RunResult,
  mailbox: ReturnType<typeof continuationMailbox>,
  refresh?: (threadId: string) => Promise<StateSnapshot | null>,
  signal?: AbortSignal,
): Promise<RunResult> {
  const abortCurrent = async (current: RunResult): Promise<RunResult> => {
    if (current.threadId) await terminateThreadServices(current.threadId, { force: true });
    return { ...current, status: "aborted" };
  };
  let current = initial;
  for (;;) {
    const ready = mailbox.take();
    if (ready) current = ready;
    // A SIGHUP/INT/TERM may have already aborted the run signal in the gap
    // after compiled.run() returned interrupted and before this wait starts.
    if (signal?.aborted) return abortCurrent(current);
    if (current.status !== "interrupted" || !current.threadId) return current;
    const webhook = waitForWebhookResume(current.threadId);
    if (!webhook) return signal?.aborted ? abortCurrent(current) : current;
    // Only a webhook listener belongs to this CLI process. Durable signal and
    // conditional waits return their pending status for a later external resume.
    const keepAlive = setInterval(() => {}, 60_000);
    let unsubscribe = () => {};
    let onSignal = () => {};
    let onAbort = () => {};
    try {
      const timeout = new Promise<RunResult>((resolve) => {
        unsubscribe = mailbox.subscribe(resolve);
      });
      const cancelled = new Promise<{ status: "aborted" }>((resolve) => {
        onSignal = () => resolve({ status: "aborted" });
        process.once("SIGINT", onSignal);
        process.once("SIGTERM", onSignal);
        process.once("SIGHUP", onSignal);
        if (signal) {
          onAbort = () => resolve({ status: "aborted" });
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
      });
      const done = await Promise.race([timeout, cancelled, ...(webhook ? [webhook] : [])]);
      // Aborting the run unregisters webhook routes and settles them as
      // "cancelled". That must not win over the abort and leave exit code 3.
      if (signal?.aborted || done.status === "aborted") return abortCurrent(current);
      // A timeout unregisters its webhook before publishing the full result.
      const published = mailbox.take();
      if (published) {
        current = published;
        continue;
      }
      if (done.status === "cancelled") return current;
      if ("runId" in done) {
        current = done;
        continue;
      }
      const snapshot = await refresh?.(current.threadId);
      if (snapshot)
        current = { ...current, state: snapshot.values, interrupts: snapshot.interrupts };
      if (done.status === "interrupted") {
        // The next gate's webhook registration, if any, is already live.
        current = { ...current, status: "interrupted" };
        continue;
      }
      return {
        ...current,
        status: done.status as RunResult["status"],
        ...("error" in done && done.error ? { error: new Error(done.error) } : {}),
      };
    } finally {
      clearInterval(keepAlive);
      unsubscribe();
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onSignal);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
