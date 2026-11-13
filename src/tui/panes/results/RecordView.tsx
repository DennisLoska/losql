import type { BoxRenderable } from "@opentui/core";
import { createEffect, createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type { Cell, Result } from "../../../core/db/types";
import { useTheme } from "../../context/theme";
import { cellWidth, cutCells } from "../../ui/cells";
import { Highlighted } from "../../ui/highlighted";
import { printable } from "../../ui/printable";
import { NULL_GLYPH } from "./grid-model";

interface LazyField {
  name: string;
  type: string;
  cell: Cell;
  isNull: boolean;
  json: boolean;
  lineCount(): number;
  sliceLines(limit: number): string[];
}

function countLinesInString(text: string): number {
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      count++;
    } else if (c === 13) {
      count++;
      if (i + 1 < text.length && text.charCodeAt(i + 1) === 10) {
        i++;
      }
    }
  }
  return count;
}

function takeFirstLines(text: string, limit: number): string[] {
  if (limit <= 0) return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || c === 13) {
      out.push(text.slice(start, i));
      if (out.length >= limit) return out;
      if (c === 13 && i + 1 < text.length && text.charCodeAt(i + 1) === 10) {
        i++;
      }
      start = i + 1;
    }
  }
  if (out.length < limit) {
    out.push(text.slice(start));
  }
  return out;
}

function buildLazyFields(result: Result, row: number): LazyField[] {
  if (row < 0 || row >= result.rows.length) return [];
  const dataRow = result.rows[row]!;
  return result.columns.map((col, idx) => {
    const cell = dataRow[idx] ?? null;
    const isNull = cell === null;
    const json = !isNull && typeof cell === "object";
    let rawText: string | null = null;
    let cachedCount: number | null = null;
    let cachedSliceLimit = -1;
    let cachedSlice: string[] = [];

    const getRawText = (): string => {
      if (rawText === null) {
        if (isNull) {
          rawText = NULL_GLYPH;
        } else if (json) {
          rawText = JSON.stringify(cell, null, 2);
        } else {
          rawText = String(cell);
        }
      }
      return rawText;
    };

    const lineCount = (): number => {
      if (cachedCount !== null) return cachedCount;
      if (isNull) {
        cachedCount = 1;
        return 1;
      }
      cachedCount = countLinesInString(getRawText());
      return cachedCount;
    };

    const sliceLines = (limit: number): string[] => {
      if (limit === cachedSliceLimit) return cachedSlice;
      cachedSliceLimit = limit;
      if (isNull) {
        cachedSlice = limit > 0 ? [NULL_GLYPH] : [];
        return cachedSlice;
      }
      cachedSlice = takeFirstLines(getRawText(), limit);
      return cachedSlice;
    };

    return {
      name: col.name,
      type: col.type,
      cell,
      isNull,
      json,
      lineCount,
      sliceLines,
    };
  });
}

