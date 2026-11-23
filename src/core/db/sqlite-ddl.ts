import type { Token } from "../sql/lexer";
import type { RelationConstraint } from "./types";

/**
 * Reads the stored `CREATE TABLE` / `CREATE INDEX` text of a SQLite Relation for the facts the
 * PRAGMAs do not report: constraint names, CHECK expressions, generated column expressions and the
 * text of expression index terms. Every slice is copied from the stored text verbatim. Nothing here
 * throws: text it cannot read yields fewer facts, never an error.
 */

/** SQLite's own case folding of identifiers and keywords: ASCII letters only. */
export function asciiFold(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

interface Tok {
  kind: Token["kind"];
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

const BOM = "\uFEFF";

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v" || ch === BOM;
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

function isHexDigit(ch: string | undefined): boolean {
  return ch !== undefined && /[0-9A-Fa-f]/.test(ch);
}

/** SQLite's identifier characters: ASCII letters, digits, `_`, `$` and every non-ASCII character. */
function isIdChar(ch: string | undefined): boolean {
  return ch !== undefined && (/[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) >= 0x80);
}

const OPERATORS = ["->>", "->", "<<", ">>", "<=", ">=", "<>", "!=", "==", "||"];

/** End of the token kind and extent starting at `i`, where `sql[i]` is not whitespace. */
function scanToken(sql: string, i: number): { kind: Token["kind"]; end: number } {
  const n = sql.length;
  const ch = sql[i]!;
  const next = sql[i + 1];
  if (ch === "-" && next === "-") {
    const nl = sql.indexOf("\n", i + 2);
    return { kind: "comment", end: nl === -1 ? n : nl };
  }
  if (ch === "/" && next === "*") {
    // SQLite block comments do not nest: one ends at its first `*/`.
    const close = sql.indexOf("*/", i + 2);
    return { kind: "comment", end: close === -1 ? n : close + 2 };
  }
  if (ch === "'" || ch === '"' || ch === "`") {
    let j = i + 1;
    for (;;) {
      const close = sql.indexOf(ch, j);
      if (close === -1) {
        j = n;
        break;
      }
      if (sql[close + 1] === ch) {
        j = close + 2;
        continue;
      }
      j = close + 1;
      break;
    }
    return { kind: ch === "'" ? "string" : "quotedIdentifier", end: j };
  }
  if (ch === "[") {
    const close = sql.indexOf("]", i + 1);
    return { kind: "quotedIdentifier", end: close === -1 ? n : close + 1 };
  }
  if ((ch === "x" || ch === "X") && next === "'") {
    const close = sql.indexOf("'", i + 2);
    return { kind: "string", end: close === -1 ? n : close + 1 };
  }
  if (isDigit(ch) || (ch === "." && isDigit(next))) {
    let j = i;
    if (ch === "0" && (next === "x" || next === "X") && isHexDigit(sql[i + 2])) {
      j += 2;
      while (isHexDigit(sql[j])) j++;
    } else {
      while (isDigit(sql[j]) || sql[j] === "_") j++;
      if (sql[j] === ".") {
        j++;
        while (isDigit(sql[j]) || sql[j] === "_") j++;
      }
      if (sql[j] === "e" || sql[j] === "E") {
        let k = j + 1;
        if (sql[k] === "+" || sql[k] === "-") k++;
        if (isDigit(sql[k])) {
          j = k;
          while (isDigit(sql[j])) j++;
        }
      }
    }
    // SQLite reads letters glued to a number as part of one (bad) token.
    while (isIdChar(sql[j])) j++;
    return { kind: "number", end: j };
  }
  if (ch === "?") {
    let j = i + 1;
    while (isDigit(sql[j])) j++;
    return { kind: "parameter", end: j };
  }
  if (ch === ":" || ch === "@" || ch === "$") {
    let j = i + 1;
    while (isIdChar(sql[j])) j++;
    return { kind: "parameter", end: j };
  }
  if (isIdChar(ch)) {
    // A byte order mark inside a word belongs to it; only at a token boundary is it whitespace.
    let j = i + 1;
    while (isIdChar(sql[j])) j++;
    return { kind: "identifier", end: j };
  }
  if (ch === "(" || ch === ")" || ch === "," || ch === ";" || ch === "." || ch === "]") {
    return { kind: "punctuation", end: i + 1 };
  }
  const op = OPERATORS.find((o) => sql.startsWith(o, i));
  return { kind: "operator", end: i + (op?.length ?? 1) };
}

/**
 * Significant tokens of SQLite text, read in one pass the way SQLite's own tokenizer reads them:
 * `[name]` identifiers, block comments that end at their first `*\/`, and a byte order mark (U+FEFF)
 * at a token boundary as whitespace. Offsets index the text as given.
 */
function significantTokens(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < sql.length) {
    if (isSpace(sql[i]!)) {
      i++;
      continue;
    }
    const start = i;
    const { kind, end } = scanToken(sql, start);
    i = end;
    if (kind === "comment") continue;
    const text = sql.slice(start, end);
    const isWord = kind === "identifier";
    out.push({
      kind,
      start,
      end,
      word: isWord ? asciiFold(text) : "",
      punct: kind === "punctuation" ? text : "",
      ident: isWord || kind === "quotedIdentifier" || kind === "string" ? unquoteIdent(text) : null,
    });
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
 * Where the inline `REFERENCES` clause at `at` ends: at the next column constraint after its target
 * table, column list and `MATCH name` (each of which may be spelled like a constraint word), skipping
 * its own `SET NULL`, `SET DEFAULT` and `NOT DEFERRABLE`.
 */
function referencesClauseEnd(toks: Tok[], at: number, end: number): number {
  // The target table is an identifier, even one spelled `generated` or `check`.
  let j = at + 2;
  while (j < end) {
    const tok = toks[j]!;
    if (tok.punct === "(") {
      const close = matchParen(toks, j);
      if (close === -1) return end;
      j = close + 1;
      continue;
    }
    if (tok.word === "match" && (toks[j + 1]?.ident ?? null) !== null) {
      j += 2;
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

/**
 * Reads the table constraints in `toks[from..to)`. SQLite lets table constraints follow one another
 * without commas, so each one ends where the next starts: at a constraint word outside parentheses
 * (these words are reserved, so nothing else in a constraint can be spelled like one bare).
 */
function parseTableConstraints(
  sql: string,
  toks: Tok[],
  from: number,
  to: number,
  constraints: RelationConstraint[],
): void {
  let name: string | undefined;
  let i = from;
  while (i < to) {
    if (toks[i]!.word === "constraint") {
      const ident = toks[i + 1]?.ident;
      if (ident === null || ident === undefined) return;
      name = ident;
      i += 2;
      continue;
    }
    if (!TABLE_CONSTRAINT_WORDS.has(toks[i]!.word)) return;
    let end = to;
    let depth = 0;
    for (let k = i + 1; k < to; k++) {
      const tok = toks[k]!;
      if (tok.punct === "(") depth++;
      else if (tok.punct === ")") depth--;
      else if (depth === 0 && TABLE_CONSTRAINT_WORDS.has(tok.word)) {
        end = k;
        break;
      }
    }
    parseTableConstraint(sql, toks, i, end, name, constraints);
    name = undefined;
    i = end;
  }
}

/** Reads the one table constraint `toks[from..to)`, after any `CONSTRAINT name`. */
function parseTableConstraint(
  sql: string,
  toks: Tok[],
  from: number,
  to: number,
  name: string | undefined,
  constraints: RelationConstraint[],
): void {
  const i = from;
  const head = toks[i]?.word;
  const withName = (c: RelationConstraint): RelationConstraint => {
    if (name !== undefined) c.name = name;
    return c;
  };
  if (head === "primary" && toks[i + 1]?.word === "key") {
    const list = columnList(toks, i + 2);
    if (list && list.close < to) constraints.push(withName({ kind: "PRIMARY KEY", columns: list.names }));
  } else if (head === "unique") {
    const list = columnList(toks, i + 1);
    if (list && list.close < to) constraints.push(withName({ kind: "UNIQUE", columns: list.names }));
  } else if (head === "check" && toks[i + 1]?.punct === "(") {
    const close = matchParen(toks, i + 1);
    if (close === -1 || close >= to) return;
    constraints.push(
      withName({ kind: "CHECK", columns: [], definition: sliceBetween(sql, toks, i + 2, close) }),
    );
  } else if (head === "foreign" && toks[i + 1]?.word === "key") {
    const list = columnList(toks, i + 2);
    if (!list || list.close + 1 >= to || toks[list.close + 1]!.word !== "references") return;
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
          generated.set(asciiFold(column), sliceBetween(sql, toks, i + 2, close));
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
    // Only an ordinary `CREATE [TEMP|TEMPORARY] TABLE` declares columns and constraints; the
    // arguments of `CREATE VIRTUAL TABLE ... USING module(...)` belong to the module.
    let head = 0;
    if (toks[head]?.word !== "create") return { constraints, generated };
    head++;
    if (toks[head]?.word === "temp" || toks[head]?.word === "temporary") head++;
    if (toks[head]?.word !== "table") return { constraints, generated };
    let open = -1;
    for (let i = head + 1; i < toks.length; i++) {
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
        parseTableConstraints(sql, toks, from, to, constraints);
      } else {
        parseColumnDefinition(sql, toks, from, to, constraints, generated);
      }
    }
  } catch {
    // Unreadable text: keep whatever was read before it.
  }
  return { constraints, generated };
}

/** Words that join or prefix operands, so a word after one of them is itself an operand. */
const OPERATOR_WORDS = new Set([
  "and",
  "or",
  "not",
  "is",
  "in",
  "like",
  "glob",
  "regexp",
  "match",
  "between",
  "escape",
  "collate",
  "isnull",
  "notnull",
  "case",
  "when",
  "then",
  "else",
  "distinct",
  "from",
]);

/** Postfix null tests: an operand ends with them. */
const POSTFIX_WORDS = new Set(["isnull", "notnull"]);

/** Operator words SQLite also accepts as identifiers (its fallback `LIKE_KW` and `MATCH`). */
const IDENT_OPERATOR_WORDS = new Set(["like", "glob", "regexp", "match"]);

/**
 * Whether `toks[k]` stands where an operand is expected inside the term starting at `from`: first,
 * or after `(`, `,`, a symbol operator or an operator word other than a postfix null test.
 */
function inOperandPosition(toks: Tok[], k: number, from: number): boolean {
  if (k === from) return true;
  const prev = toks[k - 1]!;
  if (prev.punct === "(" || prev.punct === ",") return true;
  if (prev.kind === "operator") return true;
  if (OPERATOR_WORDS.has(prev.word) && !POSTFIX_WORDS.has(prev.word)) {
    // A keyword-named operand before it makes it an operand, not an operator.
    return !(IDENT_OPERATOR_WORDS.has(prev.word) && inOperandPosition(toks, k - 1, from));
  }
  return false;
}

/** Whether `toks[k]` can end an expression in the term starting at `from`, so an `ASC`/`DESC` after it is a sort order. */
function endsOperand(toks: Tok[], k: number, from: number): boolean {
  const tok = toks[k]!;
  if (tok.punct === ")") return true;
  if (tok.kind === "number") return true;
  if (POSTFIX_WORDS.has(tok.word)) return true;
  if (IDENT_OPERATOR_WORDS.has(tok.word)) return inOperandPosition(toks, k, from);
  return tok.ident !== null && !OPERATOR_WORDS.has(tok.word);
}

/**
 * Whether the term `toks[from..to)` holds an operator outside parentheses. `COLLATE` binds tighter
 * than every binary operator and `NOT`, so a trailing `COLLATE name` after one belongs to its operand;
 * it binds looser than the unary `-`, `+` and `~` that may lead the term.
 */
function hasTopLevelOperator(toks: Tok[], from: number, to: number): boolean {
  let i = from;
  while (i < to && toks[i]!.kind === "operator") i++;
  let depth = 0;
  for (; i < to; i++) {
    const tok = toks[i]!;
    if (tok.punct === "(") depth++;
    else if (tok.punct === ")") depth--;
    else if (depth !== 0) continue;
    else if (tok.kind === "operator") return true;
    else if (OPERATOR_WORDS.has(tok.word)) {
      if (!IDENT_OPERATOR_WORDS.has(tok.word) || !inOperandPosition(toks, i, from)) return true;
    }
  }
  return false;
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
      // Order and a top-level collation are reported apart from the term itself.
      if (
        end - 1 > from &&
        (toks[end - 1]!.word === "asc" || toks[end - 1]!.word === "desc") &&
        endsOperand(toks, end - 2, from)
      ) {
        end--;
      }
      if (
        end - 2 > from &&
        toks[end - 2]!.word === "collate" &&
        !hasTopLevelOperator(toks, from, end - 2)
      ) {
        end -= 2;
      }
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
