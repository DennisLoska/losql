import type { StepRecord } from "../../../core/agent/loop";
import type { ProviderErrorKind } from "../../../core/agent/run";
import type { TurnView } from "../../context/agent";
import { cellWidth, cutCells } from "../../ui/cells";
import { keyLabel } from "../../ui/key-label";
import { segmentGraphemes } from "../../ui/line-input";
import { printable } from "../../ui/printable";

export type TranscriptLine =
  | { kind: "user"; text: string; pad?: true; turnId: number }
  | { kind: "label"; who: "agent"; turnId: number }
  | { kind: "text"; text: string; tone: "normal" | "muted" | "error"; turnId: number }
  | { kind: "step"; text: string; tone: "muted" | "error"; turnId: number }
  | {
      kind: "sql";
      text: string;
      turnId: number;
      proposalId: number | null;
      /** Set by the model on a row that continues the SQL line above; its text starts with `↪ `. */
      continuation?: true;
    }
  | { kind: "proposal-header"; text: string; turnId: number; proposalId: number }
  | { kind: "hint"; text: string; turnId: number; proposalId: number }
  | { kind: "status"; activity: "thinking" | "querying"; turnId: number }
  | { kind: "blank" };

function splitLongWord(word: string, maxWidth: number): string[] {
  const w = Math.max(1, maxWidth);
  const segs = segmentGraphemes(word);
  const pieces: string[] = [];
  let cur = "";
  let curW = 0;

  for (const s of segs) {
    const gW = Math.max(1, cellWidth(s.segment));
    if (cur.length > 0 && curW + gW > w) {
      pieces.push(cur);
      cur = s.segment;
      curW = gW;
    } else {
      cur += s.segment;
      curW += gW;
    }
  }
  if (cur.length > 0 || pieces.length === 0) {
    pieces.push(cur);
  }
  return pieces;
}

export function wrapText(text: string, width: number): string[] {
  const clean = printable(text, { keepNewlines: true });
  const maxWidth = Math.max(1, width);
  const paragraphs = clean.split("\n");
  const lines: string[] = [];

  for (const para of paragraphs) {
    const trimmedPara = para.trim();
    if (trimmedPara.length === 0) {
      lines.push("");
      continue;
    }
    const words = trimmedPara.split(/ +/);
    let currentLine = "";
    let currentWidth = 0;

    for (const word of words) {
      if (word.length === 0) continue;
      const wordW = cellWidth(word);
      if (wordW > maxWidth) {
        if (currentLine.length > 0) {
          lines.push(currentLine);
          currentLine = "";
          currentWidth = 0;
        }
        const pieces = splitLongWord(word, maxWidth);
        for (let i = 0; i < pieces.length - 1; i++) {
          lines.push(pieces[i]!);
        }
        const lastPiece = pieces[pieces.length - 1]!;
        currentLine = lastPiece;
        currentWidth = cellWidth(lastPiece);
      } else if (currentLine.length === 0) {
        currentLine = word;
        currentWidth = wordW;
      } else if (currentWidth + 1 + wordW <= maxWidth) {
        currentLine += ` ${word}`;
        currentWidth += 1 + wordW;
      } else {
        lines.push(currentLine);
        currentLine = word;
        currentWidth = wordW;
      }
    }

    if (currentLine.length > 0) {
      lines.push(currentLine);
    }
  }

  return lines.length === 0 ? [""] : lines;
}

export function splitMessage(message: string): { kind: "text" | "sql"; text: string }[] {
  const normalized = message.replace(/\r\n|\r|\u2028|\u2029/g, "\n");
  const lines = normalized.split("\n");
  const parts: { kind: "text" | "sql"; text: string }[] = [];
  let textLines: string[] = [];
  let i = 0;

  const flushText = () => {
    if (textLines.length === 0) return;
    const joined = textLines.join("\n").trim();
    textLines = [];
    if (joined.length > 0) {
      parts.push({ kind: "text", text: joined });
    }
  };

  while (i < lines.length) {
    const line = lines[i]!;
    if (/^```[ \t]*sql[ \t]*$/i.test(line)) {
      let closeIdx = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^```[ \t]*$/.test(lines[j]!)) {
          closeIdx = j;
          break;
        }
      }
      if (closeIdx !== -1) {
        flushText();
        const sqlContent = lines.slice(i + 1, closeIdx).join("\n");
        parts.push({ kind: "sql", text: sqlContent });
        i = closeIdx + 1;
        continue;
      }
    }
    textLines.push(line);
    i++;
  }

  flushText();
  return parts;
}

