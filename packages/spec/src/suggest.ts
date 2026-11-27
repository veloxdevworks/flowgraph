/** Levenshtein edit distance between two strings. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** The closest known key within edit distance 2, if any. */
export function suggestKey(unknown: string, known: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDist = 3;
  for (const k of known) {
    const d = editDistance(unknown, k);
    // A distance that rewrites the whole key is not a typo.
    if (d <= 2 && d < k.length && d < bestDist) {
      best = k;
      bestDist = d;
    }
  }
  return best;
}
