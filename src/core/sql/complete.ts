import type { Relation, SchemaSnapshot } from "../db/types";
import { quoteIdentifier } from "./identifier";
import { KEYWORDS, TYPES } from "./keywords";
import { type Token, tokenize } from "./lexer";

export interface CompletionItem {
  /** The raw name or word: what the popup shows and what typing filters by. */
  label: string;
  kind: "column" | "relation" | "keyword" | "word";
  detail?: string;
  /**
   * The text accepting the item writes in place of `from` to the cursor, when
   * it is not the label: a column or Relation name the database reads only in
   * double quotes.
   */
  insert?: string;
}

export interface Completion {
  from: number;
  /**
   * Set when accepting also replaces text after the cursor, up to this offset:
   * the closing double quote of the quoted identifier being completed.
   */
  to?: number;
  items: CompletionItem[];
}

export const MAX_COMPLETIONS = 50;

function isWordChar(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "_"
  );
}

function unquote(raw: string): string {
  if (raw.length >= 2) {
    const q = raw[0]!;
    if ((q === '"' || q === "`") && raw[raw.length - 1] === q) {
      return raw.slice(1, -1).replaceAll(q + q, q);
    }
  }
  return raw;
}

/**
 * The double-quoted identifier the cursor is inside, if any: the offset of its
 * opening quote, the raw name typed between that quote and the cursor, and the
 * offset just past its closing quote when that quote comes later on the
 * cursor's line (see `closingQuoteEndOnLine`), so that accepting replaces the
 * whole quoted name.
 */
function openQuoteAt(
  text: string,
  tokens: Token[],
  offset: number,
): { quote: number; typed: string; closeEnd: number | null } | null {
  for (const tok of tokens) {
    if (tok.start >= offset) break;
    if (tok.kind !== "quotedIdentifier" || text[tok.start] !== '"') continue;
    if (offset > tok.end) continue;
    let i = tok.start + 1;
    let closing = -1;
    while (i < tok.end) {
      if (text[i] === '"') {
        if (i + 1 < tok.end && text[i + 1] === '"') {
          i += 2;
          continue;
        }
        closing = i;
        break;
      }
      i++;
    }
    if (closing !== -1 && offset > closing) return null;
    const typedRaw = text.slice(tok.start + 1, offset);
    if (typedRaw.includes("\n") || typedRaw.includes("\r")) return null;
    return {
      quote: tok.start,
      typed: typedRaw.replaceAll('""', '"'),
      closeEnd: closingQuoteEndOnLine(text, offset),
    };
  }
  return null;
}

/**
 * For a cursor inside an open double quote: the offset just past the quote that
 * closes it later on this line, or null when it is still open. An odd number of
 * double quotes from the cursor to the end of the line means it closes there (a
 * doubled quote counts as two and changes nothing): at the first quote that is
 * not one of a doubled pair. A quote directly after the cursor that is not the
 * first of a doubled pair closes the name there, whatever follows on the line.
 */
function closingQuoteEndOnLine(text: string, offset: number): number | null {
  if (text[offset] === '"' && text[offset + 1] !== '"') return offset + 1;
  let count = 0;
  let closing = -1;
  for (let i = offset; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n" || ch === "\r") break;
    if (ch !== '"') continue;
    count++;
    if (closing !== -1) continue;
    if (text[i + 1] === '"') {
      count++;
      i++;
      continue;
    }
    closing = i;
  }
  return count % 2 === 1 && closing !== -1 ? closing + 1 : null;
}

