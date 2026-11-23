import { type Token, tokenize } from "../sql/lexer";
import type { RelationConstraint } from "./types";

/**
 * Reads the stored `CREATE TABLE` / `CREATE INDEX` text of a SQLite Relation for the facts the
 * PRAGMAs do not report: constraint names, CHECK expressions, generated column expressions and the
 * text of expression index terms. Every slice is copied from the stored text verbatim. Nothing here
 * throws: text it cannot read yields fewer facts, never an error.
 */

interface Tok {
  start: number;
  end: number;
  /** Lowercased text of a bare word; "" for anything else. */
  word: string;
  /** The single punctuation character, or "". */
  punct: string;
  /** The identifier this token names (unquoted), or null when it cannot name one. */
  ident: string | null;
}

function unquoteIdent(text: string): string {
  const first = text[0];
  if (first === '"' || first === "`") {
    const inner = text.endsWith(first) && text.length >= 2 ? text.slice(1, -1) : text.slice(1);
    return inner.split(first + first).join(first);
  }
  if (first === "[") return text.endsWith("]") ? text.slice(1, -1) : text.slice(1);
  if (first === "'") {
    const inner = text.endsWith("'") && text.length >= 2 ? text.slice(1, -1) : text.slice(1);
    return inner.split("''").join("'");
  }
  return text;
}

/**
 * Significant tokens of SQLite text. The shared lexer does not know SQLite's `[name]` identifiers,
 * so each one is read here up to its `]` and the lexer resumes after it.
 */
function significantTokens(sql: string): Tok[] {
  const out: Tok[] = [];
  let offset = 0;
  outer: while (offset < sql.length) {
    const tokens: Token[] = tokenize(sql.slice(offset));
    for (const t of tokens) {
      if (t.kind === "whitespace" || t.kind === "comment") continue;
      const start = t.start + offset;
      const end = t.end + offset;
      const text = sql.slice(start, end);
      if (t.kind === "punctuation" && text === "[") {
        const close = sql.indexOf("]", start + 1);
        const stop = close === -1 ? sql.length : close + 1;
        const raw = sql.slice(start, stop);
        out.push({ start, end: stop, word: "", punct: "", ident: unquoteIdent(raw) });
        offset = stop;
        continue outer;
      }
      const isWord = /^[A-Za-z_\u0080-￿]/.test(text);
      out.push({
        start,
        end,
        word: isWord ? text.toLowerCase() : "",
        punct: t.kind === "punctuation" ? text : "",
        ident:
          isWord || t.kind === "quotedIdentifier" || t.kind === "string"
            ? unquoteIdent(text)
            : null,
      });
    }
    break;
  }
  return out;
}

