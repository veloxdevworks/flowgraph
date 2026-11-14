import type { Diagnostic, GraphSpec } from "@flowgraph/spec";
import { parseExpr, scanTemplate, stdlib, tokenize } from "@flowgraph/expr";

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
        for (const [key, child] of Object.entries(entry.value))
          stack.push({ value: child, at: `${entry.at}.${key}` });
      }
    }
  };
  for (const node of spec.nodes) {
    templates(node.with, `nodes.${node.id}.with`);
    templates(node.input, `nodes.${node.id}.input`);
    if (node.when)
      check(node.when.replace(/^\s*\{\{|\}\}\s*$/g, "").trim(), `nodes.${node.id}.when`);
    const routes = (node.with as { routes?: Record<string, { when?: string }> } | undefined)
      ?.routes;
    if (node.type === "router")
      for (const [key, route] of Object.entries(routes ?? {})) {
        if (route.when && !route.when.includes("{{"))
          check(route.when, `nodes.${node.id}.with.routes.${key}.when`);
      }
    if (node.spec) diagnostics.push(...staticGraphDiagnostics(node.spec));
  }
  for (const [index, edge] of spec.edges.entries())
    if ("branch" in edge) {
      for (const [branchIndex, branch] of edge.branch.entries())
        if (branch.when)
          check(
            branch.when.replace(/^\s*\{\{|\}\}\s*$/g, "").trim(),
            `edges[${index}].branch[${branchIndex}].when`,
          );
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
