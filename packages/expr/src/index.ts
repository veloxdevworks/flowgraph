export { tokenize, LexError } from "./lexer.js";
export type { Token, TokenKind } from "./lexer.js";

export { parseExpr, ParseError } from "./parser.js";
export type { Expr, BinaryOp } from "./ast.js";

export { evalExpr, EvalError, HIDDEN_STATE_PREFIX } from "./evaluator.js";
export type { EvalScope } from "./evaluator.js";

export { renderTemplate, renderDeep, stringifyRendered, evalGuard, collectRefs } from "./template.js";

export { stdlib } from "./stdlib.js";
export type { Stdlib, StdlibFn } from "./stdlib.js";
