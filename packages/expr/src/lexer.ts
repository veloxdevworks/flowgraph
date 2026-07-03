/**
 * Lexer / tokenizer for the flowgraph expression language.
 * Handles the content inside {{ ... }} blocks.
 */

export type TokenKind =
  | "NUMBER"
  | "STRING"
  | "BOOL"
  | "NULL"
  | "IDENT"
  | "DOT"
  | "LBRACKET"
  | "RBRACKET"
  | "LPAREN"
  | "RPAREN"
  | "LBRACE"
  | "RBRACE"
  | "COMMA"
  | "COLON"
  | "QUESTION"
  | "BANG"
  | "EQ"
  | "NEQ"
  | "LT"
  | "LTE"
  | "GT"
  | "GTE"
  | "AND"
  | "OR"
  | "PLUS"
  | "MINUS"
  | "STAR"
  | "SLASH"
  | "PERCENT"
  | "NULLISH"
  | "PIPE"
  | "EOF";

export interface Token {
  kind: TokenKind;
  value: string;
  pos: number;
}

export class LexError extends Error {
  constructor(
    message: string,
    public readonly pos: number,
  ) {
    super(`Lex error at position ${pos}: ${message}`);
  }
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;

  const peek = () => input[pos] ?? "";
  const peekAt = (n: number) => input[pos + n] ?? "";
  const advance = () => input[pos++] ?? "";
  const emit = (kind: TokenKind, value: string, startPos: number) =>
    tokens.push({ kind, value, pos: startPos });

  while (pos < input.length) {
    const start = pos;
    const ch = peek();

    // whitespace
    if (/\s/.test(ch)) {
      advance();
      continue;
    }

    // number
    if (/[0-9]/.test(ch) || (ch === "-" && /[0-9]/.test(peekAt(1)))) {
      let num = advance();
      while (/[0-9._]/.test(peek())) num += advance();
      emit("NUMBER", num.replace(/_/g, ""), start);
      continue;
    }

    // string
    if (ch === '"' || ch === "'") {
      const quote = advance();
      let str = "";
      while (pos < input.length && peek() !== quote) {
        if (peek() === "\\") {
          advance();
          const esc = advance();
          str += esc === "n" ? "\n" : esc === "t" ? "\t" : esc === "r" ? "\r" : esc;
        } else {
          str += advance();
        }
      }
      if (peek() !== quote) throw new LexError("Unterminated string", start);
      advance();
      emit("STRING", str, start);
      continue;
    }

    // ident / keyword
    if (/[a-zA-Z_$]/.test(ch)) {
      let ident = advance();
      while (/[a-zA-Z0-9_$]/.test(peek())) ident += advance();
      if (ident === "true" || ident === "false") emit("BOOL", ident, start);
      else if (ident === "null") emit("NULL", ident, start);
      else emit("IDENT", ident, start);
      continue;
    }

    // two-char operators
    if (ch === "=" && peekAt(1) === "=") {
      advance(); advance(); emit("EQ", "==", start); continue;
    }
    if (ch === "!" && peekAt(1) === "=") {
      advance(); advance(); emit("NEQ", "!=", start); continue;
    }
    if (ch === "<" && peekAt(1) === "=") {
      advance(); advance(); emit("LTE", "<=", start); continue;
    }
    if (ch === ">" && peekAt(1) === "=") {
      advance(); advance(); emit("GTE", ">=", start); continue;
    }
    if (ch === "&" && peekAt(1) === "&") {
      advance(); advance(); emit("AND", "&&", start); continue;
    }
    if (ch === "|" && peekAt(1) === "|") {
      advance(); advance(); emit("OR", "||", start); continue;
    }
    if (ch === "?" && peekAt(1) === "?") {
      advance(); advance(); emit("NULLISH", "??", start); continue;
    }
    if (ch === "|" && peekAt(1) === ">") {
      advance(); advance(); emit("PIPE", "|>", start); continue;
    }

    // single-char
    const singles: Record<string, TokenKind> = {
      ".": "DOT",
      "[": "LBRACKET",
      "]": "RBRACKET",
      "(": "LPAREN",
      ")": "RPAREN",
      "{": "LBRACE",
      "}": "RBRACE",
      ",": "COMMA",
      ":": "COLON",
      "?": "QUESTION",
      "!": "BANG",
      "<": "LT",
      ">": "GT",
      "+": "PLUS",
      "-": "MINUS",
      "*": "STAR",
      "/": "SLASH",
      "%": "PERCENT",
    };
    const kind = singles[ch];
    if (kind) {
      advance();
      emit(kind, ch, start);
      continue;
    }

    throw new LexError(`Unexpected character: ${JSON.stringify(ch)}`, start);
  }

  tokens.push({ kind: "EOF", value: "", pos: input.length });
  return tokens;
}
