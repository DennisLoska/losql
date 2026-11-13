import { createMemo, For, type JSX } from "solid-js";
import { highlightJson, highlightSql, type SyntaxRole } from "../../core/sql/highlight";
import type { ThemeToken } from "../../core/theme/tokens";
import { useTheme } from "../context/theme";
import { printable } from "./printable";

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

interface HighlightPiece {
  text: string;
  token: ThemeToken;
}

export function Highlighted(props: { text: string; language: "sql" | "json" }): JSX.Element {
  const theme = useTheme();

  const pieces = createMemo<HighlightPiece[]>(() => {
    const clean = printable(props.text, { keepNewlines: true });
    if (clean.length === 0) return [];
    const spans = props.language === "sql" ? highlightSql(clean) : highlightJson(clean);
    const out: HighlightPiece[] = [];
    let pos = 0;

    for (const span of spans) {
      if (span.start > pos) {
        out.push({ text: clean.slice(pos, span.start), token: "text" });
      }
      if (span.end > span.start) {
        out.push({
          text: clean.slice(span.start, span.end),
          token: ROLE_TO_TOKEN[span.role],
        });
      }
      if (span.end > pos) {
        pos = span.end;
      }
    }

    if (pos < clean.length) {
      out.push({ text: clean.slice(pos), token: "text" });
    }

    return out;
  });

  return (
    <text fg={theme.color("text")}>
      <For each={pieces()}>
        {(piece) => <span style={{ fg: theme.color(piece.token) }}>{piece.text}</span>}
      </For>
    </text>
  );
}