/** Index of the `)` closing the `(` at `open`, or -1. */
function matchParen(toks: Tok[], open: number): number {
  let depth = 0;
  for (let i = open; i < toks.length; i++) {
    const p = toks[i]!.punct;
    if (p === "(") depth++;
    else if (p === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits `toks[from..to)` on commas at depth zero into [from, to) ranges. */
function splitTopLevel(toks: Tok[], from: number, to: number): [number, number][] {
  const parts: [number, number][] = [];
  let depth = 0;
  let partStart = from;
  for (let i = from; i < to; i++) {
    const p = toks[i]!.punct;
    if (p === "(") depth++;
    else if (p === ")") depth--;
    else if (p === "," && depth === 0) {
      parts.push([partStart, i]);
      partStart = i + 1;
    }
  }
  if (partStart < to) parts.push([partStart, to]);
  return parts;
}

function sliceBetween(sql: string, toks: Tok[], from: number, to: number): string {
  if (from >= to) return "";
  return sql.slice(toks[from]!.start, toks[to - 1]!.end);
}

/** Names inside `( a, b COLLATE x DESC )` starting at the `(` at `open`; the first token of each. */
function columnList(toks: Tok[], open: number): { names: string[]; close: number } | null {
  if (toks[open]?.punct !== "(") return null;
  const close = matchParen(toks, open);
  if (close === -1) return null;
  const names: string[] = [];
  for (const [a, b] of splitTopLevel(toks, open + 1, close)) {
    const ident = a < b ? toks[a]!.ident : null;
    if (ident === null) return null;
    names.push(ident);
  }
  return { names, close };
}

const FK_ACTIONS: Record<string, string> = {
  "set null": "SET NULL",
  "set default": "SET DEFAULT",
  cascade: "CASCADE",
  restrict: "RESTRICT",
  "no action": "NO ACTION",
};

/**
 * Reads `REFERENCES tbl [(cols)] [ON DELETE|UPDATE action | MATCH name | [NOT] DEFERRABLE ...]`
 * where `at` is the `REFERENCES` token and `end` bounds the clause.
 */
function readReferences(
  toks: Tok[],
  at: number,
  end: number,
): NonNullable<RelationConstraint["references"]> | null {
  const table = toks[at + 1];
  if (!table || table.ident === null) return null;
  const references: NonNullable<RelationConstraint["references"]> = {
    relation: table.ident,
    columns: [],
  };
  let i = at + 2;
  if (toks[i]?.punct === "(") {
    const list = columnList(toks, i);
    if (!list) return null;
    references.columns = list.names;
    i = list.close + 1;
  }
  while (i < end) {
    if (toks[i]!.word === "on" && (toks[i + 1]?.word === "delete" || toks[i + 1]?.word === "update")) {
      const which = toks[i + 1]!.word;
      const one = toks[i + 2]?.word ?? "";
      const two = `${one} ${toks[i + 3]?.word ?? ""}`;
      const action = FK_ACTIONS[two] ?? FK_ACTIONS[one];
      if (action) {
        if (which === "delete") references.onDelete = action;
        else references.onUpdate = action;
        i += action.includes(" ") ? 4 : 3;
        continue;
      }
    }
    i++;
  }
  return references;
}

const COLUMN_CONSTRAINT_WORDS = new Set([
  "constraint",
  "primary",
  "not",
  "null",
  "unique",
  "check",
  "default",
  "collate",
  "references",
  "generated",
  "as",
]);

/**
 * Where the inline `REFERENCES` clause at `at` ends: at the next column constraint, skipping its own
 * `SET NULL`, `SET DEFAULT` and `NOT DEFERRABLE`.
 */
function referencesClauseEnd(toks: Tok[], at: number, end: number): number {
  let j = at + 1;
  while (j < end) {
    const tok = toks[j]!;
    if (tok.punct === "(") {
      const close = matchParen(toks, j);
      if (close === -1) return end;
      j = close + 1;
      continue;
    }
    const prev = toks[j - 1]!.word;
    const ownWord =
      ((tok.word === "null" || tok.word === "default") && prev === "set") ||
      (tok.word === "not" && toks[j + 1]?.word === "deferrable");
    if (COLUMN_CONSTRAINT_WORDS.has(tok.word) && !ownWord) return j;
    j++;
  }
  return end;
}

const TABLE_CONSTRAINT_WORDS = new Set(["constraint", "primary", "unique", "check", "foreign"]);

function parseTableConstraint(
  sql: string,
  toks: Tok[],
  from: number,
  to: number,
  constraints: RelationConstraint[],
): void {
  let i = from;
  let name: string | undefined;
  if (toks[i]!.word === "constraint") {
    const ident = toks[i + 1]?.ident;
    if (ident === null || ident === undefined) return;
    name = ident;
    i += 2;
  }
  const head = toks[i]?.word;
  const withName = (c: RelationConstraint): RelationConstraint => {
    if (name !== undefined) c.name = name;
    return c;
  };
  if (head === "primary" && toks[i + 1]?.word === "key") {
    const list = columnList(toks, i + 2);
    if (list) constraints.push(withName({ kind: "PRIMARY KEY", columns: list.names }));
  } else if (head === "unique") {
    const list = columnList(toks, i + 1);
    if (list) constraints.push(withName({ kind: "UNIQUE", columns: list.names }));
  } else if (head === "check" && toks[i + 1]?.punct === "(") {
    const close = matchParen(toks, i + 1);
    if (close === -1 || close >= to) return;
    constraints.push(
      withName({ kind: "CHECK", columns: [], definition: sliceBetween(sql, toks, i + 2, close) }),
    );
  } else if (head === "foreign" && toks[i + 1]?.word === "key") {
    const list = columnList(toks, i + 2);
    if (!list || toks[list.close + 1]?.word !== "references") return;
    const references = readReferences(toks, list.close + 1, to);
    if (references) {
      constraints.push(withName({ kind: "FOREIGN KEY", columns: list.names, references }));
    }
  }
}

function parseColumnDefinition(
  sql: string,
  toks: Tok[],
  from: number,
  to: number,
  constraints: RelationConstraint[],
  generated: Map<string, string>,
): void {
  const column = toks[from]!.ident;
  if (column === null) return;
  let name: string | undefined;
  let i = from + 1;
  // Skip the declared type: words and its parenthesised size, up to the first constraint word.
  while (i < to && !COLUMN_CONSTRAINT_WORDS.has(toks[i]!.word)) {
    if (toks[i]!.punct === "(") {
      const close = matchParen(toks, i);
      if (close === -1) return;
      i = close + 1;
    } else {
      i++;
    }
  }
  const take = (): string | undefined => {
    const n = name;
    name = undefined;
    return n;
  };
  const withName = (c: RelationConstraint): RelationConstraint => {
    const n = take();
    if (n !== undefined) c.name = n;
    return c;
  };
  while (i < to) {
    const tok = toks[i]!;
    if (tok.punct === "(") {
      const close = matchParen(toks, i);
      if (close === -1) return;
      i = close + 1;
      continue;
    }
    switch (tok.word) {
      case "constraint": {
        const ident = toks[i + 1]?.ident;
        if (ident === null || ident === undefined) return;
        name = ident;
        i += 2;
        continue;
      }
      case "primary":
        if (toks[i + 1]?.word === "key") {
          constraints.push(withName({ kind: "PRIMARY KEY", columns: [column] }));
          i += 2;
          continue;
        }
        break;
      case "unique":
        constraints.push(withName({ kind: "UNIQUE", columns: [column] }));
        break;
      case "check":
        if (toks[i + 1]?.punct === "(") {
          const close = matchParen(toks, i + 1);
          if (close === -1) return;
          constraints.push(
            withName({
              kind: "CHECK",
              columns: [column],
              definition: sliceBetween(sql, toks, i + 2, close),
            }),
          );
          i = close + 1;
          continue;
        }
        break;
      case "references": {
        const end = referencesClauseEnd(toks, i, to);
        const references = readReferences(toks, i, end);
        if (references) {
          constraints.push(withName({ kind: "FOREIGN KEY", columns: [column], references }));
        }
        i = end;
        continue;
      }
      case "as":
        if (toks[i + 1]?.punct === "(") {
          const close = matchParen(toks, i + 1);
          if (close === -1) return;
          take();
          generated.set(column.toLowerCase(), sliceBetween(sql, toks, i + 2, close));
          i = close + 1;
          continue;
        }
        break;
      case "not":
      case "null":
      case "default":
      case "collate":
        // A name before `NOT NULL`, `DEFAULT …` or `COLLATE …` belongs to that constraint.
        take();
        break;
    }
    i++;
  }
}

export function parseSqliteTableDdl(sql: string): {
  constraints: RelationConstraint[];
  generated: Map<string, string>;
} {
  const constraints: RelationConstraint[] = [];
  const generated = new Map<string, string>();
  try {
    const toks = significantTokens(sql);
    let open = -1;
    for (let i = 0; i < toks.length; i++) {
      if (toks[i]!.word === "as" && open === -1) return { constraints, generated };
      if (toks[i]!.punct === "(") {
        open = i;
        break;
      }
    }
    if (open === -1) return { constraints, generated };
    const close = matchParen(toks, open);
    if (close === -1) return { constraints, generated };
    for (const [from, to] of splitTopLevel(toks, open + 1, close)) {
      if (from >= to) continue;
      const first = toks[from]!;
      const isTableConstraint =
        TABLE_CONSTRAINT_WORDS.has(first.word) &&
        // `CONSTRAINT x` may only start a table constraint when what follows is one.
        (first.word !== "constraint" || TABLE_CONSTRAINT_WORDS.has(toks[from + 2]?.word ?? "")) &&
        (first.word !== "primary" || toks[from + 1]?.word === "key") &&
        (first.word !== "foreign" || toks[from + 1]?.word === "key") &&
        (first.word !== "unique" && first.word !== "check" ? true : toks[from + 1]?.punct === "(");
      if (isTableConstraint) {
        parseTableConstraint(sql, toks, from, to, constraints);
      } else {
        parseColumnDefinition(sql, toks, from, to, constraints, generated);
      }
    }
  } catch {
    // Unreadable text: keep whatever was read before it.
  }
  return { constraints, generated };
}

export function parseSqliteIndexDdl(sql: string): { terms: string[]; predicate?: string } {
  const result: { terms: string[]; predicate?: string } = { terms: [] };
  try {
    const toks = significantTokens(sql);
    const on = toks.findIndex((t) => t.word === "on");
    if (on === -1) return result;
    let open = on + 1;
    while (open < toks.length && toks[open]!.punct !== "(") open++;
    if (open >= toks.length) return result;
    const close = matchParen(toks, open);
    if (close === -1) return result;
    for (const [from, to] of splitTopLevel(toks, open + 1, close)) {
      let end = to;
      // Order and collation are reported apart from the term itself.
      if (end - 1 > from && (toks[end - 1]!.word === "asc" || toks[end - 1]!.word === "desc")) end--;
      if (end - 2 > from && toks[end - 2]!.word === "collate") end -= 2;
      result.terms.push(sliceBetween(sql, toks, from, end));
    }
    if (toks[close + 1]?.word === "where") {
      let end = toks.length;
      while (end > close + 2 && toks[end - 1]!.punct === ";") end--;
      const predicate = sliceBetween(sql, toks, close + 2, end);
      if (predicate) result.predicate = predicate;
    }
  } catch {
    // Unreadable text: no terms.
  }
  return result;
}
