import { registerFunction } from "@flowgraph/core";

/** What actually fixes each simulated service (unknown to the agent). */
export const TRUE_FIX: Record<string, string> = {
  db: "raise-max-connections",
  web: "purge-cdn",
};

/** Simulated remediation + verification: resolved only when the right action ran. */
registerFunction("selfHealing.applyAndVerify", (input) => {
  const { action, service } = input as { action?: string; service?: string };
  const outcome = action && TRUE_FIX[service ?? ""] === action ? "resolved" : "failed";
  return { action: action ?? "none", outcome };
});
