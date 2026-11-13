import { type BoxRenderable, TextAttributes } from "@opentui/core";
import { createEffect, createMemo, createSignal, For, type JSX, onCleanup } from "solid-js";
import type { Result } from "../../../core/db/types";
import { mix } from "../../../core/theme/color";
import { useConfig } from "../../context/config";
import { useDeps } from "../../context/deps";
import { useTheme } from "../../context/theme";
import { tweenValue } from "../../motion/tween";
import { toRGBA } from "../../theme-bridge";
import { Highlighted } from "../../ui/highlighted";
import { printable } from "../../ui/printable";
import {
  columnWidths,
  fit,
  fitCell,
  isNumericColumn,
  NULL_GLYPH,
  type Viewport,
  viewport,
} from "./grid-model";

export interface FlashSpec {
  rows: Set<number>;
  column: number | null;
}

export function ResultGrid(props: {
  result: Result;
  cursor: { row: number; column: number };
  selectedRows: { start: number; end: number } | null;
  flash: FlashSpec | null;
  onViewport?: (vp: Viewport, boxHeight: number) => void;
}): JSX.Element {
  const deps = useDeps();
  const config = useConfig();
  const theme = useTheme();

  let boxRef: BoxRenderable | null = null;
  const [boxDims, setBoxDims] = createSignal({ width: 80, height: 10 });
  const [fadeT, setFadeT] = createSignal(1);

  let prevScroll = { firstRow: 0, firstColumn: 0 };
  let lastResult: Result | null = null;

  createEffect(() => {
    const res = props.result;
    if (res !== lastResult) {
      lastResult = res;
      prevScroll = { firstRow: 0, firstColumn: 0 };
      if (config.animations()) {
        const start = deps.clock.now();
        setFadeT(0);
        const off = deps.clock.onFrame((now) => {
          const elapsed = now - start;
          const next = tweenValue(0, 1, elapsed, 200);
          setFadeT(next);
          if (elapsed >= 200) {
            off();
          }
        });
        onCleanup(off);
      } else {
        setFadeT(1);
      }
    }
  });

  const widths = createMemo(() => columnWidths(props.result));
  const numericCols = createMemo(() =>
    props.result.columns.map((_, i) => isNumericColumn(props.result, i)),
  );

  const currentViewport = createMemo<Viewport>(() => {
    const dims = boxDims();
    const w = boxRef && boxRef.width > 0 ? boxRef.width : dims.width;
    const h = boxRef && boxRef.height > 0 ? boxRef.height : dims.height;
    const vp = viewport({
      widths: widths(),
      rows: props.result.rows.length,
      cursor: props.cursor,
      previous: prevScroll,
      width: w,
      height: h,
    });
    prevScroll = { firstRow: vp.firstRow, firstColumn: vp.firstColumn };
    props.onViewport?.(vp, h);
    return vp;
  });

  const rowTextFg = createMemo(() => {
    const t = fadeT();
    if (t >= 1) return theme.color("text");
    const pal = theme.theme();
    return toRGBA(mix(pal.textMuted, pal.text, t));
  });

  const isCellFlashed = (row: number, col: number): boolean => {
    const f = props.flash;
    if (!f) return false;
    if (!f.rows.has(row)) return false;
    return f.column === null || f.column === col;
  };

  const isCellSelected = (row: number, col: number): boolean => {
    const sel = props.selectedRows;
    if (sel) {
      return row >= sel.start && row <= sel.end;
    }
    return props.cursor.row === row && props.cursor.column === col;
  };

  const visibleRowIndices = createMemo(() => {
    const vp = currentViewport();
    const out: number[] = [];
    for (let i = 0; i < vp.rowCount; i++) {
      out.push(vp.firstRow + i);
    }
    return out;
  });

  return (
    <box
      ref={(el: BoxRenderable) => {
        boxRef = el;
        if (el.width > 0 && el.height > 0) {
          setBoxDims({ width: el.width, height: el.height });
        }
      }}
      onSizeChange={() => {
        if (boxRef && boxRef.width > 0 && boxRef.height > 0) {
          setBoxDims({ width: boxRef.width, height: boxRef.height });
        }
      }}
      flexGrow={1}
      width="100%"
      height="100%"
      flexDirection="column"
    >
      <box
        height={1}
        width="100%"
        flexShrink={0}
        flexDirection="row"
        backgroundColor={theme.color("backgroundElement")}
      >
        <For each={currentViewport().columns}>
          {(colIdx, idx) => {
            const col = () => props.result.columns[colIdx];
            const w = () => widths()[colIdx] ?? 1;
            const align = () => (numericCols()[colIdx] ? "right" : "left");
            const text = () => fit(printable(col()?.name ?? ""), w(), align());
            return (
              <>
                {idx() > 0 ? (
                  <text
                    fg={theme.color("textMuted")}
                    bg={theme.color("backgroundElement")}
                    flexShrink={0}
                  >
                    {" "}
                  </text>
                ) : null}
                <text
                  fg={theme.color("textMuted")}
                  bg={theme.color("backgroundElement")}
                  attributes={TextAttributes.BOLD}
                  flexShrink={0}
                >
                  {text()}
                </text>
              </>
            );
          }}
        </For>
      </box>

      <For each={visibleRowIndices()}>
        {(rowIdx) => (
          <box height={1} width="100%" flexShrink={0} flexDirection="row">
            <For each={currentViewport().columns}>
              {(colIdx, idx) => {
                const cell = () => props.result.rows[rowIdx]?.[colIdx] ?? null;
                const w = () => widths()[colIdx] ?? 1;
                const align = () => (numericCols()[colIdx] ? "right" : "left");
                const fitted = () => fitCell(cell(), w(), align());
                const cellBg = () => {
                  if (isCellFlashed(rowIdx, colIdx)) return theme.color("primary");
                  if (isCellSelected(rowIdx, colIdx)) return theme.color("selection");
                  return undefined;
                };
                const isNull = () => cell() === null;
                const isJsonObj = () => {
                  const c = cell();
                  return c !== null && typeof c === "object";
                };
                return (
                  <>
                    {idx() > 0 ? (
                      <text fg={rowTextFg()} flexShrink={0}>
                        {" "}
                      </text>
                    ) : null}
                    {isJsonObj() ? (
                      <box backgroundColor={cellBg()} flexShrink={0}>
                        <Highlighted language="json" text={fitted()} />
                      </box>
                    ) : (
                      <text
                        fg={isNull() ? theme.color("textMuted") : rowTextFg()}
                        bg={cellBg()}
                        flexShrink={0}
                      >
                        {isNull() ? fit(NULL_GLYPH, w(), align()) : fitted()}
                      </text>
                    )}
                  </>
                );
              }}
            </For>
          </box>
        )}
      </For>
    </box>
  );
}
