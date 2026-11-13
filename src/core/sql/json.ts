export type JsonTokenKind =
  | "key"
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "punctuation"
  | "whitespace"
  | "invalid";

export interface JsonToken {
  kind: JsonTokenKind;
  start: number;
  end: number;
}

const NUMBER_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/;

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

function isPunctuation(ch: string): boolean {
  return ch === "{" || ch === "}" || ch === "[" || ch === "]" || ch === ":" || ch === ",";
}

function isBoundary(ch: string | undefined): boolean {
  return ch === undefined || isWhitespace(ch) || isPunctuation(ch);
}

export function tokenizeJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  const n = text.length;
  let i = 0;

  while (i < n) {
    const ch = text[i]!;

    if (isWhitespace(ch)) {
      const start = i;
      i++;
      while (i < n && isWhitespace(text[i]!)) {
        i++;
      }
      tokens.push({ kind: "whitespace", start, end: i });
      continue;
    }

    if (isPunctuation(ch)) {
      tokens.push({ kind: "punctuation", start: i, end: i + 1 });
      i++;
      continue;
    }

    if (ch === '"') {
      const start = i;
      i++;
      let closed = false;
      while (i < n) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) {
        tokens.push({ kind: "invalid", start, end: n });
        i = n;
        continue;
      }
      let look = i;
      while (look < n && isWhitespace(text[look]!)) {
        look++;
      }
      const kind: JsonTokenKind = look < n && text[look] === ":" ? "key" : "string";
      tokens.push({ kind, start, end: i });
      continue;
    }

    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      const match = NUMBER_RE.exec(text.slice(i));
      if (match && isBoundary(text[i + match[0].length])) {
        const end = i + match[0].length;
        tokens.push({ kind: "number", start: i, end });
        i = end;
        continue;
      }
    }

    if (text.startsWith("true", i) && isBoundary(text[i + 4])) {
      tokens.push({ kind: "boolean", start: i, end: i + 4 });
      i += 4;
      continue;
    }

    if (text.startsWith("false", i) && isBoundary(text[i + 5])) {
      tokens.push({ kind: "boolean", start: i, end: i + 5 });
      i += 5;
      continue;
    }

    if (text.startsWith("null", i) && isBoundary(text[i + 4])) {
      tokens.push({ kind: "null", start: i, end: i + 4 });
      i += 4;
      continue;
    }

    const start = i;
    i++;
    while (i < n && !isWhitespace(text[i]!) && !isPunctuation(text[i]!)) {
      i++;
    }
    tokens.push({ kind: "invalid", start, end: i });
  }

  return tokens;
}
