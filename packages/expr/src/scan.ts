/**
 * Linear-time scanning of `{{ … }}` spans in a template string.
 *
 * Every place that looks for template expressions (rendering, static
 * analysis, upload and node policy checks) goes through here rather than a
 * regular expression: a lazy `\{\{(.*?)\}\}` restarts at every `{{` that is
 * never closed, which costs O(n²) on a string such as `"{{ ".repeat(n)`.
 */

/** One closed `{{ … }}` span: `start` is the index of `{{`, `end` the index just past `}}`. */
export interface TemplateSpan {
  start: number;
  end: number;
  /** The text between `{{` and `}}`, untrimmed. */
  expr: string;
}

export interface TemplateScan {
  /** Closed spans, in order and never overlapping. */
  spans: TemplateSpan[];
  /**
   * Index of the first `{{` after the last closed span that has no `}}`
   * after it, or -1. Text from here to the end is never rendered.
   */
  unclosedAt: number;
}

/**
 * Find the `{{ … }}` spans of a template. Each span runs from a `{{` to the
 * first `}}` after it, and scanning resumes after that `}}`, matching
 * `/\{\{([\s\S]*?)\}\}/g`. Runs in time linear in the length of the text.
 */
export function scanTemplate(text: string): TemplateScan {
  const spans: TemplateSpan[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf("{{", from);
    if (start < 0) return { spans, unclosedAt: -1 };
    const close = text.indexOf("}}", start + 2);
    if (close < 0) return { spans, unclosedAt: start };
    spans.push({ start, end: close + 2, expr: text.slice(start + 2, close) });
    from = close + 2;
  }
}

/**
 * The expression of a template that is a single `{{ … }}` block with only
 * whitespace around it, or undefined. Matches `/^\s*\{\{([\s\S]*?)\}\}\s*$/`:
 * the block runs from the leading `{{` to the trailing `}}`, so text such as
 * `{{ a }} {{ b }}` counts as one block (and fails to parse), as before.
 */
export function soleTemplateExpr(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length < 4 || !trimmed.startsWith("{{") || !trimmed.endsWith("}}")) return undefined;
  return trimmed.slice(2, -2);
}