export function RecordView(props: {
  result: Result;
  row: number;
  fieldCursor: number;
  onHeight?: (height: number) => void;
}): JSX.Element {
  const theme = useTheme();

  let boxRef: BoxRenderable | null = null;
  const [boxHeight, setBoxHeight] = createSignal(10);
  const [boxWidth, setBoxWidth] = createSignal(80);
  const [firstField, setFirstField] = createSignal(0);

  let lastResult: Result | null = null;
  let lastRow = -1;

  createEffect(() => {
    if (props.result !== lastResult || props.row !== lastRow) {
      lastResult = props.result;
      lastRow = props.row;
      setFirstField(0);
    }
  });

  const fields = createMemo(() => buildLazyFields(props.result, props.row));

  const bodyHeight = createMemo(() => {
    const sigH = boxHeight();
    const rawH = boxRef && boxRef.height > 0 ? boxRef.height : sigH;
    const h = Math.max(1, rawH - 1);
    props.onHeight?.(h);
    return h;
  });

  const maxValueLines = createMemo(() => Math.max(3, bodyHeight() - 2));

  const fieldHeights = createMemo(() => {
    const cap = maxValueLines();
    return fields().map((f) => {
      if (!f.json && f.lineCount() <= 1) return 1;
      const shown = Math.min(f.lineCount(), cap);
      return 1 + shown;
    });
  });

  const visibleFieldIndices = createMemo<number[]>(() => {
    const all = fields();
    if (all.length === 0) return [];
    const h = bodyHeight();
    const heights = fieldHeights();
    const cur = Math.max(0, Math.min(all.length - 1, props.fieldCursor));
    let start = Math.max(0, Math.min(all.length - 1, firstField()));

    if (cur < start) {
      start = cur;
    }

    const takeFrom = (s: number): number[] => {
      const indices: number[] = [];
      let used = 0;
      for (let i = s; i < all.length; i++) {
        const fh = heights[i] ?? 1;
        if (indices.length > 0 && used + fh > h) {
          break;
        }
        indices.push(i);
        used += fh;
      }
      return indices;
    };

    let shown = takeFrom(start);
    while (!shown.includes(cur) && start < cur) {
      start++;
      shown = takeFrom(start);
    }

    if (start !== firstField()) {
      setFirstField(start);
    }

    return shown;
  });

  const maxNameWidth = createMemo(() => {
    let maxW = 0;
    for (const f of fields()) {
      const w = cellWidth(printable(f.name));
      if (w > maxW) maxW = w;
    }
    return Math.min(30, Math.max(1, maxW));
  });

  return (
    <box
      ref={(el: BoxRenderable) => {
        boxRef = el;
        if (el.height > 0) setBoxHeight(el.height);
        if (el.width > 0) setBoxWidth(el.width);
      }}
      onSizeChange={() => {
        if (boxRef && boxRef.height > 0) setBoxHeight(boxRef.height);
        if (boxRef && boxRef.width > 0) setBoxWidth(boxRef.width);
      }}
      flexGrow={1}
      width="100%"
      height="100%"
      flexDirection="column"
      justifyContent="space-between"
    >
      <box flexGrow={1} width="100%" flexDirection="column">
        <For each={visibleFieldIndices()}>
          {(fieldIdx) => {
            const f = () => fields()[fieldIdx]!;
            const isSelected = () => fieldIdx === props.fieldCursor;
            const nameText = () => {
              const clean = printable(f().name);
              const pad = Math.max(0, maxNameWidth() - cellWidth(clean));
              return clean + " ".repeat(pad);
            };
            const typeText = () => (f().type ? ` ${printable(f().type)} ` : " ");
            const totalLines = () => f().lineCount();
            const isSingleLine = () => !f().json && totalLines() <= 1;
            const singleLineVal = () => f().sliceLines(1)[0] ?? "";
            // A one-line value is cut to what the row can show, reading only a prefix bounded by the width;
            // y still copies the whole value.
            const singleLineShown = () => {
              const room = Math.max(0, boxWidth() - cellWidth(nameText()) - cellWidth(typeText()));
              return cutCells(singleLineVal(), room, { ellipsis: true, clean: printable });
            };
            const isNullVal = () => f().isNull;

            const multiLineState = createMemo(() => {
              const total = totalLines();
              const cap = maxValueLines();
              if (total > cap) {
                const shownCount = Math.max(0, cap - 1);
                return {
                  lines: f().sliceLines(shownCount),
                  omitted: total - shownCount,
                };
              }
              return {
                lines: f().sliceLines(total),
                omitted: 0,
              };
            });

            return (
              <Show
                when={!isSingleLine()}
                fallback={
                  <box height={1} width="100%" flexShrink={0} flexDirection="row">
                    <text
                      fg={theme.color("primary")}
                      bg={isSelected() ? theme.color("selection") : undefined}
                      flexShrink={0}
                    >
                      {nameText()}
                    </text>
                    <text fg={theme.color("textMuted")} flexShrink={0}>
                      {typeText()}
                    </text>
                    <text
                      fg={isNullVal() ? theme.color("textMuted") : theme.color("text")}
                      flexShrink={0}
                    >
                      {isNullVal() ? NULL_GLYPH : singleLineShown()}
                    </text>
                  </box>
                }
              >
                <box width="100%" flexShrink={0} flexDirection="column">
                  <box height={1} width="100%" flexShrink={0} flexDirection="row">
                    <text
                      fg={theme.color("primary")}
                      bg={isSelected() ? theme.color("selection") : undefined}
                      flexShrink={0}
                    >
                      {nameText()}
                    </text>
                    <text fg={theme.color("textMuted")} flexShrink={0}>
                      {typeText()}
                    </text>
                  </box>
                  <For each={multiLineState().lines}>
                    {(line) => (
                      <box height={1} width="100%" flexShrink={0} paddingLeft={2}>
                        <Show
                          when={f().json}
                          fallback={<text fg={theme.color("text")}>{printable(line)}</text>}
                        >
                          <Highlighted language="json" text={line} />
                        </Show>
                      </box>
                    )}
                  </For>
                  <Show when={multiLineState().omitted > 0}>
                    <box height={1} width="100%" flexShrink={0} paddingLeft={2}>
                      <text fg={theme.color("textMuted")}>
                        {`… ${multiLineState().omitted} more lines · y copies the whole value`}
                      </text>
                    </box>
                  </Show>
                </box>
              </Show>
            );
          }}
        </For>
      </box>
      <box height={1} width="100%" flexShrink={0}>
        <text fg={theme.color("textMuted")}>
          {`row ${props.row + 1} of ${props.result.rows.length}`}
        </text>
      </box>
    </box>
  );
}
