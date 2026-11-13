import type { BoxRenderable } from "@opentui/core";
import { createMemo, createSignal, For, type JSX } from "solid-js";
import type { CompletionItem } from "../../../core/sql/complete";
import { useTheme } from "../../context/theme";
import { cellWidth, cutCells } from "../../ui/cells";
import { printable } from "../../ui/printable";

const MAX_VISIBLE_ITEMS = 8;
const MIN_POPUP_WIDTH = 24;
const MAX_POPUP_WIDTH = 60;

function truncateCells(text: string, maxCells: number): string {
  if (maxCells <= 0) return "";
  return cutCells(text, maxCells, { ellipsis: true });
}

function padSpaces(count: number): string {
  return count > 0 ? " ".repeat(count) : "";
}

interface FormattedPopupRow {
  leftText: string;
  rightText: string;
}

function formatPopupRow(
  rawLabel: string,
  rawMeta: string,
  popupWidth: number,
): FormattedPopupRow {
  if (popupWidth <= 0) {
    return { leftText: "", rightText: "" };
  }
  if (popupWidth === 1) {
    const clean = printable(rawLabel);
    return { leftText: truncateCells(clean, 1).padEnd(1, " "), rightText: "" };
  }
  const cleanLabel = printable(rawLabel);
  const cleanMeta = printable(rawMeta);
  const innerBudget = popupWidth - 2; // 1 leading space + 1 trailing space
  if (innerBudget <= 0) {
    return { leftText: padSpaces(popupWidth), rightText: "" };
  }

  const labelW = cellWidth(cleanLabel);
  const metaW = cellWidth(cleanMeta);

  if (metaW === 0) {
    const fittedLabel = truncateCells(cleanLabel, innerBudget);
    const usedLabel = cellWidth(fittedLabel);
    const pad = Math.max(0, innerBudget - usedLabel);
    return {
      leftText: ` ${fittedLabel}${padSpaces(pad + 1)}`,
      rightText: "",
    };
  }

  if (labelW + 2 + metaW <= innerBudget) {
    const gap = innerBudget - labelW - metaW;
    return {
      leftText: ` ${cleanLabel}${padSpaces(gap)}`,
      rightText: `${cleanMeta} `,
    };
  }

  const minLabel = Math.min(labelW, 4);
  if (minLabel + 2 + metaW <= innerBudget) {
    const labelBudget = innerBudget - 2 - metaW;
    const fittedLabel = truncateCells(cleanLabel, labelBudget);
    const usedLabel = cellWidth(fittedLabel);
    const gap = Math.max(2, innerBudget - usedLabel - metaW);
    return {
      leftText: ` ${fittedLabel}${padSpaces(gap)}`,
      rightText: `${cleanMeta} `,
    };
  }

  if (innerBudget < 4) {
    const fittedLabel = truncateCells(cleanLabel, innerBudget);
    const usedLabel = cellWidth(fittedLabel);
    const pad = Math.max(0, innerBudget - usedLabel);
    return {
      leftText: ` ${fittedLabel}${padSpaces(pad + 1)}`,
      rightText: "",
    };
  }

  const labelBudget = Math.max(
    1,
    Math.min(labelW, Math.max(4, Math.ceil((innerBudget - 2) * 0.6))),
  );
  const fittedLabel = truncateCells(cleanLabel, labelBudget);
  const usedLabel = cellWidth(fittedLabel);
  const metaBudget = Math.max(0, innerBudget - usedLabel - 2);
  if (metaBudget === 0) {
    const onlyLabel = truncateCells(cleanLabel, innerBudget);
    const usedOnly = cellWidth(onlyLabel);
    const pad = Math.max(0, innerBudget - usedOnly);
    return {
      leftText: ` ${onlyLabel}${padSpaces(pad + 1)}`,
      rightText: "",
    };
  }
  const fittedMeta = truncateCells(cleanMeta, metaBudget);
  const usedMeta = cellWidth(fittedMeta);
  const gap = Math.max(2, innerBudget - usedLabel - usedMeta);
  return {
    leftText: ` ${fittedLabel}${padSpaces(gap)}`,
    rightText: `${fittedMeta} `,
  };
}

