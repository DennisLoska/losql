import { type Token, tokenize } from "./lexer";

export interface Statement {
  start: number;
  end: number;
  text: string;
}

function buildStatement(text: string, segment: Token[]): Statement | null {
  let firstIdx = -1;
  for (let i = 0; i < segment.length; i++) {
    const k = segment[i]!.kind;
    if (k !== "whitespace" && k !== "comment") {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) return null;

  let lastIdx = firstIdx;
  for (let i = segment.length - 1; i >= firstIdx; i--) {
    if (segment[i]!.kind !== "whitespace") {
      lastIdx = i;
      break;
    }
  }

  const start = segment[firstIdx]!.start;
  const end = segment[lastIdx]!.end;
  return { start, end, text: text.slice(start, end) };
}

function isWordToken(token: Token): boolean {
  return (
    token.kind === "keyword" ||
    token.kind === "identifier" ||
    token.kind === "function" ||
    token.kind === "type"
  );
}

type BodyKind = "none" | "trigger" | "routine";

interface BodyState {
  words: string[];
  kind: BodyKind;
  parenDepth: number;
  bodyDepth: number;
  ended: boolean;
  /** A Postgres trigger (`execute function` / `execute procedure`): it has no body. */
  noBody: boolean;
  /**
   * Whether the trigger header has been scanned for `execute function` up to
   * its first top-level `;`. A later scan from further on could only find less,
   * so the header is scanned once.
   */
  headerScanned: boolean;
  /** Inside a SQLite bracket-quoted identifier (`[end]`), which is one name. */
  inBracket: boolean;
  /** The previous token that is not whitespace or a comment, lower-cased. */
  prev: string | null;
  /** What the previous token that is not whitespace or a comment leaves: see `After`. */
  after: After;
}

/**
 * What a token leaves behind it: a value is expected (`expect`), a value has
 * ended (`value`), or a `not` that follows a value (`notAfterValue`, as in
 * `a not like b`), after which a value is expected too but a word that can be a
 * name is the operator it negates.
 */
type After = "expect" | "value" | "notAfterValue";

function createBodyState(): BodyState {
  return {
    words: [],
    kind: "none",
    parenDepth: 0,
    bodyDepth: 0,
    ended: false,
    noBody: false,
    headerScanned: false,
    inBracket: false,
    prev: null,
    after: "expect",
  };
}

/**
 * Tokens after which a value or a name is expected: an `end` there is a name (a
 * column or an alias), never the closer of a body or of a `case`, which only
 * ever follows a value. `~`, `-` and `+` are here as unary operators; every
 * binary operator and every word that needs an operand or a name after it is
 * here too.
 */
const VALUE_EXPECTED_AFTER = new Set([
  ".",
  ",",
  "(",
  "=",
  "==",
  "<>",
  "!=",
  "<",
  ">",
  "<=",
  ">=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "||",
  "->",
  "->>",
  "~",
  "set",
  "select",
  "where",
  "on",
  "by",
  "and",
  "or",
  "not",
  "case",
  "when",
  "then",
  "else",
  "as",
  "having",
  "limit",
  "offset",
  "between",
  "returning",
  "is",
  "like",
  "glob",
  "regexp",
  "match",
  "escape",
  "distinct",
  "all",
  "from",
  "join",
  "into",
  "update",
  "in",
]);

/**
 * The words of `VALUE_EXPECTED_AFTER` that SQLite also accepts as names
 * (`create table x(match)` is prepared). Each is an operator or a keyword only
 * where an operator or a keyword can stand, after a value; where a value is
 * expected it is itself a name, and an `end` after it closes.
 */
const MAY_BE_NAME = new Set(["like", "glob", "regexp", "match", "offset", "by"]);

/** What the token `token` (lower-cased) leaves behind it when the one before it left `before`. */
function afterToken(token: string, before: After): After {
  const afterValue = before === "value";
  if (token === "not") return afterValue ? "notAfterValue" : "expect";
  if (MAY_BE_NAME.has(token)) return before === "expect" ? "value" : "expect";
  return VALUE_EXPECTED_AFTER.has(token) ? "expect" : "value";
}

/** Tokens that never follow the closer of a body: an `end` before them is a name. */
const NAME_BEFORE = new Set(["=", ",", ".", ")"]);

function classifyHeaderKind(words: string[]): BodyKind {
  if (words[0] !== "create") return "none";
  if (words[1] === "trigger") return "trigger";
  if ((words[1] === "temp" || words[1] === "temporary") && words[2] === "trigger") {
    return "trigger";
  }
  if (words[1] === "function" || words[1] === "procedure") return "routine";
  if (
    words[1] === "or" &&
    words[2] === "replace" &&
    (words[3] === "function" || words[3] === "procedure")
  ) {
    return "routine";
  }
  return "none";
}

function nextSignificantText(text: string, tokens: Token[], fromIdx: number): string | null {
  for (let j = fromIdx; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.kind === "whitespace" || t.kind === "comment") continue;
    return text.slice(t.start, t.end).toLowerCase();
  }
  return null;
}

/**
 * Whether the `create trigger` header that has reached `begin` at `fromIdx` is
 * a Postgres one: up to its first top-level `;` it says `execute function` or
 * `execute procedure`, so it has no body and `begin` is a name.
 */
