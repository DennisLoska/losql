import { KEYWORDS, TYPES } from "./keywords";

export type TokenKind =
  | "keyword"
  | "identifier"
  | "quotedIdentifier"
  | "string"
  | "number"
  | "comment"
  | "operator"
  | "punctuation"
  | "function"
  | "type"
  | "parameter"
  | "whitespace";

export interface Token {
  kind: TokenKind;
  start: number;
  end: number;
}

const MULTI_CHAR_OPERATORS = ["->>", "::", "<>", "<=", ">=", "!=", "||", "->", "=="] as const;

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isHexDigit(ch: string): boolean {
  return (
    (ch >= "0" && ch <= "9") ||
    (ch >= "a" && ch <= "f") ||
    (ch >= "A" && ch <= "F")
  );
}

function isAsciiIdentStart(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    ch === "_"
  );
}

function isAsciiIdentPart(ch: string): boolean {
  return isAsciiIdentStart(ch) || isDigit(ch);
}

function isWordStart(ch: string): boolean {
  return isAsciiIdentStart(ch) || ch.charCodeAt(0) >= 0x80;
}

function isWordPart(ch: string): boolean {
  return isAsciiIdentPart(ch) || ch === "$" || ch.charCodeAt(0) >= 0x80;
}

function isPunctuation(ch: string): boolean {
  return (
    ch === "(" ||
    ch === ")" ||
    ch === "," ||
    ch === ";" ||
    ch === "." ||
    ch === "[" ||
    ch === "]"
  );
}

function scanBlockComment(text: string, start: number): number {
  const n = text.length;
  let i = start + 2;
  let depth = 1;
  while (i < n && depth > 0) {
    if (text[i] === "/" && i + 1 < n && text[i + 1] === "*") {
      depth++;
      i += 2;
    } else if (text[i] === "*" && i + 1 < n && text[i + 1] === "/") {
      depth--;
      i += 2;
    } else {
      i++;
    }
  }
  return i;
}