function cutToCells(text: string, maxCells: number): string {
  if (maxCells <= 0) return "";
  return cutCells(text, maxCells, { ellipsis: true });
}

function oneLine(text: string): string {
  return printable(text).replace(/\s+/g, " ").trim();
}

/**
 * The error a Step's payload reports, cleaned to one line, or null when it reports none. A payload
 * that is not JSON is an error for the Steps whose payload is always JSON (query, explain,
 * read_results).
 */
function stepError(step: StepRecord): string | null {
  const action = step.action.action;
  let parsed: unknown;
  try {
    parsed = JSON.parse(step.result);
  } catch {
    if (action === "query" || action === "explain" || action === "read_results") {
      return oneLine(step.result);
    }
    return null;
  }
  const obj = asObject(parsed);
  if (obj === null || obj.error === undefined || obj.error === null) return null;
  return oneLine(typeof obj.error === "string" ? obj.error : JSON.stringify(obj.error));
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The Step's payload as a JSON object, or null when it is not one. */
function payloadObject(result: string): Record<string, unknown> | null {
  try {
    return asObject(JSON.parse(result));
  } catch {
    return null;
  }
}

/** True when a Step's payload is an error; its row is then drawn in the error colour. */
export function stepFailed(step: StepRecord): boolean {
  return stepError(step) !== null;
}

/** `prefix + body + suffix`, cutting the body first so the outcome stays visible. */
function fitSummary(prefix: string, body: string, suffix: string, maxWidth: number): string {
  const full = `${prefix}${body}${suffix}`;
  if (cellWidth(full) <= maxWidth) return full;
  const bodyBudget = maxWidth - cellWidth(prefix) - cellWidth(suffix);
  if (bodyBudget >= 1) return `${prefix}${cutToCells(body, bodyBudget)}${suffix}`;
  return cutToCells(full, maxWidth);
}

export function stepSummary(step: StepRecord, width: number): string {
  const maxWidth = Math.max(1, width);
  const error = stepError(step);
  const errorSuffix = error !== null ? `  → error: ${error}` : "";
  if (step.action.action === "describe") {
    const names = step.action.relations.map((r) => printable(r)).join(", ");
    return fitSummary("▸ describe  ", names, errorSuffix, maxWidth);
  }
  if (step.action.action === "query") {
    let outcome = "0 rows";
    if (error !== null) {
      outcome = `error: ${error}`;
    } else {
      const obj = payloadObject(step.result);
      if (obj !== null && Array.isArray(obj.rows)) {
        const n = obj.rows.length;
        outcome = obj.truncated === true ? `${n}+ rows` : n === 1 ? "1 row" : `${n} rows`;
      }
    }
    return fitSummary("▸ query  ", oneLine(step.action.sql), `  → ${outcome}`, maxWidth);
  }
  if (step.action.action === "explain") {
    const outcome = error !== null ? `error: ${error}` : "plan";
    return fitSummary("▸ explain  ", oneLine(step.action.sql), `  → ${outcome}`, maxWidth);
  }
  if (step.action.action === "read_buffer") {
    const target = step.action.name ? printable(step.action.name) : "open buffers";
    return fitSummary("▸ buffer  ", target, errorSuffix, maxWidth);
  }
  if (step.action.action === "read_results") {
    let outcome = "empty";
    if (error !== null) {
      outcome = `error: ${error}`;
    } else {
      const obj = payloadObject(step.result);
      if (obj === null || obj.shown === null) {
        outcome = "empty";
      } else if (Array.isArray(obj.rows)) {
        const n = obj.rows.length;
        outcome = obj.truncated === true ? `${n}+ rows` : n === 1 ? "1 row" : `${n} rows`;
      }
    }
    return cutToCells(`▸ results  ${outcome}`, maxWidth);
  }
  return "";
}

export function errorAdvice(
  kind: ProviderErrorKind | "protocol",
  provider: { label: string; binary: string; installHint: string } | null,
  leader = "space",
): string {
  if (kind === "cancelled" || kind === "other") return "";
  if (kind === "protocol") {
    return `The reply could not be understood. Try again, or pick another model with ${keyLabel("m", leader)}.`;
  }
  if (!provider) return "";
  if (kind === "auth") {
    return `Run \`${printable(provider.binary)}\` once in a terminal to log in, then try again.`;
  }
  if (kind === "quota") {
    return `${printable(provider.label)} has reached its usage limit. Try again later or switch provider with ${keyLabel("p", leader)}.`;
  }
  if (kind === "missing") {
    return printable(provider.installHint);
  }
  if (kind === "timeout") {
    return `${printable(provider.label)} did not answer in time. Try again, or pick a faster model with ${keyLabel("m", leader)}.`;
  }
  return "";
}

const MAX_SQL_CARD_ROWS = 60;

/** The plain cells left of a SQL card: two when the Transcript has room for them, none otherwise. */
export function sqlCardInset(width: number): number {
  return width >= 12 ? 2 : 0;
}
const CONTINUATION_MARKER = "↪ ";
const CONTINUATION_MARKER_WIDTH = 2;
/** How a real SQL line that starts with `↪` shows that character, so it cannot be taken for the marker. */
export const ESCAPED_MARKER_CHAR = "\\u21AA";
const ESCAPED_MARKER_EXTRA_WIDTH = ESCAPED_MARKER_CHAR.length - 1;

/** True when a row is a real SQL line whose `↪` is written out as {@link ESCAPED_MARKER_CHAR}. */
export function startsWithMarkerChar(row: { text: string; continuation?: boolean }): boolean {
  return row.continuation !== true && row.text.startsWith("↪");
}

/**
 * Splits one line (no line feed in it, already cleaned) into the string ranges of its rows: break
 * after whitespace when there is a break point in the last third of the row, otherwise at the cell
 * boundary; a continuation row loses two cells to the marker. When `escapeFirst` is set, the first
 * grapheme is shown six cells wider (the written-out `↪`).
 */
function layoutSqlLine(line: string, width: number, escapeFirst: boolean): [number, number][] {
  const maxWidth = Math.max(1, width);
  if (line.length === 0) return [[0, 0]];
  const extra = escapeFirst ? ESCAPED_MARKER_EXTRA_WIDTH : 0;
  if (cellWidth(line) + extra <= maxWidth) return [[0, line.length]];

  const segs = segmentGraphemes(line);
  const segWidths = new Array<number>(segs.length);
  const segIsSpace = new Array<boolean>(segs.length);
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!.segment;
    segWidths[i] = Math.max(1, cellWidth(seg)) + (i === 0 ? extra : 0);
    segIsSpace[i] = seg === " ";
  }

  const ranges: [number, number][] = [];
  let pos = 0;

  while (pos < segs.length) {
    const isFirst = ranges.length === 0;
    const budget = isFirst ? maxWidth : Math.max(1, maxWidth - CONTINUATION_MARKER_WIDTH);

    let used = 0;
    let endIdx = pos;
    let lastSpaceIdx = -1;
    let cellsAtLastSpace = 0;

    while (endIdx < segs.length) {
      const w = segWidths[endIdx]!;
      if (used + w > budget) break;
      used += w;
      if (segIsSpace[endIdx]) {
        lastSpaceIdx = endIdx;
        cellsAtLastSpace = used;
      }
      endIdx++;
    }

    if (endIdx === segs.length) {
      ranges.push([segs[pos]!.index, line.length]);
      break;
    }

    if (endIdx === pos) {
      endIdx = pos + 1;
    }

    let breakIdx = endIdx;
    if (lastSpaceIdx >= pos && cellsAtLastSpace * 3 >= budget * 2) {
      breakIdx = lastSpaceIdx + 1;
    }

    ranges.push([segs[pos]!.index, segs[breakIdx - 1]!.end]);
    pos = breakIdx;
  }

  return ranges.length === 0 ? [[0, 0]] : ranges;
}

