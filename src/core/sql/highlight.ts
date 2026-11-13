import { type JsonTokenKind, tokenizeJson } from "./json";
import { type TokenKind, tokenize } from "./lexer";

export type SyntaxRole =
  | "keyword"
  | "function"
  | "variable"
  | "string"
  | "number"
  | "type"
  | "operator"
  | "punctuation"
  | "comment"
  | "text";

export interface Span {
  start: number;
  end: number;
  role: SyntaxRole;
}

const SQL_ROLE_MAP: Record<Exclude<TokenKind, "whitespace">, SyntaxRole> = {
  keyword: "keyword",
  function: "function",
  type: "type",
  string: "string",
  number: "number",
  comment: "comment",
  operator: "operator",
  punctuation: "punctuation",
  parameter: "variable",
  quotedIdentifier: "variable",
  identifier: "text",
};

const JSON_ROLE_MAP: Record<Exclude<JsonTokenKind, "whitespace">, SyntaxRole> = {
  key: "type",
  string: "string",
  number: "number",
  boolean: "keyword",
  null: "keyword",
  punctuation: "punctuation",
  invalid: "text",
};

export function highlightSql(text: string): Span[] {
  const spans: Span[] = [];
  for (const token of tokenize(text)) {
    if (token.kind === "whitespace") continue;
    spans.push({
      start: token.start,
      end: token.end,
      role: SQL_ROLE_MAP[token.kind],
    });
  }
  return spans;
}

export function highlightJson(text: string): Span[] {
  const spans: Span[] = [];
  for (const token of tokenizeJson(text)) {
    if (token.kind === "whitespace") continue;
    spans.push({
      start: token.start,
      end: token.end,
      role: JSON_ROLE_MAP[token.kind],
    });
  }
  return spans;
}
