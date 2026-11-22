import type { Diagnostic, GraphSpec } from "@flowgraph/spec";
import { guardExpression, literalCallbackExpr, parseExpr, scanTemplate, stdlib, tokenize } from "@flowgraph/expr";

const MAX_DEPTH = 256;
const MAX_TOKENS = 2048;

function expressionDiagnostics(source: string, path: string): Diagnostic[] {
  const diagnostic = (code: string, message: string): Diagnostic[] => [
    { severity: "error", code, message, path },
  ];
  try {
    const tokens = tokenize(source);
    let nesting = 0;
    let unary = 0;
    for (const token of tokens) {
      if (["LPAREN", "LBRACKET", "LBRACE"].includes(token.kind)) nesting++;
      if (["RPAREN", "RBRACKET", "RBRACE"].includes(token.kind)) nesting--;
      unary = token.kind === "BANG" || token.kind === "MINUS" ? unary + 1 : 0;
      if (nesting > MAX_DEPTH || unary > MAX_DEPTH || tokens.length > MAX_TOKENS)
        return diagnostic(
          "EXPR_DEPTH",
          `expression exceeds ${MAX_DEPTH} nesting levels or ${MAX_TOKENS} tokens`,
        );
    }
    const stack: Array<{ value: unknown; depth: number }> = [
      { value: parseExpr(source), depth: 0 },
    ];
    while (stack.length) {
      const { value, depth } = stack.pop()!;
      if (value == null || typeof value !== "object") continue;
      if (depth > MAX_DEPTH)
        return diagnostic("EXPR_DEPTH", `expression exceeds ${MAX_DEPTH} nesting levels`);
      if (Array.isArray(value)) {
        for (const child of value) stack.push({ value: child, depth });
        continue;
      }
      const node = value as { kind?: string; callee?: string; fn?: string };
      const name = node.kind === "Call" ? node.callee : node.kind === "Pipe" ? node.fn : undefined;
      if (name && !Object.hasOwn(stdlib, name))
        return diagnostic("EXPR_UNKNOWN_FUNCTION", `Unknown expression function "${name}"`);
      if (node.kind === "Call" && ["map","filter","find"].includes(node.callee ?? "")) {
        const call=value as import("@flowgraph/expr").Expr & {kind:"Call"};
        if (call.args[1]?.kind !== "String") return diagnostic("EXPR_CALLBACK_LITERAL",`${call.callee}: callback must be a quoted expression string`);
        stack.push({value:literalCallbackExpr(call),depth:depth+1});
      }
      for (const child of Object.values(value)) stack.push({ value: child, depth: depth + 1 });
    }
    return [];
  } catch (error) {
    return diagnostic(
      error instanceof RangeError ? "EXPR_DEPTH" : "EXPR_PARSE_ERROR",
      error instanceof RangeError ? "expression nesting is too deep" : String(error),
    );
  }
}

/** Validate only fields the runtime renders, without evaluating user expressions. */
export function staticGraphDiagnostics(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const checked = new Map<string, Diagnostic[]>();
  const check = (source: string, at: string): void => {
    if (diagnostics.length >= 50) return;
    let result = checked.get(source);
    if (!result) {
      result = expressionDiagnostics(source, at);
      checked.set(source, result);
    }
    for (const item of result) if (diagnostics.length < 50) diagnostics.push({ ...item, path: at });
  };
  const templates = (value: unknown, at: string): void => {
    const stack = [{ value, at }];
    const seen = new Set<object>();
    while (stack.length) {
      const entry = stack.pop()!;
      if (typeof entry.value === "string") {
        for (const span of scanTemplate(entry.value).spans) {
          check(span.expr.trim(), entry.at);
          if (diagnostics.length >= 50) break;
        }
      } else if (entry.value && typeof entry.value === "object" && !seen.has(entry.value)) {
        seen.add(entry.value);
        for (const [key, child] of Object.entries(entry.value)) {
          // Router route guards are checked on their own. Any other `when` is a template.
          if (key === "when" && /(?:^|\.)routes\.\d+$/.test(entry.at)) continue;
          stack.push({ value: child, at: `${entry.at}.${key}` });
        }
      }
    }
  };
  for (const node of Array.isArray(spec.nodes) ? spec.nodes : []) {
    if (!node || typeof node !== "object") continue;
    // Script source is never rendered, so `{{` there (JSX `style={{ … }}`) is code, not a template.
    // A map body is rendered with the item first, so its script code is still checked.
    if (node.type === "script" && node.with && typeof node.with === "object" && "code" in node.with) {
      const { code: _code, ...rest } = node.with as Record<string, unknown>;
      templates(rest, `nodes.${node.id}.with`);
    } else templates(node.with, `nodes.${node.id}.with`);
    templates(node.input, `nodes.${node.id}.input`);
    if (typeof node.when === "string") check(guardExpression(node.when), `nodes.${node.id}.when`);
    const routes = (node.with as { routes?: Array<{ when?: unknown }> } | undefined)?.routes;
    if (node.type === "router" && Array.isArray(routes)) {
      routes.forEach((route, index) => {
        if (typeof route?.when === "string") check(guardExpression(route.when), `nodes.${node.id}.with.routes[${index}].when`);
      });
    }
    if (node.spec && typeof node.spec === "object") {
      for (const d of staticGraphDiagnostics(node.spec)) diagnostics.push({ ...d, path: d.path ? `nodes.${node.id}.spec.${d.path}` : `nodes.${node.id}.spec` });
    }
  }
  for (const [index, edge] of (Array.isArray(spec.edges) ? spec.edges : []).entries())
    if (edge && typeof edge === "object" && "branch" in edge && Array.isArray(edge.branch)) {
      for (const [branchIndex, branch] of edge.branch.entries()) {
        if (!branch || typeof branch !== "object") continue;
        if (typeof branch.when === "string") check(guardExpression(branch.when), `edges[${index}].branch[${branchIndex}].when`);
        else if (branch.when !== undefined) {
          diagnostics.push({
            severity: "error",
            code: "SCHEMA_ERROR",
            path: `edges[${index}].branch[${branchIndex}].when`,
            message: "Expected string",
          });
        }
      }
    }
  for (const [name, channel] of Object.entries(spec.state?.channels ?? {})) {
    const value = channel.default;
    if (value === undefined || channel.type === "any") continue;
    const matches =
      channel.type === "array" || channel.type === "messages"
        ? Array.isArray(value)
        : channel.type === "object"
          ? value !== null && typeof value === "object" && !Array.isArray(value)
          : channel.type === "number"
            ? typeof value === "number" && Number.isFinite(value)
            : typeof value === channel.type;
    if (!matches)
      diagnostics.push({
        severity: "error",
        code: "CHANNEL_DEFAULT_TYPE",
        message: `Channel "${name}" default must have type ${channel.type}`,
        path: `state.channels.${name}.default`,
      });
  }
  return diagnostics;
}
