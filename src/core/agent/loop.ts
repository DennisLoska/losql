import type { Config } from "../config";
import { redactConnectionText } from "../db/redact";
import type { Cell, Driver, Result, SchemaSnapshot } from "../db/types";
import { splitStatements } from "../sql/statements";
import { describeRelations, schemaDigest } from "./digest";
import {
  AGENT_QUERY_TIMEOUT_MS,
  MAX_AGENT_CELL,
  MAX_AGENT_COLUMNS,
  MAX_AGENT_ERROR,
  MAX_AGENT_ROWS,
  MAX_AGENT_SQL_CHARS,
  SYSTEM_PROMPT,
  buildPrompt,
} from "./prompt";
import { type AgentAction, parseAction } from "./protocol";
import { ProviderError, type ProviderErrorKind } from "./run";

export type Intent = "ask" | "explain" | "fix" | "optimize";

export interface StepRecord {
  action: AgentAction;
  result: string;
}

export interface Turn {
  intent: Intent;
  text: string;
  steps: StepRecord[];
  answer: { message: string; sql?: string } | null;
}

export interface WorkspaceContext {
  activeBuffer?: {
    name: string;
    sql: string;
    cursorStatement?: string;
    selection?: string;
  };
  otherBuffers?: string[];
  lastResult?: {
    statement: string;
    columns: string[];
    rowCount: number;
    truncated: boolean;
  };
  lastError?: {
    statement: string;
    error: string;
  };
}

export interface TurnRequest {
  intent: Intent;
  text: string;
  statement?: string;
  error?: string;
  plan?: string;
  workspace?: WorkspaceContext;
  conversation: Turn[];
}

export type AgentEvent =
  | { type: "thinking" }
  | { type: "text"; text: string }
  | { type: "step"; step: StepRecord }
  | { type: "answer"; message: string; sql?: string }
  | { type: "error"; kind: ProviderErrorKind | "protocol"; message: string };

export type TurnOutcome =
  | { ok: true; message: string; sql?: string; steps: StepRecord[] }
  | { ok: false; kind: ProviderErrorKind | "protocol"; message: string; steps: StepRecord[] };

export type ShownResultsSnapshot =
  | { ok: true; statement: string; result: Result }
  | { ok: false; statement: string; error: string }
  | null;

export interface AgentDeps {
  ask: (prompt: string, system: string, onText?: (text: string) => void) => Promise<string>;
  driver: Pick<Driver, "run" | "schema" | "connection">;
  config: Config["agent"];
  signal?: AbortSignal;
  readBuffer?: (
    name?: string,
  ) => { buffers: { name: string; active: boolean; sql?: string }[]; error?: string };
  readResults?: () => ShownResultsSnapshot;
}

const MAX_COLUMN_NAME_CHARS = 64;
const MAX_BUFFER_NAME_CHARS = 128;
const MAX_BUFFER_LIST = 20;

/**
 * Turns every line break a reader could see but the database does not (CRLF, a lone CR,
 * U+2028 and U+2029) into one line feed. The SQL of a reply goes through this once, where it is
 * taken from the Provider, so what is shown, inserted and run is the same text.
 */
export function normalizeLineBreaks(sql: string): string {
  return sql.replace(/\r\n|\r|\u2028|\u2029/g, "\n");
}

function cutAtCodePoint(text: string, maxChars: number): string {
  if (text.length > maxChars) {
    let end = maxChars;
    const prev = text.charCodeAt(end - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) {
      end--;
    }
    return `${text.slice(0, end)}…`;
  }
  return text;
}

function truncateColumnName(name: string): string {
  return cutAtCodePoint(name, MAX_COLUMN_NAME_CHARS);
}

export function sanitizeAgentError(message: string): string {
  const redacted = redactConnectionText(message).replace(
    /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s@]+@/g,
    "$1***@",
  );
  return cutAtCodePoint(redacted, MAX_AGENT_ERROR);
}

function truncateCell(cell: Cell): null | boolean | number | string {
  if (cell === null || typeof cell === "boolean" || typeof cell === "number") {
    return cell;
  }
  const text = typeof cell === "string" ? cell : JSON.stringify(cell);
  return cutAtCodePoint(text, MAX_AGENT_CELL);
}

