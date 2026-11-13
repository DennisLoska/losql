import { type BoxRenderable, TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, type JSX, on, Show } from "solid-js";
import { fuzzyFilter } from "../../core/fuzzy";
import { type Key, parseKeys } from "../../core/vim/keys";
import { useLayer } from "../context/keys";
import { useTheme } from "../context/theme";
import { cellWidth, cutCells, graphemes } from "./cells";
import { InputLine } from "./input-line";
import { createLineInput } from "./line-input";
import { printable } from "./printable";

/**
 * An option in a `DialogSelect` list. Option `value`s are unique by contract and
 * are used to identify options across dynamic updates.
 */
export interface SelectOption<T> {
  title: string;
  value: T;
  description?: string;
  hint?: string;
  category?: string;
  disabled?: boolean;
}

export interface SelectAction<T> {
  key: string;
  label: string | (() => string);
  run: (option: SelectOption<T>) => void;
}

export interface SelectProps<T> {
  title: string;
  description?: string;
  notice?: { text: string; kind: "info" | "error" } | null;
  options: SelectOption<T>[];
  custom?: (text: string) => SelectOption<T>;
  placeholder?: string;
  current?: T;
  empty?: string;
  actions?: SelectAction<T>[];
  onMove?: (option: SelectOption<T> | null) => void;
}

type SelectRow<T> =
  | { kind: "heading"; category: string }
  | { kind: "option"; option: SelectOption<T>; optionIndex: number };

function keysEqual(a: Key, b: Key): boolean {
  return (
    a.name === b.name &&
    Boolean(a.ctrl) === Boolean(b.ctrl) &&
    Boolean(a.meta) === Boolean(b.meta) &&
    Boolean(a.shift) === Boolean(b.shift)
  );
}

function formatKeyLabel(notation: string): string {
  const keys = parseKeys(notation);
  return keys
    .map((k) => {
      const parts: string[] = [];
      if (k.ctrl) parts.push("ctrl");
      if (k.meta) parts.push("alt");
      if (k.shift && (k.name.length > 1 || k.ctrl || k.meta)) parts.push("shift");
      parts.push(k.name);
      return parts.join("+");
    })
    .join(" ");
}

function truncateEnd(text: string, maxCells: number): { text: string; width: number } {
  if (maxCells <= 0 || text.length === 0) return { text: "", width: 0 };
  const cut = cutCells(text, maxCells, { ellipsis: true });
  return { text: cut, width: cellWidth(cut) };
}

function formatOptionRow<T>(
  option: SelectOption<T>,
  rowWidth: number,
): { title: string; description: string; hint: string } {
  const W = Math.max(1, rowWidth);
  const rawTitle = printable(option.title);
  const rawDesc = option.description !== undefined ? printable(option.description) : "";
  const rawHint = option.hint !== undefined ? printable(option.hint) : "";

  const availAfterMarker = Math.max(0, W - 2);
  const titleFullW = cellWidth(rawTitle);
  const fittedTitle =
    titleFullW <= availAfterMarker
      ? { text: rawTitle, width: titleFullW }
      : truncateEnd(rawTitle, availAfterMarker);

  const hintFullW = rawHint.length > 0 ? cellWidth(rawHint) : 0;
  const showHint = hintFullW > 0 && 2 + titleFullW + 1 + hintFullW <= W;
  const hint = showHint ? rawHint : "";
  const hintW = showHint ? hintFullW : 0;

  const descBudget = W - (2 + fittedTitle.width) - 1 - (showHint ? 1 + hintW : 0);
  let description = "";
  if (rawDesc.length > 0 && descBudget >= 4) {
    description = truncateEnd(rawDesc, descBudget).text;
  }

  return {
    title: fittedTitle.text,
    description,
    hint,
  };
}

/** Cuts `text` to at most `width` cells and ends it with `…`. */
function cutWithEllipsis(text: string, width: number): string {
  if (width <= 1) return "…";
  return `${cutCells(text, width - 1)}…`;
}

