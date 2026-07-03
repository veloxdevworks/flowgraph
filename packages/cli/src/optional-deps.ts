/**
 * Lazy dynamic import for optional CLI peer dependencies.
 */

export function lazyOptionalImport<T extends Record<string, unknown>>(
  pkg: string,
  hint: string,
): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => {
    if (!cached) {
      cached = import(pkg).catch((err: unknown) => {
        cached = undefined;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Cannot find") || msg.includes("ERR_MODULE_NOT_FOUND")) {
          throw new Error(`${pkg} is not installed. ${hint}`, { cause: err });
        }
        throw err;
      }) as Promise<T>;
    }
    return cached;
  };
}