export function wrapSqlLine(line: string, width: number): string[] {
  return layoutSqlLine(line, width, false).map(([start, end], i) =>
    i === 0 ? line.slice(start, end) : `${CONTINUATION_MARKER}${line.slice(start, end)}`,
  );
}

export interface SqlCardRow {
  /** The row's text: cleaned SQL, after the `↪ ` marker on a continuation row. */
  text: string;
  continuation: boolean;
}

/**
 * The one path from SQL to the rows a card or the confirmation shows. Only a line feed of the SQL
 * starts a new line; each line is cleaned with `printable()` first (so every character is measured
 * as the cell it becomes) and wrapped afterwards.
 */
export function sqlCardRows(sql: string, width: number): SqlCardRow[] {
  const rows: SqlCardRow[] = [];
  for (const rawLine of sql.split("\n")) {
    const line = printable(rawLine);
    const ranges = layoutSqlLine(line, width, line.startsWith("↪"));
    for (let i = 0; i < ranges.length; i++) {
      const [start, end] = ranges[i]!;
      rows.push(
        i === 0
          ? { text: line.slice(start, end), continuation: false }
          : { text: `${CONTINUATION_MARKER}${line.slice(start, end)}`, continuation: true },
      );
    }
  }
  return rows;
}

function appendSqlLines(
  out: TranscriptLine[],
  sql: string,
  width: number,
  turnId: number,
  proposalId: number | null,
): void {
  const rows = sqlCardRows(sql, width);

  const limit = Math.min(MAX_SQL_CARD_ROWS, rows.length);
  for (let i = 0; i < limit; i++) {
    const row = rows[i]!;
    out.push(
      row.continuation
        ? { kind: "sql", text: row.text, turnId, proposalId, continuation: true }
        : { kind: "sql", text: row.text, turnId, proposalId },
    );
  }

  if (rows.length > MAX_SQL_CARD_ROWS) {
    const more = rows.length - MAX_SQL_CARD_ROWS;
    // Only a Proposal opens in the editor with Enter; fenced SQL in a message just says what is left out.
    out.push({
      kind: "text",
      text: proposalId !== null ? `… ${more} more rows · enter opens the whole statement in the editor` : `… ${more} more rows`,
      tone: "muted",
      turnId,
    });
  }
}

