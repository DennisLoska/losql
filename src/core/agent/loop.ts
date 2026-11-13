import type { Config } from "../config";
import { redactConnectionText } from "../db/redact";
import type { Cell, Driver, SchemaSnapshot } from "../db/types";
import { splitStatements } from "../sql/statements";
import { describeRelations, schemaDigest } from "./digest";
import {
  AGENT_QUERY_TIMEOUT_MS,
  MAX_AGENT_CELL,
  MAX_AGENT_COLUMNS,
  MAX_AGENT_ERROR,
  MAX_AGENT_ROWS,
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

export interface TurnRequest {
  intent: Intent;
  text: string;
  statement?: string;
  error?: string;
  plan?: string;
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

export interface AgentDeps {
  ask: (prompt: string, system: string, onText?: (text: string) => void) => Promise<string>;
  driver: Pick<Driver, "run" | "schema" | "connection">;
  config: Config["agent"];
  signal?: AbortSignal;
}

const MAX_COLUMN_NAME_CHARS = 64;

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

async function executeQueryStep(
  sql: string,
  deps: AgentDeps,
): Promise<string> {
  if (deps.config.dataAccess === "schema") {
    return JSON.stringify({
      error: 'running queries is turned off (agent.dataAccess is "schema"); answer from the schema',
    });
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
    const totalCols = res.columns.length;
    const keptCols = res.columns.slice(0, MAX_AGENT_COLUMNS);
    const columns = keptCols.map((c) => truncateColumnName(c.name));
    const rows = res.rows.map((row) => row.slice(0, MAX_AGENT_COLUMNS).map(truncateCell));
    const payload: {
      columns: string[];
      rows: (null | boolean | number | string)[][];
      truncated: boolean;
      columnsOmitted?: number;
    } = {
      columns,
      rows,
      truncated: res.truncated,
    };
    if (totalCols > MAX_AGENT_COLUMNS) {
      payload.columnsOmitted = totalCols - MAX_AGENT_COLUMNS;
    }
    return JSON.stringify(payload);
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: sanitizeAgentError(rawMessage) });
  }
}

export async function runAgent(
  turn: TurnRequest,
  deps: AgentDeps,
  onEvent: (event: AgentEvent) => void,
): Promise<TurnOutcome> {
  const steps: StepRecord[] = [];
  let corrected = false;
  let correction: string | undefined;

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
    if (action.action === "query") {
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
    } else {
      result = describeRelations(schema, action.relations);
    }

    const step: StepRecord = { action, result };
    steps.push(step);
    emit({ type: "step", step });
  }
}