function inQuotes(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

interface SchemaIndex {
  all: { rel: Relation; lower: string }[];
  byName: Map<string, Relation>;
  byNamespace: Map<string, Map<string, Relation>>;
}

function buildSchemaIndex(schema: SchemaSnapshot | null): SchemaIndex {
  const all: { rel: Relation; lower: string }[] = [];
  const byName = new Map<string, Relation>();
  const byNamespace = new Map<string, Map<string, Relation>>();
  if (!schema) {
    return { all, byName, byNamespace };
  }
  for (const ns of schema.namespaces) {
    const nsLower = ns.name.toLowerCase();
    let nsMap = byNamespace.get(nsLower);
    if (!nsMap) {
      nsMap = new Map<string, Relation>();
      byNamespace.set(nsLower, nsMap);
    }
    for (const rel of ns.relations) {
      const lower = rel.name.toLowerCase();
      all.push({ rel, lower });
      if (!byName.has(lower)) {
        byName.set(lower, rel);
      }
      if (!nsMap.has(lower)) {
        nsMap.set(lower, rel);
      }
    }
  }
  return { all, byName, byNamespace };
}

function statementTokensAt(text: string, tokens: Token[], offset: number): Token[] {
  const statements: { start: number; tokens: Token[] }[] = [];
  let current: Token[] = [];

  for (const tok of tokens) {
    if (tok.kind === "punctuation" && text.slice(tok.start, tok.end) === ";") {
      if (current.length > 0) {
        statements.push({ start: current[0]!.start, tokens: current });
        current = [];
      }
    } else if (tok.kind !== "whitespace" && tok.kind !== "comment") {
      current.push(tok);
    }
  }
  if (current.length > 0) {
    statements.push({ start: current[0]!.start, tokens: current });
  }

  if (statements.length === 0) return [];
  let found = statements[0]!;
  for (const stmt of statements) {
    if (stmt.start <= offset) {
      found = stmt;
    } else {
      break;
    }
  }
  return found.tokens;
}

interface StatementContext {
  referencedRelations: Relation[];
  aliases: Map<string, Relation | null>;
}

function isIdentToken(tok: Token): boolean {
  return tok.kind === "identifier" || tok.kind === "quotedIdentifier";
}

function analyzeStatement(
  text: string,
  tokens: Token[],
  schemaIndex: SchemaIndex,
): StatementContext {
  const referencedRelations: Relation[] = [];
  const seenRelations = new Set<Relation>();
  const aliases = new Map<string, Relation | null>();

  if (schemaIndex.all.length === 0) {
    return { referencedRelations, aliases };
  }

  const wordOf = (tok: Token): string => text.slice(tok.start, tok.end);

  const parseRelationRef = (startIdx: number): { nextIdx: number; matched: boolean } => {
    if (startIdx >= tokens.length) return { nextIdx: startIdx, matched: false };
    const firstTok = tokens[startIdx]!;

    let rel: Relation | undefined;
    let afterRelIdx: number;

    if (firstTok.kind === "punctuation" && wordOf(firstTok) === "(") {
      let depth = 1;
      let j = startIdx + 1;
      while (j < tokens.length && depth > 0) {
        const t = tokens[j]!;
        if (t.kind === "punctuation") {
          const ch = wordOf(t);
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
        }
        j++;
      }
      afterRelIdx = j;
    } else if (isIdentToken(firstTok)) {
      if (
        startIdx + 2 < tokens.length &&
        tokens[startIdx + 1]!.kind === "punctuation" &&
        wordOf(tokens[startIdx + 1]!) === "." &&
        isIdentToken(tokens[startIdx + 2]!)
      ) {
        const nsName = unquote(wordOf(firstTok)).toLowerCase();
        const relName = unquote(wordOf(tokens[startIdx + 2]!)).toLowerCase();
        rel = schemaIndex.byNamespace.get(nsName)?.get(relName);
        afterRelIdx = startIdx + 3;
      } else {
        const relName = unquote(wordOf(firstTok)).toLowerCase();
        rel = schemaIndex.byName.get(relName);
        afterRelIdx = startIdx + 1;
      }
    } else {
      return { nextIdx: startIdx, matched: false };
    }

    if (rel && !seenRelations.has(rel)) {
      seenRelations.add(rel);
      referencedRelations.push(rel);
    }

    if (afterRelIdx < tokens.length) {
      const nextTok = tokens[afterRelIdx]!;
      const nextWord = wordOf(nextTok).toLowerCase();
      if (nextTok.kind === "keyword" && nextWord === "as") {
        if (afterRelIdx + 1 < tokens.length && isIdentToken(tokens[afterRelIdx + 1]!)) {
          const aliasTok = tokens[afterRelIdx + 1]!;
          const aliasName = unquote(wordOf(aliasTok)).toLowerCase();
          aliases.set(aliasName, rel ?? null);
          afterRelIdx += 2;
        }
      } else if (isIdentToken(nextTok)) {
        const aliasName = unquote(wordOf(nextTok)).toLowerCase();
        aliases.set(aliasName, rel ?? null);
        afterRelIdx += 1;
      }
    }

    return { nextIdx: afterRelIdx, matched: true };
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.kind !== "keyword") continue;
    const kw = wordOf(tok).toLowerCase();

    if (kw === "from") {
      let cursor = i + 1;
      while (cursor < tokens.length) {
        const { nextIdx, matched } = parseRelationRef(cursor);
        if (!matched) break;
        cursor = nextIdx;
        if (
          cursor < tokens.length &&
          tokens[cursor]!.kind === "punctuation" &&
          wordOf(tokens[cursor]!) === ","
        ) {
          cursor++;
        } else {
          break;
        }
      }
    } else if (kw === "join" || kw === "update") {
      parseRelationRef(i + 1);
    } else if (
      kw === "insert" &&
      i + 1 < tokens.length &&
      tokens[i + 1]!.kind === "keyword" &&
      wordOf(tokens[i + 1]!).toLowerCase() === "into"
    ) {
      parseRelationRef(i + 2);
    }
  }

  return { referencedRelations, aliases };
}

