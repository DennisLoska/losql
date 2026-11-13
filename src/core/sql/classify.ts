import { type Token, tokenize } from "./lexer";
import { splitStatements } from "./statements";

export type StatementClass = "read" | "write" | "ddl" | "transaction" | "other";

const EXPLAIN_PREFIX_WORDS = new Set([
  "analyze",
  "analyse",
  "verbose",
  "query",
  "plan",
]);

const INSPECTING_PRAGMAS = new Set([
  "table_info",
  "table_xinfo",
  "table_list",
  "index_list",
  "index_info",
  "index_xinfo",
  "foreign_key_list",
  "foreign_key_check",
  "integrity_check",
  "quick_check",
  "function_list",
  "module_list",
  "pragma_list",
  "collation_list",
  "database_list",
  "compile_options",
]);

const ACTING_PRAGMAS = new Set([
  "wal_checkpoint",
  "optimize",
  "incremental_vacuum",
  "shrink_memory",
]);

const TRANSACTION_FIRST = new Set([
  "begin",
  "start",
  "commit",
  "rollback",
  "savepoint",
  "release",
  "end",
  "abort",
]);

const DDL_FIRST = new Set([
  "create",
  "alter",
  "drop",
  "comment",
  "grant",
  "revoke",
]);

const WRITE_FIRST = new Set([
  "insert",
  "update",
  "delete",
  "merge",
  "replace",
  "truncate",
  "copy",
  "call",
  "do",
]);

const READ_FIRST = new Set([
  "select",
  "with",
  "values",
  "table",
  "show",
  "describe",
  "desc",
]);

const WRITE_KEYWORDS_IN_READ = new Set(["insert", "update", "delete", "merge", "into"]);

/**
 * Functions that act outside the transaction that calls them (or that a
 * read-only transaction does not stop): a Statement calling one is at least a
 * `write`, whatever its first word. The list is a floor, not a promise: a
 * function of the user's own, or one not listed here, can have effects this
 * check cannot see. `set_config` and the advisory-lock functions are not in it:
 * their effects end with the session, and the Postgres Driver resets session
 * settings and releases advisory locks after every read-only Run.
 */
const ACTING_FUNCTIONS = new Set([
  "setval",
  "nextval",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_switch_wal",
  "pg_create_restore_point",
  "pg_promote",
  "pg_notify",
  "pg_logical_emit_message",
  "pg_stat_reset",
  "pg_stat_reset_shared",
  "pg_stat_statements_reset",
  "lo_import",
  "lo_export",
  "lo_unlink",
  "lo_create",
  "lowrite",
  "lo_put",
  "dblink_exec",
  "dblink_connect",
  "dblink",
  "pg_read_file",
  "pg_read_binary_file",
  "pg_ls_dir",
  "pg_file_write",
  "pg_stat_reset_slru",
  "pg_stat_reset_single_table_counters",
  "pg_stat_reset_single_function_counters",
  "pg_stat_reset_replication_slot",
  "pg_stat_reset_subscription_stats",
  "pg_log_backend_memory_contexts",
  // Replication slots and origins, backups, WAL replay and statistics of the
  // server as a whole.
  "pg_create_physical_replication_slot",
  "pg_create_logical_replication_slot",
  "pg_drop_replication_slot",
  "pg_replication_slot_advance",
  "pg_copy_physical_replication_slot",
  "pg_copy_logical_replication_slot",
  "pg_sync_replication_slots",
  "pg_replication_origin_create",
  "pg_replication_origin_drop",
  "pg_replication_origin_advance",
  "pg_replication_origin_session_setup",
  "pg_replication_origin_session_reset",
  "pg_replication_origin_xact_setup",
  "pg_backup_start",
  "pg_backup_stop",
  // Their names up to Postgres 14.
  "pg_start_backup",
  "pg_stop_backup",
  "pg_log_standby_snapshot",
  "pg_wal_replay_pause",
  "pg_wal_replay_resume",
  "pg_stat_reset_backend_stats",
  // They consume the changes of a replication slot.
  "pg_logical_slot_get_changes",
  "pg_logical_slot_get_binary_changes",
  // Functions that run SQL given to them as text.
  "query_to_xml",
  "query_to_xmlschema",
  "query_to_xml_and_xmlschema",
  "ts_stat",
  "ts_rewrite",
  "crosstab",
  "connectby",
  "xpath_table",
  // SQLite
  "load_extension",
]);

