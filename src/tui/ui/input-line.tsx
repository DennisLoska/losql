import { type BoxRenderable, TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal, type JSX, Show } from "solid-js";
import { useTheme } from "../context/theme";
import { cellWidth } from "./cells";
import { clampToGraphemeBoundary, type LineInput, segmentGraphemes } from "./line-input";
import { printable } from "./printable";

interface DisplayItem {
  glyph: string;
  width: number;
  isCursor: boolean;
}

export function InputLine(props: {
  input: LineInput;
  prefix?: string;
  placeholder?: string;
  mask?: boolean;
  active?: boolean;
  width?: number;
}): JSX.Element {
  const theme = useTheme();
  const dimensions = useTerminalDimensions();
  const [measuredWidth, setMeasuredWidth] = createSignal(0);
  let scrollOffset = 0;
  let lastCursorIdx = 0;
  let movingLeft = false;

  const active = () => props.active !== false;
  const cleanPrefix = () => (props.prefix ? printable(props.prefix) : undefined);
  const cleanPlaceholder = () => (props.placeholder ? printable(props.placeholder) : undefined);

  const availableWidth = createMemo(() => {
    const p = cleanPrefix();
    const prefixW = p ? cellWidth(p) : 0;
    const boxW = props.width ?? (measuredWidth() > 0 ? measuredWidth() : dimensions().width);
    return Math.max(1, boxW - prefixW);
  });

  const windowed = createMemo(() => {
    const raw = props.input.text();
    if (raw.length === 0) {
      scrollOffset = 0;
      lastCursorIdx = 0;
      movingLeft = false;
      return null;
    }

    const segments = segmentGraphemes(raw);
    const clampedCursor = clampToGraphemeBoundary(raw, props.input.cursor());
    const isActive = active();

    let cursorIdx = segments.length;
    if (clampedCursor < raw.length) {
      const found = segments.findIndex((seg) => seg.index === clampedCursor);
      cursorIdx = found >= 0 ? found : segments.length;
    }

    if (cursorIdx < lastCursorIdx) {
      movingLeft = true;
    } else if (cursorIdx > lastCursorIdx) {
      movingLeft = false;
    }
    lastCursorIdx = cursorIdx;

    const items: DisplayItem[] = segments.map((seg, idx) => {
      const glyph = props.mask ? "•" : printable(seg.segment);
      return {
        glyph,
        width: Math.max(1, cellWidth(glyph)),
        isCursor: isActive && idx === cursorIdx,
      };
    });

    if (isActive && cursorIdx === segments.length) {
      items.push({
        glyph: " ",
        width: 1,
        isCursor: true,
      });
    }

    const W = availableWidth();
    const M = items.length;
    const textCount = segments.length;
    let totalWidth = 0;
    for (let i = 0; i < M; i++) {
      totalWidth += items[i]!.width;
    }

    let start = 0;
    let end = M;
    let showLeftMarker = false;
    let showRightMarker = false;

    if (totalWidth <= W) {
      scrollOffset = 0;
    } else if (!isActive) {
      start = 0;
      const budget = Math.max(1, W - 1);
      let w = 0;
      let e = 0;
      while (e < M && (w + items[e]!.width <= budget || e === 0)) {
        w += items[e]!.width;
        e++;
      }
      end = e;
      showRightMarker = end < textCount && w + 1 <= W;
    } else {
      const computeEnd = (s: number): number => {
        const leftCost = s > 0 ? 1 : 0;
        let remWidth = 0;
        for (let i = s; i < M; i++) {
          remWidth += items[i]!.width;
        }
        if (leftCost + remWidth <= W) {
          return M;
        }
        const rightCost = 1;
        const budget = W - leftCost - rightCost;
        let w = 0;
        let e = s;
        while (e < M && (w + items[e]!.width <= budget || e === s)) {
          w += items[e]!.width;
          e++;
        }
        return e;
      };

      const spanFits = (s: number, e: number): boolean => {
        const lCost = s > 0 ? 1 : 0;
        const rCost = e < textCount ? 1 : 0;
        let w = 0;
        for (let i = s; i < e; i++) {
          w += items[i]!.width;
        }
        return lCost + w + rCost <= W;
      };

      start = Math.max(0, Math.min(scrollOffset, cursorIdx));
      end = computeEnd(start);
      while ((cursorIdx >= end || !spanFits(start, end)) && start < cursorIdx) {
        start++;
        end = computeEnd(start);
      }
      while (end === M && start > 0 && computeEnd(start - 1) === M && spanFits(start - 1, M)) {
        start--;
      }

      const leftCut = start > 0;
      const rightCut = end < textCount;
      let visW = 0;
      for (let i = start; i < end; i++) {
        visW += items[i]!.width;
      }

      showLeftMarker = leftCut;
      showRightMarker = rightCut;

      while (
        (showLeftMarker ? 1 : 0) + visW + (showRightMarker ? 1 : 0) > W &&
        (showLeftMarker || showRightMarker)
      ) {
        if (showLeftMarker && showRightMarker) {
          // Drop the marker on the side away from the typing/movement direction first
          if (movingLeft) {
            showRightMarker = false;
          } else {
            showLeftMarker = false;
          }
        } else if (showLeftMarker) {
          showLeftMarker = false;
        } else {
          showRightMarker = false;
        }
      }

      scrollOffset = start;
    }

    const visible = items.slice(start, end);
    const localCursorIdx = visible.findIndex((it) => it.isCursor);

    if (localCursorIdx < 0) {
      const text =
        (showLeftMarker ? "…" : "") +
        visible.map((it) => it.glyph).join("") +
        (showRightMarker ? "…" : "");
      return { before: text, cursor: null as string | null, after: "" };
    }

    const before =
      (showLeftMarker ? "…" : "") +
      visible
        .slice(0, localCursorIdx)
        .map((it) => it.glyph)
        .join("");
    const cursor = visible[localCursorIdx]!.glyph;
    const after =
      visible
        .slice(localCursorIdx + 1)
        .map((it) => it.glyph)
        .join("") + (showRightMarker ? "…" : "");

    return { before, cursor, after };
  });

  const placeholderParts = createMemo(() => {
    const p = cleanPlaceholder();
    if (!p || p.length === 0) return null;
    const segs = segmentGraphemes(p);
    if (segs.length === 0) return null;
    return {
      first: segs[0]!.segment,
      rest: p.slice(segs[0]!.end),
    };
  });

  return (
    <box
      flexDirection="row"
      width="100%"
      height={1}
      flexShrink={0}
      ref={(el: BoxRenderable) => {
        if (el.width > 0) setMeasuredWidth(el.width);
      }}
      onSizeChange={function (this: BoxRenderable) {
        if (this.width > 0) setMeasuredWidth(this.width);
      }}
    >
      <Show when={cleanPrefix()}>
        <text fg={theme.color("primary")} flexShrink={0}>
          {cleanPrefix()}
        </text>
      </Show>
      <Show
        when={windowed()}
        fallback={
          <text>
            <Show
              when={placeholderParts()}
              fallback={
                <Show when={active()}>
                  <span style={{ fg: theme.color("text"), attributes: TextAttributes.INVERSE }}>
                    {" "}
                  </span>
                </Show>
              }
            >
              <Show
                when={active()}
                fallback={<span style={{ fg: theme.color("textMuted") }}>{cleanPlaceholder()}</span>}
              >
                <span style={{ fg: theme.color("textMuted"), attributes: TextAttributes.INVERSE }}>
                  {placeholderParts()!.first}
                </span>
                <span style={{ fg: theme.color("textMuted") }}>
                  {placeholderParts()!.rest}
                </span>
              </Show>
            </Show>
          </text>
        }
      >
        <text fg={theme.color("text")}>
          <span>{windowed()!.before}</span>
          <Show when={windowed()!.cursor !== null}>
            <span style={{ attributes: TextAttributes.INVERSE }}>
              {windowed()!.cursor}
            </span>
            <span>{windowed()!.after}</span>
          </Show>
        </text>
      </Show>
    </box>
  );
}


