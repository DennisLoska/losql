import { type BoxRenderable, type OptimizedBuffer, RGBA, TextAttributes } from "@opentui/core";
import { createEffect, createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type { Cell } from "../../../core/db/types";
import { mix } from "../../../core/theme/color";
import { useTheme } from "../../context/theme";
import { toRGBA } from "../../theme-bridge";
import { Highlighted } from "../../ui/highlighted";
import { printable } from "../../ui/printable";
import {
  columnWidths,
  EDGE_MIN_WIDTH,
  fit,
  fitCell,
  type GridColumn,
  NULL_GLYPH,
  type Viewport,
  type ViewportSlot,
  viewport,
} from "./grid-model";

/** Cells drawn in the flash colour for a moment: whole rows (`column: null`) or one column of them. */
export interface FlashSpec {
  rows: Set<number>;
  column: number | null;
}

/**
 * A scrolling grid of plain columns and rows with a cell cursor, a row selection and a flash. It knows
 * nothing of where the rows come from. The header, its rule and every body row are drawn from the same
 * viewport slots, so separators line up. Unselected body cells are left unpainted.
 */
export function DataGrid(props: {
  columns: readonly GridColumn[];
  rows: readonly Cell[][];
  cursor: { row: number; column: number };
  selectedRows: { start: number; end: number } | null;
  flash: FlashSpec | null;
  /** How far the rows have faded in, from 0 (muted) to 1 (full text colour). */
  fadeT?: number;
  onViewport?: (vp: Viewport, boxHeight: number) => void;
}): JSX.Element {
  const theme = useTheme();

  let boxRef: BoxRenderable | null = null;
  const [boxDims, setBoxDims] = createSignal({ width: 80, height: 10 });
  let prevScroll = { firstRow: 0, firstColumn: 0 };

  const widths = createMemo(() => columnWidths({ columns: props.columns, rows: props.rows }));

  const dims = createMemo(() => {
    const d = boxDims();
    return {
      width: boxRef && boxRef.width > 0 ? boxRef.width : d.width,
      height: boxRef && boxRef.height > 0 ? boxRef.height : d.height,
    };
  });

  const currentViewport = createMemo<Viewport>(() => {
    const { width, height } = dims();
    const vp = viewport({
      widths: widths(),
      rows: props.rows.length,
      cursor: props.cursor,
      previous: prevScroll,
      width,
      height,
    });
    prevScroll = { firstRow: vp.firstRow, firstColumn: vp.firstColumn };
    return vp;
  });

  createEffect(() => {
    const vp = currentViewport();
    props.onViewport?.(vp, dims().height);
  });

  const edges = () => dims().width >= EDGE_MIN_WIDTH;
  const slotAt = (idx: number): ViewportSlot | undefined => currentViewport().slots[idx];
  const alignOf = (column: number): "left" | "right" => props.columns[column]?.align ?? "left";
  const pad = (slot: ViewportSlot | undefined) => " ".repeat(slot?.padding ?? 0);

  const rowTextFg = createMemo(() => {
    const t = props.fadeT ?? 1;
    if (t >= 1) return theme.color("text");
    const pal = theme.theme();
    return toRGBA(mix(pal.textMuted, pal.text, t));
  });

  const rowFlashed = (row: number) => {
    const f = props.flash;
    return f !== null && f.column === null && f.rows.has(row);
  };
  const rowSelected = (row: number) => {
    const sel = props.selectedRows;
    return sel !== null && row >= sel.start && row <= sel.end;
  };
  const cellFlashed = (row: number, col: number) => {
    const f = props.flash;
    return f !== null && f.rows.has(row) && (f.column === null || f.column === col);
  };
  const cellBg = (row: number, col: number) => {
    if (cellFlashed(row, col)) return theme.color("primary");
    if (rowSelected(row)) return theme.color("selection");
    if (props.selectedRows === null && props.cursor.row === row && props.cursor.column === col) {
      return theme.color("selection");
    }
    return undefined;
  };
  const rowBg = (row: number) => {
    if (rowFlashed(row)) return theme.color("primary");
    if (rowSelected(row)) return theme.color("selection");
    return undefined;
  };

  const visibleRowIndices = createMemo(() => {
    const vp = currentViewport();
    return Array.from({ length: vp.rowCount }, (_, i) => vp.firstRow + i);
  });

  const dividerText = createMemo(() => {
    const vp = currentViewport();
    const rule = vp.slots.map((slot) => "─".repeat(slot.valueWidth + 2 * slot.padding)).join("┼");
    return edges() ? ` ${rule}` : rule;
  });

  const Separator = (p: { bg?: RGBA }) => <Glyphs text="│" fg={theme.color("borderSubtle")} bg={p.bg} />;

  return (
    <box
      ref={(el: BoxRenderable) => {
        boxRef = el;
        if (el.width > 0 && el.height > 0) setBoxDims({ width: el.width, height: el.height });
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
        <Show when={edges()}>
          <text fg={theme.color("accent")} bg={theme.color("backgroundElement")} flexShrink={0}>
            {currentViewport().leftOverflow ? "‹" : " "}
          </text>
        </Show>
        <For each={currentViewport().columns}>
          {(colIdx, idx) => {
            const slot = () => slotAt(idx());
            const name = () =>
              fit(printable(props.columns[colIdx]?.name ?? ""), slot()?.valueWidth ?? 1, alignOf(colIdx));
            return (
              <>
                {idx() > 0 ? <Separator bg={theme.color("backgroundElement")} /> : null}
                <text
                  fg={theme.color("text")}
                  bg={theme.color("backgroundElement")}
                  attributes={TextAttributes.BOLD}
                  flexShrink={0}
                >
                  {pad(slot()) + name() + pad(slot())}
                </text>
              </>
            );
          }}
        </For>
        <Show when={edges()}>
          <box flexGrow={1} />
          <text fg={theme.color("accent")} bg={theme.color("backgroundElement")} flexShrink={0}>
            {currentViewport().rightOverflow ? "›" : " "}
          </text>
        </Show>
      </box>

      <Show when={currentViewport().divider}>
        <box height={1} width="100%" flexShrink={0} flexDirection="row">
          <Glyphs text={dividerText()} fg={theme.color("borderSubtle")} />
        </box>
      </Show>

      <For each={visibleRowIndices()}>
        {(rowIdx) => (
          <box height={1} width="100%" flexShrink={0} flexDirection="row" backgroundColor={rowBg(rowIdx)}>
            <Show when={edges()}>
              <text flexShrink={0}> </text>
            </Show>
            <For each={currentViewport().columns}>
              {(colIdx, idx) => {
                const slot = () => slotAt(idx());
                const width = () => slot()?.valueWidth ?? 1;
                const align = () => alignOf(colIdx);
                const cell = () => props.rows[rowIdx]?.[colIdx] ?? null;
                const bg = () => cellBg(rowIdx, colIdx);
                const isJson = () => {
                  const c = cell();
                  return c !== null && typeof c === "object";
                };
                const fg = () => {
                  const c = cell();
                  if (c === null) return theme.color("textMuted");
                  if (typeof c === "boolean") return theme.color("syntaxKeyword");
                  return rowTextFg();
                };
                const value = () => {
                  const c = cell();
                  return c === null ? fit(NULL_GLYPH, width(), align()) : fitCell(c, width(), align());
                };
                return (
                  <>
                    {idx() > 0 ? <Separator /> : null}
                    {isJson() ? (
                      <box backgroundColor={bg()} flexShrink={0}>
                        <Highlighted language="json" text={pad(slot()) + value() + pad(slot())} />
                      </box>
                    ) : (
                      <text fg={fg()} bg={bg()} flexShrink={0}>
                        {pad(slot()) + value() + pad(slot())}
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

const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0);

/**
 * Single-width glyphs (the grid's box-drawing lines) written straight into the cells, one per cell, over
 * whatever is painted below them: a text element would hand them to the grapheme pool instead.
 */
function Glyphs(props: { text: string; fg: RGBA; bg?: RGBA }): JSX.Element {
  const glyphs = createMemo(() => Array.from(props.text));
  const paint = createMemo(() => {
    const chars = glyphs();
    const fg = props.fg;
    const bg = props.bg ?? TRANSPARENT;
    return function (this: BoxRenderable, buffer: OptimizedBuffer) {
      for (let i = 0; i < chars.length; i++) buffer.setCellWithAlphaBlending(this.x + i, this.y, chars[i]!, fg, bg);
    };
  });
  return <box width={glyphs().length} height={1} flexShrink={0} renderAfter={paint()} />;
}
