/**
 * Evaluates a parsed expression AST against a sandboxed scope.
 * No access to the host environment.
 */

import type { Expr } from "./ast.js";
import { stdlib } from "./stdlib.js";
import { ownValue } from "./own-property.js";
import { literalCallbackExpr, parseExpr } from "./parser.js";

export type EvalScope = Record<string, unknown>;

export class EvalError extends Error {
  constructor(message: string) {
    super(`Expression evaluation error: ${message}`);
  }
}

/**
 * Names starting with this prefix in the `state` scope value are the
 * engine's own channels (`__services`, `__worktrees`, ...). Expressions
 * never see them: `state` evaluates to a view without them, so no form of
 * access (`state.__x`, `state['_' + '_x']`, `keys(state)`, a bare
 * `{{ state }}`) reads them.
 */
export const HIDDEN_STATE_PREFIX = "__";

/**
 * Most work one top-level evaluation may do, in steps. Every evaluated
 * expression node is a step (callback bodies once per item), and a function
 * call adds one step per array element, object key or 64 string characters
 * it receives or returns. Past the budget, evaluation fails with an
 * EvalError, so an expression's cost stays bounded whatever data it reads.
 */
export const MAX_EVAL_STEPS = 1_000_000;

const STRING_CHARS_PER_STEP = 64;

let stepsLeft: number | undefined;

function spend(steps: number): void {
  stepsLeft = (stepsLeft ?? MAX_EVAL_STEPS) - steps;
  if (stepsLeft < 0) {
    throw new EvalError(`expression exceeds ${MAX_EVAL_STEPS} evaluation steps; move large data processing into a script or function node`);
  }
}

function sizeOf(value: unknown): number {
  if (typeof value === "string") return Math.ceil(value.length / STRING_CHARS_PER_STEP);
  if (Array.isArray(value)) return value.length;
  if (value != null && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null ? Object.keys(value).length : 0;
  }
  return 0;
}

function callBuiltin(fn: (...args: unknown[]) => unknown, args: unknown[]): unknown {
  spend(args.reduce<number>((n, a) => n + sizeOf(a), 0));
  const result = fn(...args);
  spend(sizeOf(result));
  return result;
}

function visibleState(value: unknown): unknown {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return value;
  let view: Record<string, unknown> | undefined;
  for (const k of Object.keys(value)) {
    if (!k.startsWith(HIDDEN_STATE_PREFIX)) continue;
    view ??= { ...(value as Record<string, unknown>) };
    delete view[k];
  }
  return view ?? value;
}

const CALLBACK_FUNCTIONS: ReadonlySet<string> = new Set(["map", "filter", "find"]);
const pipeCallbacks = new WeakMap<Expr, Expr>();

/** The parsed callback of `list |> map('...')`; the quoted callback is the first argument. */
function pipeCallbackExpr(expr: Extract<Expr, { kind: "Pipe" }>): Expr {
  const source = expr.args[0];
  if (source?.kind !== "String") throw new EvalError(`${expr.fn}: callback must be a quoted expression string`);
  let parsed = pipeCallbacks.get(expr);
  if (!parsed) {
    parsed = parseExpr(source.value);
    pipeCallbacks.set(expr, parsed);
  }
  return parsed;
}

function callbackFor(callback: Expr, scope: EvalScope, strict: boolean) {
  return (item: unknown, index: number) => evalNode(callback, { ...scope, item, index }, strict);
}

/**
 * Evaluate an expression. Nested evaluations (callbacks) share the budget of
 * the outermost call; see {@link MAX_EVAL_STEPS}.
 */
export function evalExpr(expr: Expr, scope: EvalScope, strict = false): unknown {
  if (stepsLeft !== undefined) return evalNode(expr, scope, strict);
  stepsLeft = MAX_EVAL_STEPS;
  try {
    return evalNode(expr, scope, strict);
  } finally {
    stepsLeft = undefined;
  }
}

