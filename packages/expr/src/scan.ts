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
 * Find closed template spans, ignoring delimiters inside quoted strings and
 * object literals. Each character is visited at most once.
 */
export function scanTemplate(text: string): TemplateScan {
  const spans: TemplateSpan[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf("{{", from);
    if (start < 0) return { spans, unclosedAt: -1 };
    let close = -1;
    let quote = "";
    let braces = 0;
    for (let i = start + 2; i < text.length; i++) {
      const ch = text[i]!;
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "{") {
        braces++;
      } else if (ch === "}") {
        if (braces > 0) braces--;
        else if (text[i + 1] === "}") {
          close = i;
          break;
        }
      }
    }
    if (close < 0) return { spans, unclosedAt: start };
    spans.push({ start, end: close + 2, expr: text.slice(start + 2, close) });
    from = close + 2;
  }
}

/**
 * The expression of a template that is a single `{{ … }}` block with only
 * whitespace around it, or undefined. Multiple spans are always interpolation.
 */
export function soleTemplateExpr(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{{") || !trimmed.endsWith("}}")) return undefined;
  const { spans, unclosedAt } = scanTemplate(text);
  const span = spans[0];
  if (unclosedAt >= 0 || spans.length !== 1 || !span) return undefined;
  if (text.slice(0, span.start).trim() || text.slice(span.end).trim()) return undefined;
  return span.expr;
}
