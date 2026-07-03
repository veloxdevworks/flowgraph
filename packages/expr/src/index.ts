export { tokenize, LexError } from "./lexer.js";
export type { Token, TokenKind } from "./lexer.js";

export { parseExpr, ParseError } from "./parser.js";
export type { Expr, BinaryOp } from "./ast.js";

export { evalExpr, EvalError } from "./evaluator.js";
export type { EvalScope } from "./evaluator.js";

export { renderTemplate, renderDeep, evalGuard, collectRefs } from "./template.js";

export { stdlib } from "./stdlib.js";
export type { Stdlib, StdlibFn } from "./stdlib.js";
