import { isRecord } from "./providers/util";

export const MAX_REPLY_CHARS = 200000;
const MAX_CANDIDATE_STARTS = 64;

export type AgentAction =
  | { action: "query"; sql: string; why?: string }
  | { action: "describe"; relations: string[] }
  | { action: "answer"; message: string; sql?: string };

export type ParsedReply = { ok: true; action: AgentAction } | { ok: false; reason: string };

type JsonSearchResult =
  | { kind: "none" }
  | { kind: "no_action" }
  | { kind: "found"; obj: Record<string, unknown> };

function findJsonObjectWithAction(text: string): JsonSearchResult {
  let candidatesTried = 0;
  let sawObjectWithoutAction = false;

  for (
    let start = 0;
    start < text.length && candidatesTried < MAX_CANDIDATE_STARTS;
    start++
  ) {
    if (text[start] !== "{") continue;
    candidatesTried++;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const slice = text.slice(start, i + 1);
          try {
            const parsed: unknown = JSON.parse(slice);
            if (isRecord(parsed)) {
              if ("action" in parsed && typeof parsed.action === "string") {
                return { kind: "found", obj: parsed };
              }
              sawObjectWithoutAction = true;
              start = i;
              break;
            }
          } catch {
            // Not valid JSON, continue from the next '{'
          }
          break;
        }
      }
    }
  }

  return sawObjectWithoutAction ? { kind: "no_action" } : { kind: "none" };
}

function extractFencedSql(text: string): string | undefined {
  const match = text.match(/```[ \t]*sql[ \t]*\r?\n([\s\S]*?)```/i);
  if (!match || match[1] === undefined) return undefined;
  const sql = match[1].trim();
  return sql.length > 0 ? sql : undefined;
}

/**
 * SQLite reads a Statement only up to its first NUL character (U+0000), so SQL with a NUL would
 * be shown and confirmed as something else than what runs. Such SQL makes the reply invalid.
 */
function containsNul(sql: string): boolean {
  return sql.includes("\u0000");
}

const NUL_REASON = "the SQL contains a NUL character (U+0000)";

const MAX_REASON_CHARS = 200;
const MAX_REASON_SNIPPET_CHARS = 40;

function sliceCodePoints(text: string, maxUnits: number, marker = "…"): string {
  if (text.length <= maxUnits) {
    return text;
  }
  let end = maxUnits;
  const prev = text.charCodeAt(end - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) {
    end--;
  }
  return `${text.slice(0, end)}${marker}`;
}

function formatReplySnippet(text: string): string {
  const withoutControls = text.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, "");
  const cut = sliceCodePoints(withoutControls, MAX_REASON_SNIPPET_CHARS);
  return JSON.stringify(cut).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

function boundReason(reason: string): string {
  const oneLine = reason.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, " ");
  if (oneLine.length <= MAX_REASON_CHARS) {
    return oneLine;
  }
  return sliceCodePoints(oneLine, MAX_REASON_CHARS - 1);
}

export function parseAction(reply: string): ParsedReply {
  const bounded = sliceCodePoints(reply, MAX_REPLY_CHARS, "");
  const trimmed = bounded.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: boundReason("the reply was empty") };
  }

  const found = findJsonObjectWithAction(trimmed);
  if (found.kind === "none") {
    const sql = extractFencedSql(trimmed);
    if (sql !== undefined && containsNul(sql)) {
      return { ok: false, reason: boundReason(NUL_REASON) };
    }
    const action: AgentAction = { action: "answer", message: trimmed };
    if (sql !== undefined) {
      action.sql = sql;
    }
    return { ok: true, action };
  }

  if (found.kind === "no_action") {
    return { ok: false, reason: boundReason('the JSON object has no "action"') };
  }

  const obj = found.obj;
  const actionType = obj.action as string;

  if (actionType === "query") {
    if (typeof obj.sql !== "string" || obj.sql.trim().length === 0) {
      return { ok: false, reason: boundReason('a "query" action needs a non-empty "sql" string') };
    }
    if (containsNul(obj.sql)) {
      return { ok: false, reason: boundReason(NUL_REASON) };
    }
    const action: AgentAction = { action: "query", sql: obj.sql };
    if (typeof obj.why === "string" && obj.why.trim().length > 0) {
      action.why = obj.why;
    }
    return { ok: true, action };
  }

  if (actionType === "describe") {
    if (
      !Array.isArray(obj.relations) ||
      !obj.relations.every((r): r is string => typeof r === "string")
    ) {
      return {
        ok: false,
        reason: boundReason('a "describe" action needs a "relations" array of names'),
      };
    }
    return { ok: true, action: { action: "describe", relations: [...obj.relations] } };
  }

  if (actionType === "answer") {
    if (typeof obj.message !== "string") {
      return { ok: false, reason: boundReason('an "answer" action needs a "message" string') };
    }
    const action: AgentAction = { action: "answer", message: obj.message };
    if (typeof obj.sql === "string" && obj.sql.trim().length > 0) {
      if (containsNul(obj.sql)) {
        return { ok: false, reason: boundReason(NUL_REASON) };
      }
      action.sql = obj.sql;
    }
    return { ok: true, action };
  }

  return { ok: false, reason: boundReason(`unknown action ${formatReplySnippet(actionType)}`) };
}