function evalNode(expr: Expr, scope: EvalScope, strict: boolean): unknown {
  spend(1);
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
      if (Object.hasOwn(scope, expr.name))
        return expr.name === "state" ? visibleState(scope[expr.name]) : scope[expr.name];
      if (strict) throw new EvalError(`Undefined identifier: ${expr.name}`);
      return null;
    }

    case "Member": {
      const obj = evalNode(expr.object, scope, strict);
      if (obj == null) {
        if (strict)
          throw new EvalError(`Cannot access property "${expr.property}" of null/undefined`);
        return null;
      }
      if (typeof obj !== "object" && typeof obj !== "function") {
        if (strict) throw new EvalError(`Cannot access property "${expr.property}" on non-object`);
        return null;
      }
      return ownValue(obj, expr.property);
    }

    case "Index": {
      const obj = evalNode(expr.object, scope, strict);
      const idx = evalNode(expr.index, scope, strict);
      if (obj == null) {
        if (strict) throw new EvalError("Cannot index null/undefined");
        return null;
      }
      if (Array.isArray(obj)) {
        const i = Number(idx);
        return ownValue(obj, i < 0 ? obj.length + i : i);
      }
      if (typeof obj === "object") {
        return ownValue(obj, String(idx));
      }
      if (strict) throw new EvalError("Cannot index non-object");
      return null;
    }

    case "Call": {
      const fn = Object.hasOwn(stdlib, expr.callee) ? stdlib[expr.callee] : undefined;
      if (!fn) throw new EvalError(`Unknown function: ${expr.callee}`);
      const takesCallback = CALLBACK_FUNCTIONS.has(expr.callee);
      if (takesCallback && expr.args[1]?.kind !== "String") throw new EvalError(`${expr.callee}: callback must be a quoted expression string`);
      const args = expr.args.map((a) => evalNode(a, scope, strict));
      if (takesCallback) args[1] = callbackFor(literalCallbackExpr(expr)!, scope, strict);
      return callBuiltin(fn, args);
    }

    case "Unary": {
      const operand = evalNode(expr.operand, scope, strict);
      if (expr.op === "!") return !operand;
      if (expr.op === "-") return -Number(operand);
      throw new EvalError(`Unknown unary op: ${expr.op}`);
    }

    case "Binary": {
      // Short-circuit for && and ||
      if (expr.op === "&&") {
        const l = evalNode(expr.left, scope, strict);
        if (!l) return l;
        return evalNode(expr.right, scope, strict);
      }
      if (expr.op === "||") {
        const l = evalNode(expr.left, scope, strict);
        if (l) return l;
        return evalNode(expr.right, scope, strict);
      }
      const left = evalNode(expr.left, scope, strict);
      const right = evalNode(expr.right, scope, strict);
      switch (expr.op) {
        case "==":
          return left === right;
        case "!=":
          return left !== right;
        case "<":
          return (left as number) < (right as number);
        case "<=":
          return (left as number) <= (right as number);
        case ">":
          return (left as number) > (right as number);
        case ">=":
          return (left as number) >= (right as number);
        case "+": {
          if (typeof left !== "string" && typeof right !== "string") return (left as number) + (right as number);
          const joined = String(left) + String(right);
          spend(sizeOf(joined));
          return joined;
        }
        case "-":
          return (left as number) - (right as number);
        case "*":
          return (left as number) * (right as number);
        case "/":
          return (left as number) / (right as number);
        case "%":
          return (left as number) % (right as number);
        default:
          throw new EvalError(`Unknown binary op: ${expr.op}`);
      }
    }

    case "Ternary": {
      const cond = evalNode(expr.condition, scope, strict);
      return cond
        ? evalNode(expr.consequent, scope, strict)
        : evalNode(expr.alternate, scope, strict);
    }

    case "Nullish": {
      const l = evalNode(expr.left, scope, strict);
      return l ?? evalNode(expr.right, scope, strict);
    }

    case "Pipe": {
      const left = evalNode(expr.left, scope, strict);
      const fn = Object.hasOwn(stdlib, expr.fn) ? stdlib[expr.fn] : undefined;
      if (!fn) throw new EvalError(`Unknown pipe function: ${expr.fn}`);
      if (CALLBACK_FUNCTIONS.has(expr.fn)) {
        return callBuiltin(fn, [left, callbackFor(pipeCallbackExpr(expr), scope, strict)]);
      }
      const extraArgs = expr.args.map((a) => evalNode(a, scope, strict));
      return callBuiltin(fn, [left, ...extraArgs]);
    }

    case "Array":
      return expr.elements.map((e) => evalNode(e, scope, strict));

    case "Object": {
      return Object.fromEntries(
        expr.entries.map(({ key, value }) => [key, evalNode(value, scope, strict)]),
      );
    }

    default:
      throw new EvalError(`Unknown expr kind`);
  }
}