function scanQuotedString(text: string, quoteStart: number, backslashEscape: boolean): number {
  let i = quoteStart + 1;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (backslashEscape && ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "'") {
      if (i + 1 < n && text[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return n;
}

function scanQuotedIdentifier(text: string, start: number): number {
  const n = text.length;
  const quote = text[start]!;
  let i = start + 1;
  while (i < n) {
    if (text[i] === quote) {
      if (i + 1 < n && text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return n;
}

function matchDollarQuoteTag(text: string, pos: number): string | null {
  if (text[pos] !== "$") return null;
  let i = pos + 1;
  const n = text.length;
  if (i < n && text[i] === "$") {
    return "$$";
  }
  if (i < n && isAsciiIdentStart(text[i]!)) {
    i++;
    while (i < n && isAsciiIdentPart(text[i]!)) {
      i++;
    }
    if (i < n && text[i] === "$") {
      return text.slice(pos, i + 1);
    }
  }
  return null;
}

function scanNumber(text: string, start: number): number {
  const n = text.length;
  const ch = text[start]!;
  let i = start;
  if (ch === "0" && i + 2 < n && (text[i + 1] === "x" || text[i + 1] === "X") && isHexDigit(text[i + 2]!)) {
    i += 2;
    while (i < n && isHexDigit(text[i]!)) {
      i++;
    }
    return i;
  }
  if (ch === ".") {
    i++;
    while (i < n && isDigit(text[i]!)) {
      i++;
    }
  } else {
    while (i < n && isDigit(text[i]!)) {
      i++;
    }
    if (i < n && text[i] === ".") {
      i++;
      while (i < n && isDigit(text[i]!)) {
        i++;
      }
    }
  }
  if (i < n && (text[i] === "e" || text[i] === "E")) {
    let exp = i + 1;
    if (exp < n && (text[exp] === "+" || text[exp] === "-")) {
      exp++;
    }
    if (exp < n && isDigit(text[exp]!)) {
      i = exp + 1;
      while (i < n && isDigit(text[i]!)) {
        i++;
      }
    }
  }
  return i;
}

const RELATION_PRECEDING_KEYWORDS = new Set([
  "table",
  "into",
  "view",
  "index",
  "exists",
  "references",
]);

function classifyWord(
  text: string,
  start: number,
  end: number,
  lastSig: Token | undefined,
): TokenKind {
  const lower = text.slice(start, end).toLowerCase();
  if (TYPES.has(lower)) return "type";
  if (KEYWORDS.has(lower)) return "keyword";

  const n = text.length;
  let look = end;
  while (look < n && isWhitespace(text[look]!)) {
    look++;
  }
  // A word (not type/keyword) whose next non-whitespace char is `(` is a function,
  // except when preceded by `table`, `into`, `view`, `index`, `exists`, or `references`
  // (with or without whitespace before `(`), or by `on` when at least one whitespace
  // character separates the word from `(` (e.g. `create index i on t (a)` vs `on lower(x)`).
  const prevWord =
    lastSig && lastSig.kind === "keyword"
      ? text.slice(lastSig.start, lastSig.end).toLowerCase()
      : "";
  const isRelationNameBeforeColumnList =
    RELATION_PRECEDING_KEYWORDS.has(prevWord) ||
    (prevWord === "on" && look > end);
  return look < n && text[look] === "(" && !isRelationNameBeforeColumnList
    ? "function"
    : "identifier";
}

function matchOperatorLength(text: string, pos: number): number {
  let matchedOp = "";
  for (const op of MULTI_CHAR_OPERATORS) {
    if (text.startsWith(op, pos) && op.length > matchedOp.length) {
      matchedOp = op;
    }
  }
  return matchedOp.length > 0 ? matchedOp.length : 1;
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let lastSig: Token | undefined;
  const push = (tok: Token) => {
    tokens.push(tok);
    if (tok.kind !== "whitespace" && tok.kind !== "comment") {
      lastSig = tok;
    }
  };
  const n = text.length;
  let i = 0;

  while (i < n) {
    const ch = text[i]!;

    if (isWhitespace(ch)) {
      const start = i++;
      while (i < n && isWhitespace(text[i]!)) i++;
      push({ kind: "whitespace", start, end: i });
      continue;
    }

    if (ch === "-" && i + 1 < n && text[i + 1] === "-") {
      const start = i;
      i += 2;
      while (i < n && text[i] !== "\n") i++;
      push({ kind: "comment", start, end: i });
      continue;
    }

    if (ch === "/" && i + 1 < n && text[i + 1] === "*") {
      const start = i;
      i = scanBlockComment(text, i);
      push({ kind: "comment", start, end: i });
      continue;
    }

    if (ch === "'") {
      const start = i;
      i = scanQuotedString(text, i, false);
      push({ kind: "string", start, end: i });
      continue;
    }
    if (
      (ch === "E" || ch === "e") &&
      i + 1 < n &&
      text[i + 1] === "'" &&
      (i === 0 || !isWordPart(text[i - 1]!))
    ) {
      const start = i;
      i = scanQuotedString(text, i + 1, true);
      push({ kind: "string", start, end: i });
      continue;
    }

    if (ch === "$") {
      const tag = matchDollarQuoteTag(text, i);
      if (tag !== null) {
        const start = i;
        const closeIdx = text.indexOf(tag, i + tag.length);
        i = closeIdx === -1 ? n : closeIdx + tag.length;
        push({ kind: "string", start, end: i });
        continue;
      }
      if (i + 1 < n && isDigit(text[i + 1]!)) {
        const start = i;
        i += 2;
        while (i < n && isDigit(text[i]!)) i++;
        push({ kind: "parameter", start, end: i });
        continue;
      }
    }

    if (ch === '"' || ch === "`") {
      const start = i;
      i = scanQuotedIdentifier(text, i);
      push({ kind: "quotedIdentifier", start, end: i });
      continue;
    }

    if (isDigit(ch) || (ch === "." && i + 1 < n && isDigit(text[i + 1]!))) {
      const start = i;
      i = scanNumber(text, i);
      push({ kind: "number", start, end: i });
      continue;
    }

    if (isWordStart(ch)) {
      const start = i++;
      while (i < n && isWordPart(text[i]!)) i++;
      push({ kind: classifyWord(text, start, i, lastSig), start, end: i });
      continue;
    }

    if (
      ch === ":" &&
      (i === 0 || text[i - 1] !== ":") &&
      i + 1 < n &&
      isAsciiIdentStart(text[i + 1]!)
    ) {
      const start = i;
      i += 2;
      while (i < n && isWordPart(text[i]!)) i++;
      push({ kind: "parameter", start, end: i });
      continue;
    }

    if (ch === "?") {
      push({ kind: "parameter", start: i, end: ++i });
      continue;
    }

    if (isPunctuation(ch)) {
      push({ kind: "punctuation", start: i, end: ++i });
      continue;
    }

    const len = matchOperatorLength(text, i);
    push({ kind: "operator", start: i, end: i + len });
    i += len;
  }

  return tokens;
}