function executesRoutine(text: string, tokens: Token[], fromIdx: number): boolean {
  let depth = 0;
  for (let j = fromIdx; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.kind === "punctuation") {
      const ch = text.slice(t.start, t.end);
      if (ch === "(") depth++;
      else if (ch === ")" && depth > 0) depth--;
      else if (ch === ";" && depth === 0) return false;
      continue;
    }
    if (isWordToken(t) && text.slice(t.start, t.end).toLowerCase() === "execute") {
      const next = nextWordText(text, tokens, j + 1);
      if (next === "function" || next === "procedure") return true;
    }
  }
  return false;
}

/**
 * `executesRoutine` for the trigger header of `state`, scanned at most once: a
 * header already scanned without finding `execute function` has none from here.
 */
function headerExecutesRoutine(
  state: BodyState,
  text: string,
  tokens: Token[],
  fromIdx: number,
): boolean {
  if (state.headerScanned) return false;
  state.headerScanned = true;
  return executesRoutine(text, tokens, fromIdx);
}

function nextWordText(text: string, tokens: Token[], fromIdx: number): string | null {
  for (let j = fromIdx; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.kind === "whitespace" || t.kind === "comment") continue;
    return isWordToken(t) ? text.slice(t.start, t.end).toLowerCase() : null;
  }
  return null;
}

function stepBodyState(
  state: BodyState,
  text: string,
  tokens: Token[],
  index: number,
): void {
  const token = tokens[index]!;
  if (token.kind === "whitespace" || token.kind === "comment") return;
  const prev = state.prev;
  const prevAfter = state.after;
  const tokenText = text.slice(token.start, token.end);
  state.prev = tokenText.toLowerCase();
  state.after = afterToken(state.prev, prevAfter);

  if (token.kind === "punctuation") {
    if (state.inBracket) {
      if (tokenText === "]" || tokenText === ";") state.inBracket = false;
      return;
    }
    if (tokenText === "[") state.inBracket = true;
    else if (tokenText === "(") state.parenDepth++;
    else if (tokenText === ")" && state.parenDepth > 0) state.parenDepth--;
    return;
  }
  if (state.inBracket || !isWordToken(token)) return;

  const word = state.prev;
  if (state.words.length < 4) {
    state.words.push(word);
    state.kind = classifyHeaderKind(state.words);
  }

  if (state.bodyDepth > 0) {
    if (word === "case") {
      if (prev !== ".") state.bodyDepth++;
    } else if (word === "end" && !isNameEnd(state, prevAfter, text, tokens, index)) {
      state.bodyDepth--;
      if (state.bodyDepth === 0) {
        state.ended = true;
      }
    }
    return;
  }

  if (
    word === "execute" &&
    !state.noBody &&
    state.kind === "trigger" &&
    state.parenDepth === 0 &&
    headerExecutesRoutine(state, text, tokens, index)
  ) {
    state.noBody = true;
    return;
  }

  if (state.ended || state.noBody || word !== "begin") return;

  if (state.kind === "trigger" && state.parenDepth === 0) {
    if (headerExecutesRoutine(state, text, tokens, index + 1)) {
      state.noBody = true;
    } else {
      state.bodyDepth = 1;
    }
  } else if (state.kind === "routine" && nextWordText(text, tokens, index + 1) === "atomic") {
    state.bodyDepth = 1;
  }
}

/**
 * Inside a body, whether the word `end` at `index` is a name (SQLite accepts
 * `end` as a column name) rather than the closer of the body or of a `case`.
 */
function isNameEnd(
  state: BodyState,
  prevAfter: After,
  text: string,
  tokens: Token[],
  index: number,
): boolean {
  if (prevAfter !== "value") return true;
  const next = nextSignificantText(text, tokens, index + 1);
  if (next === ".") return true;
  // With no `case` open only the body could close here, and its closer is
  // never followed by these; a `case` closer can be (`case … end = 1`).
  return state.bodyDepth === 1 && next !== null && NAME_BEFORE.has(next);
}

export function splitStatements(text: string): Statement[] {
  const tokens = tokenize(text);
  const statements: Statement[] = [];
  let segment: Token[] = [];
  let bodyState = createBodyState();

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (
      bodyState.bodyDepth === 0 &&
      token.kind === "punctuation" &&
      text.slice(token.start, token.end) === ";"
    ) {
      const stmt = buildStatement(text, segment);
      if (stmt !== null) {
        statements.push(stmt);
      }
      segment = [];
      bodyState = createBodyState();
    } else {
      segment.push(token);
      stepBodyState(bodyState, text, tokens, i);
    }
  }

  const tail = buildStatement(text, segment);
  if (tail !== null) {
    statements.push(tail);
  }

  return statements;
}

export function statementAt(text: string, offset: number): Statement | null {
  const statements = splitStatements(text);
  if (statements.length === 0) return null;
  if (offset < statements[0]!.start) return statements[0]!;

  let found = statements[0]!;
  for (const stmt of statements) {
    if (stmt.start <= offset) {
      found = stmt;
    } else {
      break;
    }
  }
  return found;
}