function formatBoundedResultPayload(res: Result, statement?: string): string {
  const totalCols = res.columns.length;
  const keptCols = res.columns.slice(0, MAX_AGENT_COLUMNS);
  const columns = keptCols.map((c) => truncateColumnName(c.name));
  const limitedRows = res.rows.slice(0, MAX_AGENT_ROWS);
  const rows = limitedRows.map((row) => row.slice(0, MAX_AGENT_COLUMNS).map(truncateCell));
  const payload: {
    statement?: string;
    columns: string[];
    rows: (null | boolean | number | string)[][];
    truncated: boolean;
    columnsOmitted?: number;
  } = {
    ...(statement !== undefined ? { statement: cutAtCodePoint(statement, MAX_AGENT_SQL_CHARS) } : {}),
    columns,
    rows,
    truncated: res.truncated || res.rows.length > MAX_AGENT_ROWS,
  };
  if (totalCols > MAX_AGENT_COLUMNS) {
    payload.columnsOmitted = totalCols - MAX_AGENT_COLUMNS;
  }
  return JSON.stringify(payload);
}

const SCHEMA_ONLY_ERROR_JSON = JSON.stringify({
  error: 'running queries is turned off (agent.dataAccess is "schema"); answer from the schema',
});

async function executeQueryStep(
  sql: string,
  deps: AgentDeps,
): Promise<string> {
  if (deps.config.dataAccess === "schema") {
    return SCHEMA_ONLY_ERROR_JSON;
  }

  const statements = splitStatements(sql);
  if (statements.length !== 1) {
    return JSON.stringify({ error: "send exactly one statement per query" });
  }

  try {
    const res = await deps.driver.run(statements[0]!.text, {
      readOnly: true,
      maxRows: MAX_AGENT_ROWS,
      timeoutMs: AGENT_QUERY_TIMEOUT_MS,
      signal: deps.signal,
    });
    return formatBoundedResultPayload(res);
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: sanitizeAgentError(rawMessage) });
  }
}

async function executeExplainStep(
  sql: string,
  deps: AgentDeps,
): Promise<string> {
  if (deps.config.dataAccess === "schema") {
    return SCHEMA_ONLY_ERROR_JSON;
  }

  const statements = splitStatements(sql);
  if (statements.length !== 1) {
    return JSON.stringify({ error: "send exactly one statement per explain" });
  }

  // Strip any caller-supplied EXPLAIN prefix (including ANALYZE options) so EXPLAIN never executes writes or ANALYZE.
  const body = statements[0]!.text
    .replace(
      /^\s*explain(?:\s*\([^)]*\)|\s+analyze|\s+verbose|\s+costs|\s+settings|\s+buffers|\s+wal|\s+timing|\s+summary|\s+format\s+\w+|\s+query\s+plan)*\s+/i,
      "",
    )
    .trim();
  if (body.length === 0) {
    return JSON.stringify({ error: "send a SQL statement to explain" });
  }

  const explainSql =
    deps.driver.connection.dialect === "postgres"
      ? `explain ${body}`
      : `explain query plan ${body}`;

  try {
    const res = await deps.driver.run(explainSql, {
      readOnly: true,
      maxRows: MAX_AGENT_ROWS,
      timeoutMs: AGENT_QUERY_TIMEOUT_MS,
      signal: deps.signal,
    });
    return formatBoundedResultPayload(res);
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: sanitizeAgentError(rawMessage) });
  }
}

function executeReadBufferStep(name: string | undefined, deps: AgentDeps): string {
  if (!deps.readBuffer) {
    return JSON.stringify({ error: "editor buffers are not available in this session" });
  }
  const snapshot = deps.readBuffer(name);
  if (snapshot.error !== undefined) {
    return JSON.stringify({
      error: cutAtCodePoint(snapshot.error, MAX_AGENT_ERROR),
      buffers: snapshot.buffers.slice(0, MAX_BUFFER_LIST).map((b) => ({
        name: cutAtCodePoint(b.name, MAX_BUFFER_NAME_CHARS),
        active: b.active,
      })),
    });
  }
  return JSON.stringify({
    buffers: snapshot.buffers.slice(0, MAX_BUFFER_LIST).map((b) => ({
      name: cutAtCodePoint(b.name, MAX_BUFFER_NAME_CHARS),
      active: b.active,
      ...(b.sql !== undefined ? { sql: cutAtCodePoint(b.sql, MAX_AGENT_SQL_CHARS) } : {}),
    })),
  });
}