export function computePopupWidth(
  items: readonly CompletionItem[],
  maxAvailableWidth?: number,
): number {
  let longest = 0;
  for (const item of items) {
    const labelW = cellWidth(printable(item.label));
    const metaText = item.detail ?? item.kind;
    const metaW = cellWidth(printable(metaText));
    const rowWidth = 1 + labelW + (metaW > 0 ? 2 + metaW : 0) + 1;
    if (rowWidth > longest) {
      longest = rowWidth;
    }
  }
  const desired = Math.max(MIN_POPUP_WIDTH, Math.min(MAX_POPUP_WIDTH, longest));
  if (maxAvailableWidth !== undefined && maxAvailableWidth > 0) {
    return Math.max(1, Math.min(desired, maxAvailableWidth));
  }
  return desired;
}

/** Where the popup is drawn, in screen cells, and which items it shows. */
export interface PopupPlacement {
  left: number;
  top: number;
  width: number;
  /** Rows shown: one item per row. */
  rows: number;
  /** Index of the first item shown. */
  first: number;
}

/**
 * The one rule for the popup's position, size and scroll window (pure).
 *
 * The popup never covers the cursor's row. It shows up to 8 items: below the
 * cursor's row when they fit there inside the editor area, else above it inside
 * the area, else below or above it inside the terminal. When the whole popup
 * fits on neither side, it shows as many rows as fit on the larger free side
 * (below on a tie), at least one; when neither side has a free row, there is no
 * popup (null). Horizontally it starts at `anchorCol`, moved left to stay inside
 * the area and then the terminal. The items shown scroll with the selection:
 * `previousFirst` is kept while the selected item stays in view.
 */
export function placePopup(input: {
  /** Screen row of the cursor. */
  cursorRow: number;
  /** Screen column where the popup wants to start (the start of the word). */
  anchorCol: number;
  itemCount: number;
  selected: number;
  previousFirst: number;
  /** Width wanted, in cells (see `computePopupWidth`). */
  width: number;
  terminal: { width: number; height: number };
  /** The editor area on screen, end-exclusive. */
  area: { top: number; bottom: number; left: number; right: number };
}): PopupPlacement | null {
  const termW = input.terminal.width;
  const termH = input.terminal.height;
  if (termW <= 0 || termH <= 0 || input.itemCount <= 0) return null;

  const wanted = Math.min(MAX_VISIBLE_ITEMS, input.itemCount);
  const belowStart = Math.max(0, input.cursorRow + 1);
  const aboveEnd = Math.min(termH, input.cursorRow);
  const freeBelow = Math.max(0, termH - belowStart);
  const freeAbove = Math.max(0, aboveEnd);
  const areaTop = Math.max(0, input.area.top);
  const areaBottom = Math.min(termH, input.area.bottom);

  let top: number;
  let rows: number;
  if (freeBelow >= wanted && belowStart + wanted <= areaBottom) {
    top = belowStart;
    rows = wanted;
  } else if (freeAbove >= wanted && aboveEnd - wanted >= areaTop) {
    top = aboveEnd - wanted;
    rows = wanted;
  } else if (freeBelow >= wanted) {
    top = belowStart;
    rows = wanted;
  } else if (freeAbove >= wanted) {
    top = aboveEnd - wanted;
    rows = wanted;
  } else if (freeBelow > 0 && freeBelow >= freeAbove) {
    top = belowStart;
    rows = freeBelow;
  } else if (freeAbove > 0) {
    top = 0;
    rows = freeAbove;
  } else {
    return null;
  }

  const width = Math.max(1, Math.min(input.width, termW));
  const areaLeft = Math.max(0, input.area.left);
  const areaRight = Math.min(termW, input.area.right);
  const inArea = Math.max(areaLeft, Math.min(input.anchorCol, Math.max(areaLeft, areaRight - width)));
  const left = Math.max(0, Math.min(inArea, termW - width));

  const lastFirst = input.itemCount - rows;
  const selected = Math.max(0, Math.min(input.itemCount - 1, input.selected));
  let first = Math.max(0, Math.min(lastFirst, input.previousFirst));
  if (selected < first) {
    first = selected;
  } else if (selected >= first + rows) {
    first = selected - rows + 1;
  }
  return { left, top, width, rows, first };
}