function isWordToken(t: Token): boolean {
  return (
    t.kind === "keyword" ||
    t.kind === "identifier" ||
    t.kind === "function" ||
    t.kind === "type"
  );
}

function isOpenParen(statement: string, tok: Token | undefined): boolean {
  return tok !== undefined && tok.kind === "punctuation" && statement.slice(tok.start, tok.end) === "(";
}

/**
 * Whether the double-quoted identifier at `j` is written with Unicode escapes
 * (`U&"…"`, the `U`, the `&` and the quote with nothing between them).
 */
function isUnicodeQuoted(statement: string, tokens: Token[], j: number): boolean {
  const tok = tokens[j]!;
  if (tok.kind !== "quotedIdentifier" || statement[tok.start] !== '"' || j < 2) return false;
  const amp = tokens[j - 1]!;
  const u = tokens[j - 2]!;
  return (
    amp.kind === "operator" &&
    amp.end === tok.start &&
    statement.slice(amp.start, amp.end) === "&" &&
    isWordToken(u) &&
    u.end === amp.start &&
    statement.slice(u.start, u.end).toLowerCase() === "u"
  );
}

/**
 * Whether the Statement calls one of ACTING_FUNCTIONS: its name (with or
 * without a schema before it) followed by an opening parenthesis. Strings and
 * comments are separate tokens, so a name inside one does not count. A quoted
 * name counts only as the exact call it is (`"setval"(…)`, not `"setval"` alone
 * or `"setval(1)"`). A name written with Unicode escapes (`U&"…"`, with or
 * without its `UESCAPE '…'`) and called counts whatever it spells: nobody
 * writes a function name that way for a good reason.
 */
function callsActingFunction(statement: string, tokens: Token[]): boolean {
  for (let j = 0; j < tokens.length; j++) {
    if (isUnicodeQuoted(statement, tokens, j)) {
      let k = j + 1;
      const after = tokens[k];
      if (
        after !== undefined &&
        isWordToken(after) &&
        statement.slice(after.start, after.end).toLowerCase() === "uescape" &&
        tokens[k + 1]?.kind === "string"
      ) {
        k += 2;
      }
      if (isOpenParen(statement, tokens[k])) return true;
      continue;
    }
    if (!isOpenParen(statement, tokens[j + 1])) continue;
    const tok = tokens[j]!;
    let name: string;
    if (isWordToken(tok)) {
      name = statement.slice(tok.start, tok.end).toLowerCase();
    } else if (tok.kind === "quotedIdentifier" && statement[tok.start] === '"') {
      name = statement.slice(tok.start + 1, tok.end - 1);
    } else {
      continue;
    }
    if (ACTING_FUNCTIONS.has(name)) return true;
  }
  return false;
}

function significantTokens(statement: string): Token[] {
  return tokenize(statement).filter((t) => t.kind !== "whitespace" && t.kind !== "comment");
}