/** Word-wraps one line into `out`, stopping at `maxRows` rows; false when the line did not fit. */
function wrapLine(line: string, width: number, out: string[], maxRows: number): boolean {
  if (out.length >= maxRows) return false;
  if (cellWidth(line) <= width) {
    out.push(line);
    return true;
  }
  const segs = Array.from(graphemes.segment(line), (s) => s.segment);
  let i = 0;
  while (i < segs.length) {
    if (out.length >= maxRows) return false;
    let used = 0;
    let j = i;
    let lastSpace = -1;
    while (j < segs.length) {
      const sw = cellWidth(segs[j]!);
      if (used + sw > width) break;
      if (segs[j] === " ") lastSpace = j;
      used += sw;
      j++;
    }
    if (j >= segs.length) {
      out.push(segs.slice(i).join("").trimEnd());
      return true;
    }
    let end: number;
    let next: number;
    if (j === i) {
      end = i + 1;
      next = i + 1;
    } else if (segs[j] === " ") {
      end = j;
      next = j + 1;
    } else if (lastSpace > i) {
      end = lastSpace;
      next = lastSpace + 1;
    } else {
      end = j;
      next = j;
    }
    out.push(segs.slice(i, end).join("").trimEnd());
    i = next;
    while (i < segs.length && segs[i] === " ") i++;
  }
  return true;
}

interface WrappedText {
  rows: string[];
  /** There is text after the last row. */
  more: boolean;
}

/**
 * Word-wraps `rawText` (newlines kept) into at most `maxRows` rows of `width` cells. Only a prefix
 * of the text that can fill those rows is cleaned and measured, so the work is bounded by the size
 * of the area, never by the length of the text.
 */
function wrapText(rawText: string, width: number, maxRows: number): WrappedText {
  const w = Math.max(1, width);
  if (rawText.length === 0) return { rows: [], more: false };
  if (maxRows <= 0) return { rows: [], more: true };
  const limit = (maxRows + 1) * (w + 1) * 4;
  let more = rawText.length > limit;
  let text = more ? rawText.slice(0, limit) : rawText;
  if (more && /[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
  const lines = printable(text, { keepNewlines: true }).split("\n");
  if (!more) {
    while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  }
  const rows: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!wrapLine(lines[i]!, w, rows, maxRows) || (rows.length >= maxRows && i < lines.length - 1)) {
      more = true;
      break;
    }
  }
  return { rows, more };
}

/** The first `count` rows of `wrapped`; the last one ends with `…` when text is left out. */
function fitRows(wrapped: WrappedText, count: number, width: number): string[] {
  if (count <= 0) return [];
  const shown = wrapped.rows.slice(0, count);
  if (shown.length > 0 && (shown.length < wrapped.rows.length || wrapped.more)) {
    shown[shown.length - 1] = cutWithEllipsis(shown[shown.length - 1]!, Math.max(1, width));
  }
  return shown;
}

/** A notice takes at most this many rows. */
const NOTICE_MAX_ROWS = 4;
/** More rows than this of a description are never needed (descriptions are short texts). */
const DESCRIPTION_MAX_ROWS = 200;
/** The panel's padding, the title row, the filter row and the gaps around the filter. */
const FIXED_ROWS = 6;

