import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal, type JSX, Show } from "solid-js";
import { useLayer } from "../context/keys";
import { useTheme } from "../context/theme";
import { cellWidth, graphemes } from "./cells";
import { printable } from "./printable";

function breakTokenByCells(token: string, maxWidth: number): string[] {
  const width = Math.max(1, maxWidth);
  if (cellWidth(token) <= width) return [token];
  const parts: string[] = [];
  let cur = "";
  let curW = 0;
  for (const { segment } of graphemes.segment(token)) {
    const sw = cellWidth(segment);
    if (cur.length > 0 && curW + sw > width) {
      parts.push(cur);
      cur = segment;
      curW = sw;
    } else {
      cur += segment;
      curW += sw;
    }
  }
  if (cur.length > 0) parts.push(cur);
  return parts;
}

function wrapParagraph(line: string, maxWidth: number): string[] {
  const width = Math.max(1, maxWidth);
  if (line.length === 0) return [""];
  if (cellWidth(line) <= width) return [line];
  const words = line.split(" ");
  const out: string[] = [];
  let cur = "";
  let curW = 0;
  for (const rawWord of words) {
    const pieces = breakTokenByCells(rawWord, width);
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!;
      const pw = cellWidth(piece);
      if (cur.length === 0) {
        cur = piece;
        curW = pw;
      } else if (i === 0 && curW + 1 + pw <= width) {
        cur += ` ${piece}`;
        curW += 1 + pw;
      } else {
        out.push(cur);
        cur = piece;
        curW = pw;
      }
    }
  }
  if (cur.length > 0 || out.length === 0) out.push(cur);
  return out;
}

export interface ConfirmProps {
  title: string;
  message?: string;
  body?: () => JSX.Element;
  confirm?: string;
  cancel?: string;
  danger?: boolean;
}

export function DialogConfirm(
  props: ConfirmProps & { onAnswer: (confirmed: boolean) => void },
): JSX.Element {
  const theme = useTheme();
  const dimensions = useTerminalDimensions();
  const [selected, setSelected] = createSignal<"cancel" | "confirm">("cancel");

  useLayer((key) => {
    if (key.ctrl || key.meta) return false;
    if (
      key.name === "tab" ||
      key.name === "h" ||
      key.name === "l" ||
      key.name === "left" ||
      key.name === "right"
    ) {
      setSelected((prev) => (prev === "cancel" ? "confirm" : "cancel"));
      return true;
    }
    if (key.name === "enter") {
      props.onAnswer(selected() === "confirm");
      return true;
    }
    if (key.name === "y") {
      props.onAnswer(true);
      return true;
    }
    if (key.name === "n") {
      props.onAnswer(false);
      return true;
    }
    return false;
  });

  const cancelLabel = () => printable(props.cancel ?? "Cancel");
  const confirmLabel = () => printable(props.confirm ?? "Confirm");

  const contentWidth = createMemo(() => {
    const panelWidth = Math.max(10, Math.min(60, dimensions().width - 4));
    return Math.max(1, panelWidth - 4);
  });

  const wrappedMessageRows = createMemo<string[]>(() => {
    if (!props.message) return [];
    const clean = printable(props.message, { keepNewlines: true });
    const cw = contentWidth();
    const rows: string[] = [];
    for (const paragraph of clean.split("\n")) {
      rows.push(...wrapParagraph(paragraph, cw));
    }
    return rows;
  });

  // Available rows inside the dialog after top/bottom padding (2), title (1), gap (1), buttons (1), gap (1) = height - 6
  // Leave 2 extra rows for top/bottom margin when height allows: height - 8
  const availableMiddleRows = createMemo(() => {
    const h = dimensions().height;
    const margin = h >= 10 ? 2 : 0;
    return Math.max(0, h - 6 - margin);
  });

  const maxMessageRows = createMemo(() => {
    if (!props.message) return 0;
    const avail = availableMiddleRows();
    if (!props.body) {
      return Math.max(1, avail);
    }
    // When both message and body exist, they have a 1-row gap between them.
    // Reserve at least 1 row for body + 1 row for gap when possible.
    return Math.max(1, avail - 2);
  });

  const formattedMessageLines = createMemo<string[]>(() => {
    const rows = wrappedMessageRows();
    if (rows.length === 0) return [];
    const max = maxMessageRows();
    if (rows.length <= max) return rows;
    if (max <= 1) return [`… ${rows.length} more lines`];
    const kept = rows.slice(0, max - 1);
    const hidden = rows.length - kept.length;
    return [...kept, `… ${hidden} more lines`];
  });

  const formattedMessage = createMemo(() => formattedMessageLines().join("\n"));

  const maxBodyRows = createMemo(() => {
    if (!props.body) return 0;
    const avail = availableMiddleRows();
    const msgCount = formattedMessageLines().length;
    const usedByMessage = msgCount > 0 ? msgCount + 1 : 0;
    return Math.max(1, avail - usedByMessage);
  });

  return (
    <box flexDirection="column" width="100%" gap={1}>
      <box flexDirection="row" justifyContent="space-between" width="100%" flexShrink={0}>
        <text fg={theme.color("text")} attributes={TextAttributes.BOLD} wrapMode="none">
          {printable(props.title)}
        </text>
        <text fg={theme.color("textMuted")} wrapMode="none">
          esc
        </text>
      </box>

      <Show when={props.message && formattedMessageLines().length > 0 && (dimensions().height >= 8 || !props.body)}>
        <text fg={theme.color("text")} flexShrink={0}>
          {formattedMessage()}
        </text>
      </Show>

      <Show when={props.body && maxBodyRows() > 0}>
        <box
          flexDirection="column"
          width="100%"
          maxHeight={maxBodyRows()}
          overflow="hidden"
          flexShrink={1}
        >
          {props.body!()}
        </box>
      </Show>

      <box flexDirection="row" justifyContent="flex-end" gap={2} width="100%" flexShrink={0}>
        <box
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={
            selected() === "cancel" ? theme.color("selection") : theme.color("overlayBackground")
          }
        >
          <text
            fg={selected() === "cancel" ? theme.color("text") : theme.color("textMuted")}
            attributes={selected() === "cancel" ? TextAttributes.BOLD : undefined}
            wrapMode="none"
          >
            {cancelLabel()}
          </text>
        </box>

        <box
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={
            selected() === "confirm" ? theme.color("selection") : theme.color("overlayBackground")
          }
        >
          <text
            fg={
              props.danger
                ? theme.color("error")
                : selected() === "confirm"
                  ? theme.color("primary")
                  : theme.color("textMuted")
            }
            attributes={selected() === "confirm" ? TextAttributes.BOLD : undefined}
            wrapMode="none"
          >
            {confirmLabel()}
          </text>
        </box>
      </box>
    </box>
  );
}