function classifyTokens(
  statement: string,
  tokens: Token[],
  start: number,
  end: number,
): StatementClass {
  let i = start;

  while (i < end) {
    const tok0 = tokens[i]!;
    if (statement.slice(tok0.start, tok0.end).toLowerCase() !== "explain") {
      break;
    }
    let hasAnalyze = false;
    i++;
    const second = i < end ? tokens[i] : undefined;
    if (second && second.kind === "punctuation" && statement.slice(second.start, second.end) === "(") {
      let depth = 1;
      i++;
      while (i < end && depth > 0) {
        const tok = tokens[i]!;
        const text = statement.slice(tok.start, tok.end).toLowerCase();
        if (tok.kind === "punctuation") {
          if (text === "(") depth++;
          else if (text === ")") depth--;
        } else if (isWordToken(tok) && (text === "analyze" || text === "analyse")) {
          hasAnalyze = true;
        }
        i++;
      }
    } else {
      while (i < end) {
        const tok = tokens[i]!;
        if (!isWordToken(tok)) break;
        const text = statement.slice(tok.start, tok.end).toLowerCase();
        if (!EXPLAIN_PREFIX_WORDS.has(text)) break;
        if (text === "analyze" || text === "analyse") {
          hasAnalyze = true;
        }
        i++;
      }
    }
    if (!hasAnalyze) return "read";
  }

  if (i >= end) return "other";

  const firstToken = tokens[i]!;
  const first = statement.slice(firstToken.start, firstToken.end).toLowerCase();

  if (first === "pragma") {
    for (let j = i + 1; j < end; j++) {
      const t = tokens[j]!;
      if (t.kind === "operator") {
        const op = statement.slice(t.start, t.end);
        if (op === "=" || op === "==") return "write";
      }
    }

    let openParenIdx = -1;
    for (let j = i + 1; j < end; j++) {
      const t = tokens[j]!;
      if (t.kind === "punctuation" && statement.slice(t.start, t.end) === "(") {
        openParenIdx = j;
        break;
      }
    }
    const nameEndIdx = openParenIdx !== -1 ? openParenIdx : end;
    let name = "";
    for (let j = nameEndIdx - 1; j >= i + 1; j--) {
      const tok = tokens[j]!;
      if (isWordToken(tok)) {
        name = statement.slice(tok.start, tok.end).toLowerCase();
        break;
      }
    }
    if (ACTING_PRAGMAS.has(name)) {
      return "write";
    }
    if (openParenIdx !== -1 && !INSPECTING_PRAGMAS.has(name)) {
      return "write";
    }
    return "read";
  }

  if (TRANSACTION_FIRST.has(first)) return "transaction";
  if (DDL_FIRST.has(first)) return "ddl";
  if (WRITE_FIRST.has(first)) return "write";

  if (READ_FIRST.has(first)) {
    for (let j = i; j < end; j++) {
      const t = tokens[j]!;
      if (t.kind === "keyword") {
        const w = statement.slice(t.start, t.end).toLowerCase();
        if (WRITE_KEYWORDS_IN_READ.has(w)) {
          return "write";
        }
      }
    }
    return "read";
  }

  return "other";
}

const SEVERITY: Record<StatementClass, number> = {
  read: 0,
  transaction: 1,
  other: 2,
  ddl: 3,
  write: 4,
};

/**
 * Classifies SQL text into a StatementClass.
 * When the text contains more than one Statement, it is classified by its most severe Statement (`write` > `ddl` > `other` > `transaction` > `read`).
 */
export function classify(statement: string): StatementClass {
  const statements = splitStatements(statement);
  let result: StatementClass | null = null;

  for (const stmt of statements) {
    const tokens = significantTokens(stmt.text);
    if (tokens.length > 0) {
      let cls = classifyTokens(stmt.text, tokens, 0, tokens.length);
      // A call of an acting function makes the Statement a write at least. A
      // `ddl` stays `ddl`: it is no read either, and the schema is refreshed
      // after a `ddl`.
      if (cls !== "write" && cls !== "ddl" && callsActingFunction(stmt.text, tokens)) {
        cls = "write";
      }
      if (result === null || SEVERITY[cls] > SEVERITY[result]) {
        result = cls;
      }
    }
  }

  return result ?? "other";
}

export function commandTag(statement: string): string {
  const tokens = significantTokens(statement);
  if (tokens.length === 0) return "";
  const first = tokens[0]!;
  if (isWordToken(first)) {
    return statement.slice(first.start, first.end).toUpperCase();
  }
  return "";
}
