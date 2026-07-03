/**
 * AST node types for the flowgraph expression language.
 */

export type Expr =
  | { kind: "Number"; value: number }
  | { kind: "String"; value: string }
  | { kind: "Bool"; value: boolean }
  | { kind: "Null" }
  | { kind: "Ident"; name: string }
  | { kind: "Member"; object: Expr; property: string }
  | { kind: "Index"; object: Expr; index: Expr }
  | { kind: "Call"; callee: string; args: Expr[] }
  | { kind: "Unary"; op: "!" | "-"; operand: Expr }
  | { kind: "Binary"; op: BinaryOp; left: Expr; right: Expr }
  | { kind: "Ternary"; condition: Expr; consequent: Expr; alternate: Expr }
  | { kind: "Nullish"; left: Expr; right: Expr }
  | { kind: "Pipe"; left: Expr; fn: string; args: Expr[] }
  | { kind: "Array"; elements: Expr[] }
  | { kind: "Object"; entries: Array<{ key: string; value: Expr }> };

export type BinaryOp = "==" | "!=" | "<" | "<=" | ">" | ">=" | "&&" | "||" | "+" | "-" | "*" | "/" | "%";
