/**
 * Ctrl-C and SIGTERM cancel the run, so nodes stop what they started and leave nothing behind.
 * A second one exits at once, for a run that does not stop.
 */
export function abortOnSignals(onFirst: () => void): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onSignal = (name: NodeJS.Signals): void => {
    if (controller.signal.aborted) {
      process.exit(130);
    } else {
      onFirst();
      controller.abort(new Error(`Interrupted by ${name}`));
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return {
    signal: controller.signal,
    dispose() {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    },
  };
}
