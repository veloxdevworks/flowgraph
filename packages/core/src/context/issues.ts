/**
 * Cap for the known-issues section an agent's system prompt carries.
 */
import { truncateToTokens, type TokenEstimator } from "./estimator.js";

/**
 * Keep the newest lines that fit in `maxTokens` (lines are oldest first).
 * Left-out lines are counted in a leading marker; a single line that is
 * too long on its own is cut.
 */
export function capIssueLines(lines: string[], maxTokens: number, est: TokenEstimator): string[] {
  const all = lines.join("\n");
  if (est(all) <= maxTokens) return lines;
  const marker = (n: number) => `- [${n} earlier issue${n === 1 ? " was" : "s were"} left out to fit the context budget.]`;
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = [marker(i), lines[i]!, ...kept].join("\n");
    if (est(candidate) > maxTokens) break;
    kept.unshift(lines[i]!);
  }
  const omitted = lines.length - kept.length;
  if (kept.length === 0) {
    const newest = lines[lines.length - 1]!;
    const head = omitted > 1 ? [marker(omitted - 1)] : [];
    const room = Math.max(1, maxTokens - (head.length ? est(head[0]!) + 1 : 0));
    return [...head, truncateToTokens(newest, room, est)];
  }
  return [marker(omitted), ...kept];
}
