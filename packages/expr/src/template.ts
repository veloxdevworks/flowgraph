/**
 * Template rendering: interpolates {{ expr }} inside strings.
 * A string with a single {{ expr }} (no surrounding text) returns
 * the typed value, not a string, so objects/numbers pass through.
 */

import { parseExpr } from "./parser.js";
import { evalExpr, type EvalScope } from "./evaluator.js";

const TEMPLATE_RE = /\{\{(.*?)\}\}/gs;
const SOLE_EXPR_RE = /^\s*\{\{(.*?)\}\}\s*$/s;

/**
 * Render a template string, interpolating {{ expr }} blocks.
 *
 * If the template is exactly one {{ expr }} block (ignoring whitespace),
 * returns the typed result value. Otherwise returns an interpolated string.
 */
export function renderTemplate(template: string, scope: EvalScope, strict = false): unknown {
  const soleMatch = SOLE_EXPR_RE.exec(template);
  if (soleMatch?.[1] != null) {
    const ast = parseExpr(soleMatch[1].trim());
    return evalExpr(ast, scope, strict);
  }

  return template.replace(TEMPLATE_RE, (_, expr: string) => {
    const ast = parseExpr(expr.trim());
    const result = evalExpr(ast, scope, strict);
    return stringifyInterpolated(result);
  });
}

/**
 * Render an interpolated value for a template that mixes `{{ expr }}` with
 * surrounding text. Plain `String(value)` turns objects/arrays into
 * "[object Object]" / lossy comma joins — serialize those as JSON instead so
 * e.g. `{{ state.weeklyBrief }}` (an object) stays readable to an LLM prompt.
 */
function stringifyInterpolated(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") {
    try {
      const json = JSON.stringify(value);
      if (json !== undefined) return json;
    } catch {
      // fall through to String() below
    }
  }
  return String(value);
}

/**
 * Recursively render all template strings in a JS value.
 * Objects and arrays are traversed; non-string primitives are returned as-is.
 */
export function renderDeep(value: unknown, scope: EvalScope, strict = false): unknown {
  if (typeof value === "string") return renderTemplate(value, scope, strict);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, scope, strict));
  if (value != null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = renderDeep(v, scope, strict);
    }
    return result;
  }
  return value;
}

/**
 * Evaluate a bare expression string (not a template — no {{ }}).
 * Convenience wrapper for `when:` guards and branch conditions.
 */
export function evalGuard(expr: string, scope: EvalScope, strict = false): boolean {
  const ast = parseExpr(expr.trim());
  const result = evalExpr(ast, scope, strict);
  return Boolean(result);
}

/**
 * Static analysis: collect all top-level identifier names referenced in a
 * template string (e.g. "state", "config"). Used to validate channel refs.
 */
export function collectRefs(template: string): Set<string> {
  const refs = new Set<string>();

  function walk(node: ReturnType<typeof parseExpr>): void {
    if (node.kind === "Ident") refs.add(node.name);
    else if (node.kind === "Member") walk(node.object);
    else if (node.kind === "Index") { walk(node.object); walk(node.index); }
    else if (node.kind === "Call") node.args.forEach(walk);
    else if (node.kind === "Unary") walk(node.operand);
    else if (node.kind === "Binary") { walk(node.left); walk(node.right); }
    else if (node.kind === "Ternary") { walk(node.condition); walk(node.consequent); walk(node.alternate); }
    else if (node.kind === "Nullish") { walk(node.left); walk(node.right); }
    else if (node.kind === "Pipe") { walk(node.left); node.args.forEach(walk); }
    else if (node.kind === "Array") node.elements.forEach(walk);
    else if (node.kind === "Object") node.entries.forEach((e) => walk(e.value));
  }

  let m: RegExpExecArray | null;
  const re = /\{\{(.*?)\}\}/gs;
  while ((m = re.exec(template)) !== null) {
    try {
      walk(parseExpr(m[1]!.trim()));
    } catch {
      // ignore parse errors in static analysis
    }
  }
  return refs;
}