export function turnTranscriptLines(
  turn: TurnView,
  width: number,
  provider: { label: string; binary: string; installHint: string } | null,
  leader = "space",
): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  const userWidth = Math.max(1, width - 3);
  out.push({ kind: "user", text: "", pad: true, turnId: turn.id });
  for (const line of wrapText(turn.text, userWidth)) {
    out.push({ kind: "user", text: line, turnId: turn.id });
  }
  out.push({ kind: "user", text: "", pad: true, turnId: turn.id });
  out.push({ kind: "blank" });
  out.push({ kind: "label", who: "agent", turnId: turn.id });

  for (const step of turn.steps) {
    out.push({
      kind: "step",
      text: stepSummary(step, width),
      tone: stepFailed(step) ? "error" : "muted",
      turnId: turn.id,
    });
  }

  const sqlWidth = Math.max(1, width - sqlCardInset(width));
  const content: TranscriptLine[] = [];
  if (turn.status === "running") {
    out.push({
      kind: "status",
      activity: turn.activity ?? "thinking",
      turnId: turn.id,
    });
  } else if (turn.status === "done") {
    if (turn.message !== null && turn.message.length > 0) {
      for (const part of splitMessage(turn.message)) {
        if (part.kind === "text") {
          for (const line of wrapText(part.text, width)) {
            content.push({ kind: "text", text: line, tone: "normal", turnId: turn.id });
          }
        } else {
          appendSqlLines(content, part.text, sqlWidth, turn.id, null);
        }
      }
    }
    if (turn.proposal !== null) {
      content.push({
        kind: "proposal-header",
        text: "SQL Proposal",
        turnId: turn.id,
        proposalId: turn.proposal.id,
      });
      appendSqlLines(content, turn.proposal.sql, sqlWidth, turn.id, turn.proposal.id);
      content.push({
        kind: "hint",
        text: "enter accept  r run  y yank",
        turnId: turn.id,
        proposalId: turn.proposal.id,
      });
    }
  } else if (turn.status === "error") {
    if (turn.message !== null && turn.message.length > 0) {
      for (const line of wrapText(turn.message, width)) {
        content.push({ kind: "text", text: line, tone: "error", turnId: turn.id });
      }
    }
    if (turn.errorKind !== null) {
      const advice = errorAdvice(turn.errorKind, provider, leader);
      if (advice.length > 0) {
        for (const line of wrapText(advice, width)) {
          content.push({ kind: "text", text: line, tone: "muted", turnId: turn.id });
        }
      }
    }
  } else if (turn.status === "cancelled") {
    content.push({ kind: "text", text: "Cancelled.", tone: "muted", turnId: turn.id });
  }

  if (turn.steps.length > 0 && content.length > 0) {
    out.push({ kind: "blank" });
  }
  out.push(...content);
  out.push({ kind: "blank" });
  return out;
}

export function transcriptLines(
  turns: TurnView[],
  width: number,
  provider: { label: string; binary: string; installHint: string } | null,
  leader = "space",
): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const turn of turns) {
    out.push(...turnTranscriptLines(turn, width, provider, leader));
  }
  return out;
}
