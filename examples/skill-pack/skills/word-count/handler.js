/**
 * word-count handler — basic text statistics.
 *
 * @param {{ text?: string }} input
 * @returns {{ words: number, characters: number, sentences: number }}
 */
export default function wordCount(input) {
  const text = String(input?.text ?? "").trim();
  const words = text.length === 0 ? 0 : text.split(/\s+/).length;
  const characters = text.length;
  const sentences = text.length === 0 ? 0 : (text.match(/[.!?]+(\s|$)/g) ?? []).length || 1;
  return { words, characters, sentences };
}