export function complete(
  source: string,
  offset: number,
  schema: SchemaSnapshot | null,
): Completion {
  let text = source;
  let tokens = tokenize(text);
  const quoted = openQuoteAt(text, tokens, offset);
  if (quoted && quoted.closeEnd === null) {
    // A quote still being typed runs on into the rest of the Statement; that
    // rest is read as if the quote were closed at the cursor, so that its
    // Relations and aliases are known.
    text = `${source.slice(0, offset)}"${source.slice(offset)}`;
    tokens = tokenize(text);
  }
  if (!quoted) {
    for (const tok of tokens) {
      if (
        (tok.kind === "string" ||
          tok.kind === "comment" ||
          tok.kind === "quotedIdentifier") &&
        tok.start < offset &&
        offset <= tok.end
      ) {
        return { from: offset, items: [] };
      }
    }
  }

  let from = offset;
  let prefix: string;
  if (quoted) {
    from = quoted.quote;
    prefix = quoted.typed;
  } else {
    while (from > 0 && isWordChar(text[from - 1]!)) {
      from--;
    }
    prefix = text.slice(from, offset);
  }
  const prefixLower = prefix.toLowerCase();
  // Inside a double-quoted identifier every name is written in one pair of
  // quotes; elsewhere only a name the database would not read as itself is.
  const nameItem = (
    name: string,
    kind: "column" | "relation",
    detail: string,
  ): CompletionItem => {
    const insert = quoted ? inQuotes(name) : quoteIdentifier(name);
    return insert === name ? { label: name, kind, detail } : { label: name, insert, kind, detail };
  };
  const done = (items: CompletionItem[]): Completion =>
    quoted?.closeEnd != null && items.length > 0
      ? { from, to: quoted.closeEnd, items }
      : { from, items };

  // Check if preceded by a dot
  if (from > 0 && text[from - 1] === ".") {
    if (!schema) {
      return { from, items: [] };
    }
    const dotIdx = from - 1;
    const stmtTokens = statementTokensAt(text, tokens, offset);
    let qualifier = "";
    let qualStart = dotIdx;
    const tokBeforeDotIdx = stmtTokens.findIndex((t) => t.end === dotIdx);
    const tokBeforeDot = tokBeforeDotIdx !== -1 ? stmtTokens[tokBeforeDotIdx] : undefined;
    if (tokBeforeDot && tokBeforeDot.kind === "quotedIdentifier") {
      qualifier = unquote(text.slice(tokBeforeDot.start, tokBeforeDot.end));
      qualStart = tokBeforeDot.start;
    } else {
      let qStart = dotIdx;
      while (qStart > 0 && isWordChar(text[qStart - 1]!)) {
        qStart--;
      }
      qualifier = text.slice(qStart, dotIdx);
      qualStart = qStart;
    }
    if (qualifier.length === 0) {
      return { from, items: [] };
    }

    let nsQualifier = "";
    if (qualStart > 0 && text[qualStart - 1] === ".") {
      const nsDotIdx = qualStart - 1;
      const tokBeforeNsDot = stmtTokens.find((t) => t.end === nsDotIdx);
      if (tokBeforeNsDot && tokBeforeNsDot.kind === "quotedIdentifier") {
        nsQualifier = unquote(text.slice(tokBeforeNsDot.start, tokBeforeNsDot.end));
      } else {
        let nsStart = nsDotIdx;
        while (nsStart > 0 && isWordChar(text[nsStart - 1]!)) {
          nsStart--;
        }
        nsQualifier = text.slice(nsStart, nsDotIdx);
      }
    }

    const schemaIndex = buildSchemaIndex(schema);
    const { aliases } = analyzeStatement(text, stmtTokens, schemaIndex);
    const qualLower = qualifier.toLowerCase();
    let rel: Relation | null | undefined;
    if (nsQualifier.length > 0) {
      rel = schemaIndex.byNamespace.get(nsQualifier.toLowerCase())?.get(qualLower);
    } else if (aliases.has(qualLower)) {
      rel = aliases.get(qualLower);
    } else {
      rel = schemaIndex.byName.get(qualLower);
    }
    if (!rel) {
      if (rel === undefined && nsQualifier.length === 0) {
        // A qualifier that is neither an alias nor a Relation may name a
        // namespace: offer its Relations.
        const nsItems: CompletionItem[] = [];
        for (const ns of schema.namespaces) {
          if (ns.name.toLowerCase() !== qualLower) continue;
          for (const r of ns.relations) {
            if (r.name.toLowerCase().startsWith(prefixLower)) {
              nsItems.push(nameItem(r.name, "relation", r.kind));
            }
          }
        }
        return done(nsItems);
      }
      return { from, items: [] };
    }

    const items: CompletionItem[] = [];
    for (const col of rel.columns) {
      if (col.name.toLowerCase().startsWith(prefixLower)) {
        items.push(nameItem(col.name, "column", col.type));
      }
    }
    return done(items);
  }

  if (prefix.length === 0) {
    return { from, items: [] };
  }

  const schemaIndex = buildSchemaIndex(schema);
  const stmtTokens = statementTokensAt(text, tokens, offset);
  const { referencedRelations } = analyzeStatement(text, stmtTokens, schemaIndex);

  const items: CompletionItem[] = [];
  const seen = new Set<string>();

  const pushGroup = (group: CompletionItem[]) => {
    group.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    for (const item of group) {
      if (items.length >= MAX_COMPLETIONS) return;
      const key = item.label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      // The text to insert is worked out only for the items offered.
      items.push(
        item.kind === "column" || item.kind === "relation"
          ? nameItem(item.label, item.kind, item.detail ?? "")
          : item,
      );
    }
  };

  // 1. Columns of the Relations referenced in the current Statement
  const refColumnItems: CompletionItem[] = [];
  for (const rel of referencedRelations) {
    for (const col of rel.columns) {
      if (col.name.toLowerCase().startsWith(prefixLower)) {
        refColumnItems.push({ label: col.name, kind: "column", detail: rel.name });
      }
    }
  }
  pushGroup(refColumnItems);

  // 2. Relations
  const relationItems: CompletionItem[] = [];
  for (const { rel, lower } of schemaIndex.all) {
    if (lower.startsWith(prefixLower)) {
      relationItems.push({ label: rel.name, kind: "relation", detail: rel.kind });
    }
  }
  pushGroup(relationItems);

  // Inside a quoted identifier only names are offered: a keyword or a word
  // written in quotes would be read as a name.
  if (quoted) {
    return done(items);
  }

  // 3. Keywords from KEYWORDS and TYPES
  const isUpperPrefix =
    prefix === prefix.toUpperCase() && prefix !== prefix.toLowerCase();
  const keywordItems: CompletionItem[] = [];
  for (const kw of KEYWORDS) {
    if (kw.startsWith(prefixLower)) {
      keywordItems.push({
        label: isUpperPrefix ? kw.toUpperCase() : kw,
        kind: "keyword",
      });
    }
  }
  for (const ty of TYPES) {
    if (ty.startsWith(prefixLower)) {
      keywordItems.push({
        label: isUpperPrefix ? ty.toUpperCase() : ty,
        kind: "keyword",
      });
    }
  }
  pushGroup(keywordItems);

  // 4. Other words in the text of at least three characters
  let currentWordEnd = offset;
  while (currentWordEnd < text.length && isWordChar(text[currentWordEnd]!)) {
    currentWordEnd++;
  }

  const wordSet = new Set<string>();
  const wordRegex = /[A-Za-z0-9_]+/g;
  let match: RegExpExecArray | null;
  while ((match = wordRegex.exec(text)) !== null) {
    const word = match[0];
    const start = match.index;
    const end = start + word.length;
    if (start === from && end === currentWordEnd) {
      continue;
    }
    if (word.length < 3) continue;
    if (!wordSet.has(word) && word.toLowerCase().startsWith(prefixLower)) {
      wordSet.add(word);
    }
  }
  const wordItems: CompletionItem[] = Array.from(wordSet, (word) => ({
    label: word,
    kind: "word",
  }));
  pushGroup(wordItems);

  return { from, items };
}

