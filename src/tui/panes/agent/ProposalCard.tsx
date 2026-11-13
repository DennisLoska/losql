import { createMemo, For, type JSX } from "solid-js";
import { highlightSql, type SyntaxRole } from "../../../core/sql/highlight";
import type { ThemeToken } from "../../../core/theme/tokens";
import { useTheme } from "../../context/theme";
import { printable } from "../../ui/printable";
import { ESCAPED_MARKER_CHAR, startsWithMarkerChar } from "./transcript-model";

const ROLE_TO_TOKEN: Record<SyntaxRole, ThemeToken> = {
  keyword: "syntaxKeyword",
  function: "syntaxFunction",
  variable: "syntaxVariable",
  string: "syntaxString",
  number: "syntaxNumber",
  type: "syntaxType",
  operator: "syntaxOperator",
  punctuation: "syntaxPunctuation",
  comment: "syntaxComment",
  text: "text",
};

const CONTINUATION_MARKER = "↪ ";

export interface SqlHighlightPiece {
  text: string;
  token: ThemeToken;
}

/**
 * Colours the rows of one piece of SQL. Which rows continue the line above is said by the rows
 * (`continuation`), never read from their text; colours are computed over the real lines (rows
 * joined without their markers), so a line is coloured as the code it is. A real line that starts
 * with `↪` shows that character written out, in the muted colour.
 */
export function highlightSqlCardRows(
  rows: readonly { text: string; continuation?: boolean }[],
): SqlHighlightPiece[][] {
  if (rows.length === 0) return [];

  const rowSlices: {
    continuation: boolean;
    escaped: boolean;
    start: number;
    end: number;
  }[] = new Array(rows.length);

  let fullSql = "";
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const continuation = row.continuation === true;
    const clean = printable(row.text);
    const sqlPart = continuation ? clean.slice(CONTINUATION_MARKER.length) : clean;
    if (i > 0 && !continuation) {
      fullSql += "\n";
    }
    const start = fullSql.length;
    fullSql += sqlPart;
    const end = fullSql.length;
    rowSlices[i] = { continuation, escaped: startsWithMarkerChar(row), start, end };
  }

  const spans = fullSql.length > 0 ? highlightSql(fullSql) : [];
  const result: SqlHighlightPiece[][] = new Array(rows.length);
  let spanIdx = 0;

  for (let i = 0; i < rows.length; i++) {
    const { continuation, escaped, start: rowStart, end } = rowSlices[i]!;
    const pieces: SqlHighlightPiece[] = [];
    if (continuation) {
      pieces.push({ text: CONTINUATION_MARKER, token: "textMuted" });
    }
    let start = rowStart;
    if (escaped) {
      pieces.push({ text: ESCAPED_MARKER_CHAR, token: "textMuted" });
      start += 1;
    }

    while (spanIdx < spans.length && spans[spanIdx]!.end <= start) {
      spanIdx++;
    }

    let pos = start;
    for (let k = spanIdx; k < spans.length; k++) {
      const span = spans[k]!;
      if (span.start >= end) break;
      const spStart = Math.max(start, span.start);
      const spEnd = Math.min(end, span.end);
      if (spStart > pos) {
        pieces.push({ text: fullSql.slice(pos, spStart), token: "text" });
      }
      if (spEnd > spStart) {
        pieces.push({
          text: fullSql.slice(spStart, spEnd),
          token: ROLE_TO_TOKEN[span.role],
        });
      }
      if (spEnd > pos) {
        pos = spEnd;
      }
    }

    if (pos < end) {
      pieces.push({ text: fullSql.slice(pos, end), token: "text" });
    }

    result[i] = pieces;
  }

  return result;
}

export function ProposalCardLine(props: {
  kind: "sql" | "hint";
  text: string;
  continuation?: boolean;
  pieces?: SqlHighlightPiece[];
  selected: boolean;
  turnBarColor: ReturnType<ReturnType<typeof useTheme>["color"]>;
}): JSX.Element {
  const theme = useTheme();
  const barColor = () => (props.selected ? theme.color("accent") : props.turnBarColor);
  const resolvedPieces = createMemo<SqlHighlightPiece[]>(() => {
    if (props.pieces) return props.pieces;
    return highlightSqlCardRows([{ text: props.text, continuation: props.continuation }])[0] ?? [];
  });

  return (
    <box height={1} width="100%" flexShrink={0} flexDirection="row" overflow="hidden">
      <text fg={barColor()} flexShrink={0}>
        {"┃ "}
      </text>
      {props.kind === "sql" ? (
        <box
          flexGrow={1}
          flexShrink={1}
          height={1}
          backgroundColor={theme.color("backgroundElement")}
          flexDirection="row"
          overflow="hidden"
        >
          <text fg={theme.color("text")} wrapMode="none" flexShrink={0}>
            <For each={resolvedPieces()}>
              {(piece) => <span style={{ fg: theme.color(piece.token) }}>{piece.text}</span>}
            </For>
          </text>
        </box>
      ) : (
        <text fg={theme.color("textMuted")} wrapMode="none" flexShrink={0}>
          {printable(props.text)}
        </text>
      )}
    </box>
  );
}