export function DialogSelect<T>(
  props: SelectProps<T> & {
    onSelect: (option: SelectOption<T>) => void;
    /** The width the dialog was opened with (`dialog.open`'s `width`, 60 when not given). */
    panelWidth?: number;
  },
): JSX.Element {
  const theme = useTheme();
  const dimensions = useTerminalDimensions();
  const filterInput = createLineInput();
  const [measuredWidth, setMeasuredWidth] = createSignal(0);

  // Until the first measurement arrives, the content width follows from the dialog's width and
  // its padding, so the first frame already draws the rows the next frames draw.
  const rowWidth = createMemo(() => {
    const w = measuredWidth();
    if (w > 0) return w;
    const panelWidth = Math.max(10, Math.min(props.panelWidth ?? 60, dimensions().width - 4));
    return Math.max(1, panelWidth - 4);
  });

  const effectiveOptions = createMemo<SelectOption<T>[]>(() => {
    const query = filterInput.text();
    const base =
      query.length === 0
        ? [...props.options]
        : fuzzyFilter(query, props.options, (opt) => opt.title);
    if (
      props.custom &&
      query.length > 0 &&
      !props.options.some((opt) => opt.title === query)
    ) {
      base.push(props.custom(query));
    }
    return base;
  });

  const rows = createMemo<SelectRow<T>[]>(() => {
    const query = filterInput.text();
    const opts = effectiveOptions();
    if (query.length > 0) {
      return opts.map((option, optionIndex) => ({
        kind: "option" as const,
        option,
        optionIndex,
      }));
    }

    const categories: string[] = [];
    const grouped = new Map<string, Array<{ option: SelectOption<T>; origIdx: number }>>();
    for (let i = 0; i < opts.length; i++) {
      const opt = opts[i]!;
      const cat = opt.category ?? "";
      if (!grouped.has(cat)) {
        categories.push(cat);
        grouped.set(cat, []);
      }
      grouped.get(cat)!.push({ option: opt, origIdx: i });
    }

    const result: SelectRow<T>[] = [];
    let optionIndex = 0;
    for (const cat of categories) {
      if (cat !== "") {
        result.push({ kind: "heading", category: cat });
      }
      for (const item of grouped.get(cat)!) {
        result.push({
          kind: "option",
          option: item.option,
          optionIndex: optionIndex++,
        });
      }
    }
    return result;
  });

  const orderedOptions = createMemo<SelectOption<T>[]>(() => {
    const result: SelectOption<T>[] = [];
    for (const r of rows()) {
      if (r.kind === "option") {
        result.push(r.option);
      }
    }
    return result;
  });

  const findInitialIndex = (): number => {
    const opts = orderedOptions();
    if (props.current !== undefined) {
      const idx = opts.findIndex((o) => !o.disabled && o.value === props.current);
      if (idx >= 0) return idx;
    }
    const firstEnabled = opts.findIndex((o) => !o.disabled);
    return firstEnabled >= 0 ? firstEnabled : -1;
  };

  const initialIdx = findInitialIndex();
  const [selectedIndex, setSelectedIndex] = createSignal<number>(initialIdx);
  const [scrollTop, setScrollTop] = createSignal<number>(0);
  let lastSelected: SelectOption<T> | null =
    initialIdx >= 0 && initialIdx < orderedOptions().length
      ? orderedOptions()[initialIdx]!
      : null;
  let lastFilterText = filterInput.text();

  const wrappedNotice = createMemo<WrappedText>(() =>
    props.notice ? wrapText(props.notice.text, rowWidth(), NOTICE_MAX_ROWS) : { rows: [], more: false },
  );
  const wrappedDescription = createMemo<WrappedText>(() =>
    props.description
      ? wrapText(props.description, rowWidth(), DESCRIPTION_MAX_ROWS)
      : { rows: [], more: false },
  );

  /**
   * How many rows the description, the notice and the list get. A notice never takes the list
   * below min(options, 3) rows: when the terminal is small the notice gives way first (down to
   * one row, then none), then the description; the title, the filter and the action hints keep
   * their rows. Without a notice the list keeps the size it always had.
   */
  const layout = createMemo(() => {
    const h = dimensions().height;
    const fixed = FIXED_ROWS + ((props.actions?.length ?? 0) > 0 ? 2 : 0);
    const noticeNeed = wrappedNotice().rows.length;
    const descNeed = wrappedDescription().rows.length;
    const optionCount = orderedOptions().length;
    if (noticeNeed === 0) {
      const list = Math.max(1, Math.min(12, h - 12));
      const listShown = Math.max(1, Math.min(rows().length, list));
      const descRows = Math.max(0, Math.min(descNeed, h - fixed - listShown));
      return { list, descRows, noticeRows: 0 };
    }
    const minList = Math.max(1, Math.min(optionCount, 3));
    const avail = h - fixed - minList;
    const descRows = Math.max(0, Math.min(descNeed, avail - 1));
    const noticeRows = Math.max(0, Math.min(noticeNeed, avail - descRows));
    const list = Math.max(minList, Math.min(12, h - fixed - descRows - noticeRows - 2));
    return { list, descRows, noticeRows };
  });

  const descriptionLines = createMemo(() =>
    fitRows(wrappedDescription(), layout().descRows, rowWidth()),
  );
  const noticeLines = createMemo(() => fitRows(wrappedNotice(), layout().noticeRows, rowWidth()));

  const maxRows = createMemo(() => layout().list);

  const ensureVisible = (optIdx: number) => {
    const rList = rows();
    const max = maxRows();
    if (optIdx < 0 || rList.length <= max) {
      setScrollTop(0);
      return;
    }
    const rowIdx = rList.findIndex((r) => r.kind === "option" && r.optionIndex === optIdx);
    if (rowIdx < 0) return;

    let top = scrollTop();
    if (rowIdx < top) {
      top = rowIdx;
      // Also include immediately preceding heading if we scrolled to the first item of a category
      if (top > 0 && rList[top - 1]?.kind === "heading") {
        top--;
      }
    } else if (rowIdx >= top + max) {
      top = rowIdx - max + 1;
    }
    top = Math.max(0, Math.min(top, rList.length - max));
    setScrollTop(top);
  };

  // Ensure initial selection is visible
  createEffect(() => {
    ensureVisible(selectedIndex());
  });

  const sameOption = (a: SelectOption<T> | null, b: SelectOption<T> | null): boolean => {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.value === b.value;
  };

  // When options change dynamically while filter has not changed, keep selection on same value or fall back to first enabled
  createEffect(
    on(
      orderedOptions,
      (opts) => {
        const currentFilter = filterInput.text();
        if (currentFilter !== lastFilterText) {
          lastFilterText = currentFilter;
          return;
        }
        const prev = lastSelected;
        const keepIdx =
          prev !== null
            ? opts.findIndex((o) => !o.disabled && o.value === prev.value)
            : -1;
        if (keepIdx >= 0) {
          lastSelected = opts[keepIdx]!;
          setSelectedIndex(keepIdx);
          ensureVisible(keepIdx);
          return;
        }
        const nextIdx = opts.findIndex((o) => !o.disabled);
        const next = nextIdx >= 0 ? opts[nextIdx]! : null;
        lastSelected = next;
        setSelectedIndex(nextIdx);
        ensureVisible(nextIdx);
        if (!sameOption(prev, next)) {
          props.onMove?.(next);
        }
      },
      { defer: true },
    ),
  );

  const selectedOption = createMemo<SelectOption<T> | null>(() => {
    const idx = selectedIndex();
    const opts = orderedOptions();
    return idx >= 0 && idx < opts.length ? opts[idx]! : null;
  });

  const moveSelection = (delta: 1 | -1) => {
    const opts = orderedOptions();
    const enabledCount = opts.filter((o) => !o.disabled).length;
    if (enabledCount === 0) return;

    const prev = lastSelected;
    let idx = selectedIndex();
    if (idx < 0 || idx >= opts.length) {
      idx = delta > 0 ? -1 : 0;
    }

    for (let step = 0; step < opts.length; step++) {
      idx = (idx + delta + opts.length) % opts.length;
      if (!opts[idx]!.disabled) {
        const next = opts[idx]!;
        lastSelected = next;
        setSelectedIndex(idx);
        ensureVisible(idx);
        if (!sameOption(prev, next)) {
          props.onMove?.(next);
        }
        return;
      }
    }
  };

  const resetToFirstEnabled = () => {
    const prev = lastSelected;
    const opts = orderedOptions();
    const first = opts.findIndex((o) => !o.disabled);
    const next = first >= 0 ? opts[first]! : null;
    lastSelected = next;
    lastFilterText = filterInput.text();
    setSelectedIndex(first);
    setScrollTop(0);
    ensureVisible(first);
    if (!sameOption(prev, next)) {
      props.onMove?.(next);
    }
  };

  const parsedActions = createMemo(() =>
    (props.actions ?? []).map((action) => ({
      action,
      key: parseKeys(action.key)[0],
      keyLabel: formatKeyLabel(action.key),
    })),
  );

  useLayer(
    (key) => {
      if ((key.ctrl && !key.meta && key.name === "n") || (!key.ctrl && !key.meta && key.name === "down")) {
        moveSelection(1);
        return true;
      }
      if ((key.ctrl && !key.meta && key.name === "p") || (!key.ctrl && !key.meta && key.name === "up")) {
        moveSelection(-1);
        return true;
      }
      if (!key.ctrl && !key.meta && key.name === "enter") {
        const opt = selectedOption();
        if (opt && !opt.disabled) {
          props.onSelect(opt);
        }
        return true;
      }

      for (const item of parsedActions()) {
        if (item.key && keysEqual(key, item.key)) {
          const opt = selectedOption();
          if (opt && !opt.disabled) {
            item.action.run(opt);
          }
          return true;
        }
      }

      const beforeText = filterInput.text();
      const handled = filterInput.feed(key);
      if (handled && filterInput.text() !== beforeText) {
        resetToFirstEnabled();
      }
      return handled;
    },
    {
      onPaste(text) {
        const beforeText = filterInput.text();
        filterInput.paste(text);
        if (filterInput.text() !== beforeText) {
          resetToFirstEnabled();
        }
      },
    },
  );



  const visibleRows = createMemo(() => {
    const rList = rows();
    const top = scrollTop();
    return rList.slice(top, top + maxRows());
  });

  return (
    <box
      flexDirection="column"
      width="100%"
      gap={1}
      ref={(el: BoxRenderable) => {
        if (el.width > 0) setMeasuredWidth(el.width);
      }}
      onSizeChange={function (this: BoxRenderable) {
        if (this.width > 0) setMeasuredWidth(this.width);
      }}
    >
      <box flexDirection="column" width="100%">
        <box flexDirection="row" justifyContent="space-between" width="100%">
          <text fg={theme.color("text")} attributes={TextAttributes.BOLD}>
            {printable(props.title)}
          </text>
          <text fg={theme.color("textMuted")}>esc</text>
        </box>
        <For each={descriptionLines()}>
          {(line) => (
            <text fg={theme.color("textMuted")} wrapMode="none">
              {line}
            </text>
          )}
        </For>
        <For each={noticeLines()}>
          {(line) => (
            <text
              fg={props.notice?.kind === "error" ? theme.color("error") : theme.color("textMuted")}
              wrapMode="none"
            >
              {line}
            </text>
          )}
        </For>
      </box>

      <InputLine
        input={filterInput}
        prefix="> "
        placeholder={props.placeholder ?? "Type to filter"}
      />

      <box flexDirection="column" width="100%">
        <Show
          when={orderedOptions().length > 0}
          fallback={
            <text fg={theme.color("textMuted")}>{printable(props.empty ?? "No results")}</text>
          }
        >
          <For each={visibleRows()}>
            {(row) => (
              <Show
                when={row.kind === "option"}
                fallback={
                  <text fg={theme.color("accent")} attributes={TextAttributes.BOLD} wrapMode="none">
                    {truncateEnd(printable((row as { kind: "heading"; category: string }).category), rowWidth()).text}
                  </text>
                }
              >
                {(() => {
                  const optRow = row as {
                    kind: "option";
                    option: SelectOption<T>;
                    optionIndex: number;
                  };
                  const isSelected = () => selectedIndex() === optRow.optionIndex;
                  const isCurrent = () =>
                    props.current !== undefined && optRow.option.value === props.current;
                  const rowBg = () =>
                    isSelected()
                      ? theme.color("selection")
                      : theme.color("overlayBackground");
                  const titleFg = () =>
                    optRow.option.disabled
                      ? theme.color("textMuted")
                      : theme.color("text");
                  const formatted = createMemo(() =>
                    formatOptionRow(optRow.option, rowWidth()),
                  );

                  return (
                    <box
                      flexDirection="row"
                      justifyContent="space-between"
                      width="100%"
                      height={1}
                      backgroundColor={rowBg()}
                    >
                      <box flexDirection="row" gap={1} flexShrink={0}>
                        <text
                          fg={isCurrent() ? theme.color("primary") : theme.color("textMuted")}
                          bg={rowBg()}
                          wrapMode="none"
                          flexShrink={0}
                        >
                          {isCurrent() ? "● " : "  "}
                          <span style={{ fg: titleFg(), bg: rowBg() }}>
                            {formatted().title}
                          </span>
                        </text>
                        <Show when={formatted().description.length > 0}>
                          <text
                            fg={theme.color("textMuted")}
                            bg={rowBg()}
                            wrapMode="none"
                            flexShrink={0}
                          >
                            {formatted().description}
                          </text>
                        </Show>
                      </box>
                      <Show when={formatted().hint.length > 0}>
                        <text
                          fg={theme.color("textMuted")}
                          bg={rowBg()}
                          wrapMode="none"
                          flexShrink={0}
                        >
                          {formatted().hint}
                        </text>
                      </Show>
                    </box>
                  );
                })()}
              </Show>
            )}
          </For>
        </Show>
      </box>

      <Show when={parsedActions().length > 0}>
        <box flexDirection="row" gap={2} width="100%">
          <For each={parsedActions()}>
            {(item) => {
              const labelText = () =>
                typeof item.action.label === "function"
                  ? item.action.label()
                  : item.action.label;
              return (
                <text fg={theme.color("textMuted")}>
                  {`${item.keyLabel} ${printable(labelText())}`}
                </text>
              );
            }}
          </For>
        </box>
      </Show>
    </box>
  );
}

