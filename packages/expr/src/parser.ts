/**
 * Recursive-descent parser for the flowgraph expression language.
 */

import { type Token, type TokenKind, tokenize } from "./lexer.js";
import type { Expr, BinaryOp } from "./ast.js";

export class ParseError extends Error {
  constructor(
    message: string,
    public readonly pos: number,
  ) {
    super(`Parse error at position ${pos}: ${message}`);
  }
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] ?? { kind: "EOF", value: "", pos: 0 };
  }

  private advance(): Token {
    const t = this.peek();
    this.pos++;
    return t;
  }

  private expect(kind: TokenKind): Token {
    const t = this.peek();
    if (t.kind !== kind) {
      throw new ParseError(`Expected ${kind} but got ${t.kind} (${JSON.stringify(t.value)})`, t.pos);
    }
    return this.advance();
  }

  private check(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  private match(...kinds: TokenKind[]): boolean {
    if (kinds.includes(this.peek().kind)) {
      this.advance();
      return true;
    }
    return false;
  }

  // Parse the full expression
  parseExpression(): Expr {
    return this.parseTernary();
  }

  private parseTernary(): Expr {
    let expr = this.parseOr();
    if (this.match("QUESTION")) {
      const consequent = this.parseOr();
      this.expect("COLON");
      const alternate = this.parseTernary();
      expr = { kind: "Ternary", condition: expr, consequent, alternate };
    }
    return expr;
  }

  private parseOr(): Expr {
    let expr = this.parseAnd();
    while (this.check("OR")) {
      const op = this.advance().value as BinaryOp;
      expr = { kind: "Binary", op, left: expr, right: this.parseAnd() };
    }
    return expr;
  }

  private parseAnd(): Expr {
    let expr = this.parseNullish();
    while (this.check("AND")) {
      const op = this.advance().value as BinaryOp;
      expr = { kind: "Binary", op, left: expr, right: this.parseNullish() };
    }
    return expr;
  }

  private parseNullish(): Expr {
    let expr = this.parseEquality();
    while (this.check("NULLISH")) {
      this.advance();
      expr = { kind: "Nullish", left: expr, right: this.parseEquality() };
    }
    return expr;
  }

  private parseEquality(): Expr {
    let expr = this.parseComparison();
    while (this.check("EQ") || this.check("NEQ")) {
      const op = this.advance().value as BinaryOp;
      expr = { kind: "Binary", op, left: expr, right: this.parseComparison() };
    }
    return expr;
  }

  private parseComparison(): Expr {
    let expr = this.parseAdditive();
    while (this.check("LT") || this.check("LTE") || this.check("GT") || this.check("GTE")) {
      const op = this.advance().value as BinaryOp;
      expr = { kind: "Binary", op, left: expr, right: this.parseAdditive() };
    }
    return expr;
  }

  private parseAdditive(): Expr {
    let expr = this.parseMultiplicative();
    while (this.check("PLUS") || this.check("MINUS")) {
      const op = this.advance().value as BinaryOp;
      expr = { kind: "Binary", op, left: expr, right: this.parseMultiplicative() };
    }
    return expr;
  }

  private parseMultiplicative(): Expr {
    let expr = this.parsePipe();
    while (this.check("STAR") || this.check("SLASH") || this.check("PERCENT")) {
      const op = this.advance().value as BinaryOp;
      expr = { kind: "Binary", op, left: expr, right: this.parsePipe() };
    }
    return expr;
  }

  private parsePipe(): Expr {
    let expr = this.parseUnary();
    while (this.check("PIPE")) {
      this.advance();
      const fnName = this.expect("IDENT").value;
      let args: Expr[] = [];
      if (this.check("LPAREN")) {
        this.advance();
        args = this.parseArgList();
        this.expect("RPAREN");
      }
      expr = { kind: "Pipe", left: expr, fn: fnName, args };
    }
    return expr;
  }

  private parseUnary(): Expr {
    if (this.check("BANG")) {
      this.advance();
      return { kind: "Unary", op: "!", operand: this.parseUnary() };
    }
    if (this.check("MINUS")) {
      this.advance();
      const operand = this.parseUnary();
      if (operand.kind === "Number") return { kind: "Number", value: -operand.value };
      return { kind: "Unary", op: "-", operand };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    while (true) {
      if (this.check("DOT")) {
        this.advance();
        const prop = this.expect("IDENT").value;
        expr = { kind: "Member", object: expr, property: prop };
      } else if (this.check("LBRACKET")) {
        this.advance();
        const index = this.parseExpression();
        this.expect("RBRACKET");
        expr = { kind: "Index", object: expr, index };
      } else {
        break;
      }
    }
    return expr;
  }

  private parsePrimary(): Expr {
    const t = this.peek();

    if (t.kind === "NUMBER") {
      this.advance();
      return { kind: "Number", value: Number(t.value) };
    }

    if (t.kind === "STRING") {
      this.advance();
      return { kind: "String", value: t.value };
    }

    if (t.kind === "BOOL") {
      this.advance();
      return { kind: "Bool", value: t.value === "true" };
    }

    if (t.kind === "NULL") {
      this.advance();
      return { kind: "Null" };
    }

    if (t.kind === "IDENT") {
      this.advance();
      // function call?
      if (this.check("LPAREN")) {
        this.advance();
        const args = this.parseArgList();
        this.expect("RPAREN");
        return { kind: "Call", callee: t.value, args };
      }
      return { kind: "Ident", name: t.value };
    }

    if (t.kind === "LPAREN") {
      this.advance();
      const expr = this.parseExpression();
      this.expect("RPAREN");
      return expr;
    }

    if (t.kind === "LBRACKET") {
      this.advance();
      const elements: Expr[] = [];
      while (!this.check("RBRACKET") && !this.check("EOF")) {
        elements.push(this.parseExpression());
        if (!this.match("COMMA")) break;
      }
      this.expect("RBRACKET");
      return { kind: "Array", elements };
    }

    if (t.kind === "LBRACE") {
      this.advance();
      const entries: Array<{ key: string; value: Expr }> = [];
      while (!this.check("RBRACE") && !this.check("EOF")) {
        const key =
          this.peek().kind === "STRING"
            ? this.advance().value
            : this.expect("IDENT").value;
        this.expect("COLON");
        const value = this.parseExpression();
        entries.push({ key, value });
        if (!this.match("COMMA")) break;
      }
      this.expect("RBRACE");
      return { kind: "Object", entries };
    }

    throw new ParseError(`Unexpected token ${t.kind} (${JSON.stringify(t.value)})`, t.pos);
  }

  private parseArgList(): Expr[] {
    const args: Expr[] = [];
    while (!this.check("RPAREN") && !this.check("EOF")) {
      args.push(this.parseExpression());
      if (!this.match("COMMA")) break;
    }
    return args;
  }
}

export function parseExpr(input: string): Expr {
  const tokens = tokenize(input);
  const parser = new Parser(tokens);
  const expr = parser.parseExpression();
  return expr;
}