function executeReadResultsStep(deps: AgentDeps): string {
  if (deps.config.dataAccess === "schema") {
    return SCHEMA_ONLY_ERROR_JSON;
  }
  if (!deps.readResults) {
    return JSON.stringify({ error: "results pane is not available in this session" });
  }
  const shown = deps.readResults();
  if (shown === null) {
    return JSON.stringify({ shown: null });
  }
  if (!shown.ok) {
    return JSON.stringify({
      statement: cutAtCodePoint(shown.statement, MAX_AGENT_SQL_CHARS),
      error: sanitizeAgentError(shown.error),
    });
  }
  return formatBoundedResultPayload(shown.result, shown.statement);
}

export async function runAgent(
  turn: TurnRequest,
  deps: AgentDeps,
  onEvent: (event: AgentEvent) => void,
): Promise<TurnOutcome> {
  const steps: StepRecord[] = [];
  let corrected = false;
  let correction: string | undefined;
  const hasWorkspaceTools = Boolean(deps.readBuffer || deps.readResults);

  const emit = (event: AgentEvent) => {
    try {
      onEvent(event);
    } catch {
      // Listener exceptions are swallowed so they never alter the outcome or propagate into Provider calls
    }
  };

  const fail = (kind: ProviderErrorKind | "protocol", message: string): TurnOutcome => {
    emit({ type: "error", kind, message });
    return { ok: false, kind, message, steps };
  };

  if (deps.signal?.aborted) {
    return fail("cancelled", "the turn was cancelled");
  }

  let schema: SchemaSnapshot;
  try {
    schema = await deps.driver.schema();
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    return fail("other", sanitizeAgentError(rawMessage));
  }
  const digest = schemaDigest(schema);

  while (true) {
    if (deps.signal?.aborted) {
      return fail("cancelled", "the turn was cancelled");
    }

    const forceAnswer = steps.length >= deps.config.maxSteps;
    emit({ type: "thinking" });

    const prompt = buildPrompt({
      connection: deps.driver.connection,
      digest,
      turn,
      steps,
      dataAccess: deps.config.dataAccess,
      forceAnswer,
      correction,
      hasWorkspaceTools,
    });

    let reply: string;
    try {
      reply = await deps.ask(prompt, SYSTEM_PROMPT, (text) => {
        emit({ type: "text", text });
      });
    } catch (err) {
      if (err instanceof ProviderError) {
        return fail(err.kind, err.message);
      }
      const message = err instanceof Error ? err.message : String(err);
      return fail("other", message);
    }

    const parsed = parseAction(reply);
    if (!parsed.ok) {
      if (corrected) {
        return fail("protocol", `the agent sent an invalid reply twice: ${parsed.reason}`);
      }
      corrected = true;
      correction = parsed.reason;
      continue;
    }

    corrected = false;
    correction = undefined;
    const { action } = parsed;
    if (action.action === "query" || action.action === "explain") {
      action.sql = normalizeLineBreaks(action.sql);
    } else if (action.action === "answer" && action.sql !== undefined) {
      action.sql = normalizeLineBreaks(action.sql);
    }

    if (action.action === "answer") {
      const answerEvent: AgentEvent = { type: "answer", message: action.message };
      if (action.sql !== undefined) {
        answerEvent.sql = action.sql;
      }
      emit(answerEvent);

      const outcome: TurnOutcome = { ok: true, message: action.message, steps };
      if (action.sql !== undefined) {
        outcome.sql = action.sql;
      }
      return outcome;
    }

    if (forceAnswer) {
      return fail("protocol", `the agent did not answer within ${deps.config.maxSteps} steps`);
    }

    let result: string;
    if (action.action === "query") {
      result = await executeQueryStep(action.sql, deps);
    } else if (action.action === "explain") {
      result = await executeExplainStep(action.sql, deps);
    } else if (action.action === "read_buffer") {
      result = executeReadBufferStep(action.name, deps);
    } else if (action.action === "read_results") {
      result = executeReadResultsStep(deps);
    } else {
      result = describeRelations(schema, action.relations);
    }

    const step: StepRecord = { action, result };
    steps.push(step);
    emit({ type: "step", step });
  }
}

