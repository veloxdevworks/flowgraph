/**
 * Evaluates a parsed expression AST against a sandboxed scope.
 * No access to the host environment.
 */

import type { Expr } from "./ast.js";
import { stdlib } from "./stdlib.js";

export type EvalScope = Record<string, unknown>;

export class EvalError extends Error {
  constructor(message: string) {
    super(`Expression evaluation error: ${message}`);
  }
}

export function evalExpr(expr: Expr, scope: EvalScope, strict = false): unknown {
  switch (expr.kind) {
    case "Number":
      return expr.value;
    case "String":
      return expr.value;
    case "Bool":
      return expr.value;
    case "Null":
      return null;

    case "Ident": {
      if (expr.name in scope) return scope[expr.name];
      if (strict) throw new EvalError(`Undefined identifier: ${expr.name}`);
      return null;
    }

    case "Member": {
      const obj = evalExpr(expr.object, scope, strict);
      if (obj == null) {
        if (strict) throw new EvalError(`Cannot access property "${expr.property}" of null/undefined`);
        return null;
      }
      if (typeof obj !== "object" && typeof obj !== "function") {
        if (strict) throw new EvalError(`Cannot access property "${expr.property}" on non-object`);
        return null;
      }
      return (obj as Record<string, unknown>)[expr.property] ?? null;
    }

    case "Index": {
      const obj = evalExpr(expr.object, scope, strict);
      const idx = evalExpr(expr.index, scope, strict);
      if (obj == null) {
        if (strict) throw new EvalError("Cannot index null/undefined");
        return null;
      }
      if (Array.isArray(obj)) {
        const i = Number(idx);
        return obj[i < 0 ? obj.length + i : i] ?? null;
      }
      if (typeof obj === "object") {
        return (obj as Record<string, unknown>)[String(idx)] ?? null;
      }
      if (strict) throw new EvalError("Cannot index non-object");
      return null;
    }

    case "Call": {
      const fn = stdlib[expr.callee];
      if (!fn) throw new EvalError(`Unknown function: ${expr.callee}`);
      const args = expr.args.map((a) => evalExpr(a, scope, strict));
      return fn(...args);
    }

    case "Unary": {
      const operand = evalExpr(expr.operand, scope, strict);
      if (expr.op === "!") return !operand;
      if (expr.op === "-") return -Number(operand);
      throw new EvalError(`Unknown unary op: ${expr.op}`);
    }

    case "Binary": {
      // Short-circuit for && and ||
      if (expr.op === "&&") {
        const l = evalExpr(expr.left, scope, strict);
        if (!l) return l;
        return evalExpr(expr.right, scope, strict);
      }
      if (expr.op === "||") {
        const l = evalExpr(expr.left, scope, strict);
        if (l) return l;
        return evalExpr(expr.right, scope, strict);
      }
      const left = evalExpr(expr.left, scope, strict);
      const right = evalExpr(expr.right, scope, strict);
      switch (expr.op) {
        case "==":  return left === right;
        case "!=":  return left !== right;
        case "<":   return (left as number) < (right as number);
        case "<=":  return (left as number) <= (right as number);
        case ">":   return (left as number) > (right as number);
        case ">=":  return (left as number) >= (right as number);
        case "+":   return typeof left === "string" || typeof right === "string"
                      ? String(left) + String(right)
                      : (left as number) + (right as number);
        case "-":   return (left as number) - (right as number);
        case "*":   return (left as number) * (right as number);
        case "/":   return (left as number) / (right as number);
        case "%":   return (left as number) % (right as number);
        default:    throw new EvalError(`Unknown binary op: ${expr.op}`);
      }
    }

    case "Ternary": {
      const cond = evalExpr(expr.condition, scope, strict);
      return cond ? evalExpr(expr.consequent, scope, strict) : evalExpr(expr.alternate, scope, strict);
    }

    case "Nullish": {
      const l = evalExpr(expr.left, scope, strict);
      return l ?? evalExpr(expr.right, scope, strict);
    }

    case "Pipe": {
      const left = evalExpr(expr.left, scope, strict);
      const fn = stdlib[expr.fn];
      if (!fn) throw new EvalError(`Unknown pipe function: ${expr.fn}`);
      const extraArgs = expr.args.map((a) => evalExpr(a, scope, strict));
      return fn(left, ...extraArgs);
    }

    case "Array":
      return expr.elements.map((e) => evalExpr(e, scope, strict));

    case "Object": {
      const result: Record<string, unknown> = {};
      for (const { key, value } of expr.entries) {
        result[key] = evalExpr(value, scope, strict);
      }
      return result;
    }

    default:
      throw new EvalError(`Unknown expr kind`);
  }
}