/**
 * `placePopup` inside the editor area of the screen (pure): the popup's rows lie inside `area`
 * (clipped to the terminal), so that nothing drawn below the area (the Results Pane) covers them;
 * its columns are placed as by `placePopup`. The area's rows are given to `placePopup` as the
 * terminal's rows, relative to the area's top, and the placement is moved back to screen rows;
 * every decision about position, size and scrolling stays with `placePopup`.
 */
export function placePopupInBox(input: Parameters<typeof placePopup>[0]): PopupPlacement | null {
  const top = Math.max(0, input.area.top);
  const bottom = Math.min(input.terminal.height, input.area.bottom);
  const height = bottom - top;
  if (height <= 0) return null;
  const local = placePopup({
    ...input,
    cursorRow: input.cursorRow - top,
    terminal: { width: input.terminal.width, height },
    area: { ...input.area, top: 0, bottom: height },
  });
  return local && { ...local, top: local.top + top };
}

/** Draws the popup where `placement` says; it does not place or clamp anything itself. */
export function CompletionPopup(props: {
  items: CompletionItem[];
  selected: number;
  placement: PopupPlacement;
}): JSX.Element {
  const theme = useTheme();
  const [parentOffset, setParentOffset] = createSignal<{ x: number; y: number }>({ x: 0, y: 0 });
  let popupRef: BoxRenderable | null = null;

  const syncParentOffset = (el: BoxRenderable | null) => {
    const p = el?.parent;
    const px = p && "x" in p && typeof p.x === "number" ? Math.trunc(p.x) : 0;
    const py = p && "y" in p && typeof p.y === "number" ? Math.trunc(p.y) : 0;
    const cur = parentOffset();
    if (cur.x !== px || cur.y !== py) {
      setParentOffset({ x: px, y: py });
    }
  };

  const visibleItems = createMemo(() => {
    const { first, rows } = props.placement;
    return props.items.slice(first, first + rows);
  });

  const popupWidth = () => props.placement.width;

  // Screen cells to the parent's coordinates.
  const localLeft = createMemo(() => {
    syncParentOffset(popupRef);
    return props.placement.left - parentOffset().x;
  });

  const localTop = createMemo(() => {
    syncParentOffset(popupRef);
    return props.placement.top - parentOffset().y;
  });

  return (
    <box
      ref={(el: BoxRenderable) => {
        popupRef = el;
        syncParentOffset(el);
      }}
      onSizeChange={() => {
        syncParentOffset(popupRef);
      }}
      position="absolute"
      left={localLeft()}
      top={localTop()}
      width={popupWidth()}
      height={visibleItems().length}
      zIndex={60}
      flexDirection="column"
      backgroundColor={theme.color("overlayBackground")}
    >
      <For each={visibleItems()}>
        {(item, idx) => {
          const isSelected = () => props.placement.first + idx() === props.selected;
          const rowBg = () =>
            isSelected() ? theme.color("selection") : theme.color("overlayBackground");
          const formatted = createMemo(() =>
            formatPopupRow(item.label, item.detail ?? item.kind, popupWidth()),
          );

          return (
            <box
              height={1}
              width={popupWidth()}
              flexShrink={0}
              flexDirection="row"
              backgroundColor={rowBg()}
            >
              <text fg={theme.color("text")} bg={rowBg()} flexShrink={0}>
                {formatted().leftText}
              </text>
              {formatted().rightText.length > 0 && (
                <text fg={theme.color("textMuted")} bg={rowBg()} flexShrink={0}>
                  {formatted().rightText}
                </text>
              )}
            </box>
          );
        }}
      </For>
    </box>
  );
}
