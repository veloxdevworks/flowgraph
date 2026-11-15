import { waitForWebhookResume, terminateThreadServices, type RunResult, type StateSnapshot } from "@flowgraph/core";

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
): Promise<RunResult> {
  let current = initial;
  for (;;) {
    const ready = mailbox.take();
    if (ready) current = ready;
    if (current.status !== "interrupted" || !current.threadId) return current;
    const webhook = waitForWebhookResume(current.threadId);
    if (!webhook) return current;
    // Only a webhook listener belongs to this CLI process. Durable signal and
    // conditional waits return their pending status for a later external resume.
    const keepAlive = setInterval(() => {}, 60_000);
    let unsubscribe = () => {};
    let onSignal = () => {};
    try {
      const timeout = new Promise<RunResult>((resolve) => {
        unsubscribe = mailbox.subscribe(resolve);
      });
      const cancelled = new Promise<{ status: "aborted" }>((resolve) => {
        onSignal = () => resolve({ status: "aborted" });
        process.once("SIGINT", onSignal);
        process.once("SIGTERM", onSignal);
        process.once("SIGHUP", onSignal);
      });
      const done = await Promise.race([timeout, cancelled, ...(webhook ? [webhook] : [])]);
      if (done.status === "aborted") await terminateThreadServices(current.threadId, {force:true});
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
    }
  }
}
