import { type BoxRenderable, TextAttributes, type TextareaRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import { type Completion, type CompletionItem, complete } from "../../../core/sql/complete";
import { splitStatements, statementAt } from "../../../core/sql/statements";
import { offsetToPosition, type Position, positionToOffset } from "../../../core/vim/buffer";
import type { VimMode } from "../../../core/vim/engine";
import type { Key } from "../../../core/vim/keys";
import { firstNonBlankCol, nextCharCol } from "../../../core/vim/motions";
import { useCmdline, useCommands } from "../../context/commands";
import { useConfig } from "../../context/config";
import { useDeps } from "../../context/deps";
import { useDialog } from "../../context/dialog";
import { useFocus } from "../../context/focus";
import { useKeys } from "../../context/keys";
import { useSession } from "../../context/session";
import { useStatus } from "../../context/status";
import { useTheme } from "../../context/theme";
import { useToast } from "../../context/toast";
import { cellWidth, clusters, cutCells } from "../../ui/cells";
import { printable } from "../../ui/printable";
import { PaneFrame } from "../frame";
import { createBuffers, type EditorBuffer } from "./buffers";
import { CompletionPopup, computePopupWidth, type PopupPlacement, placePopupInBox } from "./Completion";
import { type EditBufferTextBuffer, toBufferCol } from "./edit-buffer-text";
import { VimTextarea, type VimTextareaHandle } from "./VimTextarea";

export interface EditorApi {
  buffers(): EditorBuffer[];
  active(): number;
  text(): string;
  setText(text: string): void;
  mode(): VimMode;
  cursor(): Position;
  statement(): { text: string; start: number; end: number } | null;
  insert(text: string): void;
  replace(start: number, end: number, text: string): void;
  openBuffer(options: { name?: string; path?: string | null; text: string }): void;
  flush(): Promise<void>;
  completion(): { items: CompletionItem[]; selected: number } | null;
}

export const MAX_OPEN_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TAB_NAME_CELLS = 20;

function truncateTabName(rawName: string, maxCells: number = MAX_TAB_NAME_CELLS): string {
  if (maxCells <= 0) return "";
  return cutCells(rawName, maxCells, { ellipsis: true, clean: printable });
}

function formatTabLabel(index: number, rawName: string, maxNameCells: number = MAX_TAB_NAME_CELLS): string {
  return ` ${index + 1} ${truncateTabName(rawName, maxNameCells)} `;
}

function clipStringToCells(str: string, maxCells: number): string {
  if (maxCells <= 0) return "";
  return cutCells(str, maxCells);
}

interface TabViewport {
  firstIndex: number;
  tabs: { index: number; buf: EditorBuffer; label: string }[];
  hasLeft: boolean;
  hasRight: boolean;
}

function computeTabViewport(
  buffers: readonly EditorBuffer[],
  activeIdx: number,
  prevFirst: number,
  availableWidth: number,
): TabViewport {
  const n = buffers.length;
  if (n === 0 || availableWidth <= 0) {
    return { firstIndex: 0, tabs: [], hasLeft: false, hasRight: false };
  }
  const labels = buffers.map((b, i) => formatTabLabel(i, b.name));
  const widths = labels.map((l) => cellWidth(l));
  const totalAll = widths.reduce((a, b) => a + b, 0);
  if (totalAll <= availableWidth) {
    return {
      firstIndex: 0,
      tabs: buffers.map((buf, index) => ({ index, buf, label: labels[index]! })),
      hasLeft: false,
      hasRight: false,
    };
  }

  const clampedActive = Math.max(0, Math.min(n - 1, activeIdx));
  let first = Math.max(0, Math.min(clampedActive, prevFirst));

  const fitRange = (start: number): { start: number; end: number } => {
    let end = start;
    for (let candidateEnd = start; candidateEnd < n; candidateEnd++) {
      let sum = 0;
      for (let i = start; i <= candidateEnd; i++) sum += widths[i]!;
      const leftCost = start > 0 ? 2 : 0;
      const rightCost = candidateEnd < n - 1 ? 2 : 0;
      if (candidateEnd === start || sum + leftCost + rightCost <= availableWidth) {
        end = candidateEnd;
      } else {
        break;
      }
    }
    return { start, end };
  };

  let range = fitRange(first);
  while (range.end < clampedActive && first < clampedActive) {
    first++;
    range = fitRange(first);
  }

  // Pack earlier tabs on the left if room remains when scrolled near the end
  while (range.start > 0) {
    const prevStart = range.start - 1;
    let sum = 0;
    for (let i = prevStart; i <= range.end; i++) sum += widths[i]!;
    const leftCost = prevStart > 0 ? 2 : 0;
    const rightCost = range.end < n - 1 ? 2 : 0;
    if (sum + leftCost + rightCost <= availableWidth) {
      range = { start: prevStart, end: range.end };
    } else {
      break;
    }
  }

  let hasLeft = range.start > 0;
  let hasRight = range.end < n - 1;

  // When only the active tab is in range and it plus markers exceed availableWidth, cut its title with …
  if (range.start === range.end) {
    const idx = range.start;
    const buf = buffers[idx]!;
    const leftCost = hasLeft ? 2 : 0;
    const rightCost = hasRight ? 2 : 0;
    if (widths[idx]! + leftCost + rightCost > availableWidth) {
      const prefix = ` ${idx + 1} `;
      const suffix = " ";
      const framingCost = leftCost + rightCost + prefix.length + suffix.length;
      const cleanName = printable(buf.name);
      const firstChar = clusters(cleanName)[0] ?? "";
      const minNameWithOneChar = firstChar.length > 0 ? cellWidth(firstChar) + 1 : 0;
      const maxNameBudget = Math.min(MAX_TAB_NAME_CELLS, availableWidth - framingCost);

      const cutWithEllipsis = (budget: number): string => {
        if (budget <= 0) return "";
        return `${cutCells(cleanName, budget - 1)}…`;
      };

      if (maxNameBudget >= minNameWithOneChar && maxNameBudget >= 1) {
        const label = ` ${idx + 1} ${cutWithEllipsis(maxNameBudget)} `;
        return {
          firstIndex: idx,
          tabs: [{ index: idx, buf, label }],
          hasLeft,
          hasRight,
        };
      }

      // Width is too small for markers + number + 1 char of title + …: cut the row at the Pane's edge
      const rawRow =
        (hasLeft ? "‹ " : "") +
        ` ${idx + 1} ${cutWithEllipsis(Math.max(2, minNameWithOneChar))} ` +
        (hasRight ? " ›" : "");
      const clipped = clipStringToCells(rawRow, availableWidth);
      return {
        firstIndex: idx,
        tabs: [{ index: idx, buf, label: clipped }],
        hasLeft: false,
        hasRight: false,
      };
    }
  }

  const tabs: { index: number; buf: EditorBuffer; label: string }[] = [];
  for (let i = range.start; i <= range.end; i++) {
    tabs.push({ index: i, buf: buffers[i]!, label: labels[i]! });
  }
  return {
    firstIndex: range.start,
    tabs,
    hasLeft,
    hasRight,
  };
}

const MODE_LABELS: Record<VimMode, string> = {
  normal: "NORMAL",
  insert: "INSERT",
  visual: "VISUAL",
  "visual-line": "V-LINE",
};

export function EditorPane(props: {
  expose?: (api: EditorApi) => void;
  onQuit?: (hook: () => void | Promise<void>) => void;
}): JSX.Element {
  const deps = useDeps();
  const config = useConfig();
  const focus = useFocus();
  const theme = useTheme();
  const keys = useKeys();
  const status = useStatus();
  const toast = useToast();
  const dialog = useDialog();
  const cmdline = useCmdline();
  const commands = useCommands();
  const session = useSession();

  const store = createBuffers(
    deps,
    () => session.connection()?.id ?? "none",
    (msg) => {
      toast.show({
        message: printable(`Buffers could not be saved: ${msg}`),
        kind: "warning",
      });
    },
  );
  const handles = new Map<number, VimTextareaHandle>();
  const [handleVersion, setHandleVersion] = createSignal(0);

  const activeHandle = (): VimTextareaHandle | undefined => {
    handleVersion();
    const buf = store.activeBuffer();
    return handles.get(buf.id);
  };

  const dimensions = useTerminalDimensions();
  const [completionState, setCompletionState] = createSignal<{
    from: number;
    to?: number;
    items: CompletionItem[];
    selected: number;
  } | null>(null);

  let cachedStmtBounds: { start: number; tailLen: number } | null = null;

  const closeCompletion = () => {
    cachedStmtBounds = null;
    if (untrack(completionState) !== null) {
      setCompletionState(null);
    }
  };

  onCleanup(closeCompletion);

  // Up to this many characters the whole Buffer is handed to `complete()`,
  // above it only the Statement under the cursor. So items of the kind `word`
  // (words that occur in the text) come from the whole Buffer in a small
  // Buffer and from that Statement in a large one: collecting the words of a
  // large Buffer on every key costs too much.
  const COMPLETE_WHOLE_BUFFER_MAX_CHARS = 4096;
  // Only a Statement longer than 100,000 characters may be cut (to the 100,000 characters before the cursor, at a line break).
  const MAX_STATEMENT_COMPLETE_CHARS = 100_000;

  const findStatementBounds = (
    fullText: string,
    offset: number,
  ): { start: number; end: number } => {
    const stmt = statementAt(fullText, offset);
    if (!stmt) {
      return { start: 0, end: fullText.length };
    }
    if (offset >= stmt.start && offset <= stmt.end) {
      return { start: stmt.start, end: stmt.end };
    }
    const statements = splitStatements(fullText);
    if (statements.length === 0) {
      return { start: 0, end: fullText.length };
    }
    if (offset < statements[0]!.start) {
      return { start: 0, end: statements[0]!.start };
    }
    let idx = 0;
    for (let i = 0; i < statements.length; i++) {
      if (statements[i]!.start <= offset) {
        idx = i;
      } else {
        break;
      }
    }
    const current = statements[idx]!;
    const nextStart =
      idx + 1 < statements.length ? statements[idx + 1]!.start : fullText.length;
    if (!fullText.slice(current.end, offset).includes(";")) {
      return { start: current.start, end: nextStart };
    }
    return { start: current.end, end: nextStart };
  };

  const isWordKeyForCompletionBounds = (key: Key): boolean => {
    if (key.ctrl || key.meta) return false;
    if (key.name === "backspace") return true;
    if (key.text && key.text.length === 1) {
      const ch = key.text;
      return (
        (ch >= "a" && ch <= "z") ||
        (ch >= "A" && ch <= "Z") ||
        (ch >= "0" && ch <= "9") ||
        ch === "_" ||
        ch === "."
      );
    }
    return false;
  };

  const compute = (): Completion => {
    const view = activeHandle();
    if (!view) return { from: 0, items: [] };
    const fullText = view.text();
    const offset = positionToOffset(view.buffer, view.buffer.cursor());
    const schema = session.schema();
    if (fullText.length <= COMPLETE_WHOLE_BUFFER_MAX_CHARS) {
      return complete(fullText, offset, schema);
    }
    let sliceStart: number;
    let sliceEnd: number;
    if (
      cachedStmtBounds !== null &&
      offset >= cachedStmtBounds.start &&
      offset <= fullText.length - cachedStmtBounds.tailLen
    ) {
      sliceStart = cachedStmtBounds.start;
      sliceEnd = fullText.length - cachedStmtBounds.tailLen;
    } else {
      const bounds = findStatementBounds(fullText, offset);
      cachedStmtBounds = {
        start: bounds.start,
        tailLen: Math.max(0, fullText.length - bounds.end),
      };
      sliceStart = bounds.start;
      sliceEnd = bounds.end;
    }
    if (sliceEnd - sliceStart > MAX_STATEMENT_COMPLETE_CHARS) {
      if (offset - sliceStart > MAX_STATEMENT_COMPLETE_CHARS) {
        let cutStart = offset - MAX_STATEMENT_COMPLETE_CHARS;
        const nlIdx = fullText.indexOf("\n", cutStart);
        if (nlIdx !== -1 && nlIdx < offset) {
          cutStart = nlIdx + 1;
        }
        sliceStart = cutStart;
      }
      if (sliceEnd - sliceStart > MAX_STATEMENT_COMPLETE_CHARS) {
        sliceEnd = Math.max(offset, sliceStart + MAX_STATEMENT_COMPLETE_CHARS);
      }
    }
    const local = complete(fullText.slice(sliceStart, sliceEnd), offset - sliceStart, schema);
    return local.to === undefined
      ? { from: local.from + sliceStart, items: local.items }
      : { from: local.from + sliceStart, to: local.to + sliceStart, items: local.items };
  };

  const recomputeOpenCompletion = () => {
    const current = untrack(completionState);
    if (current === null) return;
    const view = activeHandle();
    if (!view || view.mode() !== "insert") {
      closeCompletion();
      return;
    }
    const next = compute();
    if (next.items.length === 0) {
      closeCompletion();
      return;
    }
    setCompletionState({
      from: next.from,
      to: next.to,
      items: next.items,
      selected: Math.max(0, Math.min(next.items.length - 1, current.selected)),
    });
  };

  const acceptCompletion = (): void => {
    const current = untrack(completionState);
    const view = activeHandle();
    if (!current || !view) {
      closeCompletion();
      return;
    }
    const item = current.items[current.selected];
    closeCompletion();
    if (!item) return;
    if (current.to !== undefined) {
      // The closing quote after the cursor is deleted first, as typed Delete
      // keys, so that `.` repeats it and the edit that writes the name still
      // ends at the cursor. One Delete removes one code point, so one is sent
      // per code point of that text, not per UTF-16 unit.
      const cursorOffset = positionToOffset(view.buffer, view.buffer.cursor());
      const removed = Array.from(view.text().slice(cursorOffset, current.to)).length;
      for (let i = 0; i < removed; i++) {
        view.engine.feed({ name: "delete" });
      }
    }
    const startPos = offsetToPosition(view.buffer, current.from);
    view.engine.edit({ start: startPos, end: view.buffer.cursor() }, item.insert ?? item.label);
  };

  let lastActiveBufferId = untrack(() => store.activeBuffer().id);
  let lastConnection = untrack(() => session.connection());
  let lastSchema = untrack(() => session.schema());

  createEffect(() => {
    const curPane = focus.pane();
    const curDepth = dialog.depth();
    const curCmdline = cmdline.active();
    const curChord = keys.chord();
    const curBufId = store.activeBuffer().id;
    const curConn = session.connection();
    const curSchema = session.schema();
    const curMode = activeHandle()?.mode() ?? "normal";

    const focusLost = curPane !== "editor";
    const modalOpened = curDepth > 0 || curCmdline || curChord !== "";
    const bufferChanged = curBufId !== lastActiveBufferId;
    const connChanged = curConn !== lastConnection;
    const schemaChanged = curSchema !== lastSchema;
    const leftInsert = curMode !== "insert";

    lastActiveBufferId = curBufId;
    lastConnection = curConn;
    lastSchema = curSchema;

    if (focusLost || modalOpened || bufferChanged || connChanged || leftInsert) {
      closeCompletion();
      return;
    }

    if (schemaChanged && untrack(completionState) !== null) {
      recomputeOpenCompletion();
    }
  });

  const getText = (): string => {
    const buf = store.activeBuffer();
    const view = handles.get(buf.id);
    return view ? view.text() : buf.text;
  };

  const setText = (nextText: string): void => {
    closeCompletion();
    const buf = store.activeBuffer();
    store.updateText(buf.id, nextText);
    const view = handles.get(buf.id);
    view?.setText(nextText);
  };

  const statement = (): { text: string; start: number; end: number } | null => {
    const view = activeHandle();
    if (!view) return null;
    const offset = positionToOffset(view.buffer, view.buffer.cursor());
    const stmt = statementAt(view.text(), offset);
    return stmt ? { text: stmt.text, start: stmt.start, end: stmt.end } : null;
  };

  const insert = (rawText: string): void => {
    closeCompletion();
    const view = activeHandle();
    if (!view) return;
    // The edit buffer stores `\n` only, as `:e` reads files: a pasted `\r\n` or
    // lone `\r` left in would put the engine's cursor past where the text ends.
    const textToInsert = rawText.replace(/\r\n?/g, "\n");
    if (view.mode() === "insert") {
      const cur = view.buffer.cursor();
      view.engine.edit({ start: cur, end: cur }, textToInsert);
      return;
    }
    const cur = view.buffer.cursor();
    const lineText = view.buffer.line(cur.row);
    const col = lineText.length === 0 ? 0 : nextCharCol(lineText, cur.col);
    const pos = { row: cur.row, col };
    view.engine.edit({ start: pos, end: pos }, textToInsert);
  };

  const replace = (start: number, end: number, replacement: string): void => {
    closeCompletion();
    const view = activeHandle();
    if (!view) return;
    const startPos = offsetToPosition(view.buffer, start);
    const endPos = offsetToPosition(view.buffer, end);
    view.engine.edit({ start: startPos, end: endPos }, replacement);
  };

  const reportUnshownOutcomes = (outcomes: readonly { ok: boolean; error?: { message: string } }[]): void => {
    if (outcomes.length === 0) {
      return;
    }
    const lastErr = session.lastError();
    for (const outcome of outcomes) {
      if (!outcome.ok && outcome.error && outcome !== lastErr && outcome.error.message !== "cancelled") {
        status.say(printable(outcome.error.message), "error");
      }
    }
  };

  const codePointPositionToUtf16Offset = (stmtText: string, oneBasedCodePoints: number): number => {
    let idx = 0;
    let cp = 1;
    while (cp < oneBasedCodePoints && idx < stmtText.length) {
      idx = nextCharCol(stmtText, idx);
      cp++;
    }
    return idx;
  };

  const runStatement = async (): Promise<void> => {
    const view = activeHandle();
    const stmt = statement();
    if (!view || !stmt) {
      status.say("No statement under the cursor", "error");
      return;
    }
    if (session.running() !== null) {
      status.say("A Run is already in progress", "error");
      return;
    }
    const textBefore = view.text();
    const outcomes = await session.run({ statements: [stmt.text] });
    reportUnshownOutcomes(outcomes);
    const first = outcomes[0];
    if (
      first &&
      !first.ok &&
      first.error.position !== undefined &&
      first.error.position >= 1 &&
      view.text() === textBefore
    ) {
      view.markError(stmt.start + codePointPositionToUtf16Offset(stmt.text, first.error.position));
    }
  };

  const runSelection = async (): Promise<void> => {
    const view = activeHandle();
    if (!view) return;
    const sel = (view.buffer as EditBufferTextBuffer).selection();
    let selectedText = "";
    if (sel) {
      const startRow = sel.range.start.row;
      const endRow = sel.range.end.row;
      const startCol = view.mode() === "visual-line" ? 0 : sel.range.start.col;
      const endCol =
        view.mode() === "visual-line"
          ? view.buffer.line(endRow).length
          : sel.range.end.col;
      const startOffset = positionToOffset(view.buffer, { row: startRow, col: startCol });
      const endOffset = positionToOffset(view.buffer, { row: endRow, col: endCol });
      selectedText = view.text().slice(startOffset, endOffset);
    }
    const stmts = splitStatements(selectedText).map((s) => s.text);
    view.feed({ name: "escape" });
    if (stmts.length === 0) {
      status.say("No statement under the cursor", "error");
      return;
    }
    if (session.running() !== null) {
      status.say("A Run is already in progress", "error");
      return;
    }
    const outcomes = await session.run({ statements: stmts });
    reportUnshownOutcomes(outcomes);
  };

  const runAll = async (): Promise<void> => {
    const view = activeHandle();
    const fullText = getText();
    const stmts = splitStatements(fullText);
    if (stmts.length === 0) {
      status.say("No statement under the cursor", "error");
      return;
    }
    if (session.running() !== null) {
      status.say("A Run is already in progress", "error");
      return;
    }
    const outcomes = await session.run({ statements: stmts.map((s) => s.text) });
    if (outcomes.length === 0) return;
    const failedIdx = outcomes.findIndex((o) => !o.ok);
    if (failedIdx >= 0) {
      const failed = outcomes[failedIdx];
      const failedStmt = stmts[failedIdx]!;
      if (
        failed &&
        !failed.ok &&
        failed.error.position !== undefined &&
        failed.error.position >= 1 &&
        view &&
        view.text() === fullText
      ) {
        view.markError(
          failedStmt.start + codePointPositionToUtf16Offset(failedStmt.text, failed.error.position),
        );
      }
      if (failed && !failed.ok && failed.error.message === "cancelled") {
        return;
      }
      if (failed && !failed.ok) {
        status.say(
          `Statement ${failedIdx + 1} of ${stmts.length} failed: ${printable(failed.error.message)}`,
          "error",
        );
      }
      toast.show({
        kind: "error",
        message: `Statement ${failedIdx + 1} of ${stmts.length} failed`,
      });
      return;
    }
    const n = stmts.length;
    toast.show({
      kind: "success",
      message: n === 1 ? "Ran 1 statement" : `Ran ${n} statements`,
    });
  };

  const openSearch = (direction: 1 | -1): void => {
    cmdline.open({
      prefix: direction === 1 ? "/" : "?",
      onSubmit(pattern) {
        if (pattern.length === 0) return;
        const view = activeHandle();
        if (!view) return;
        const ok = view.engine.search(pattern, direction);
        if (!ok) {
          status.say(`Pattern not found: ${printable(pattern)}`, "error");
        }
      },
    });
  };

  const nextBuffer = () => {
    closeCompletion();
    store.next();
  };
  const previousBuffer = () => {
    closeCompletion();
    store.previous();
  };

  function onKey(key: Key): boolean {
    const view = activeHandle();
    if (!view) return false;

    if (view.mode() === "insert") {
      const currentComp = untrack(completionState);
      const isCtrlN = Boolean(key.ctrl) && !key.meta && !key.shift && key.name === "n";
      const isCtrlP = Boolean(key.ctrl) && !key.meta && !key.shift && key.name === "p";

      if (currentComp === null) {
        if (isCtrlN || isCtrlP) {
          cachedStmtBounds = null;
          const res = compute();
          if (res.items.length === 0) {
            cachedStmtBounds = null;
            status.say("No completions");
          } else {
            setCompletionState({
              from: res.from,
              to: res.to,
              items: res.items,
              selected: isCtrlN ? 0 : res.items.length - 1,
            });
          }
          return true;
        }
      } else {
        const isDown = !key.ctrl && !key.meta && !key.shift && key.name === "down";
        const isUp = !key.ctrl && !key.meta && !key.shift && key.name === "up";
        const isEnter = !key.ctrl && !key.meta && !key.shift && key.name === "enter";
        const isTab = !key.ctrl && !key.meta && !key.shift && key.name === "tab";
        const isEsc = !key.ctrl && !key.meta && key.name === "escape";

        if (isCtrlN || isDown) {
          const len = currentComp.items.length;
          if (len > 0) {
            setCompletionState({
              ...currentComp,
              selected: (currentComp.selected + 1) % len,
            });
          }
          return true;
        }
        if (isCtrlP || isUp) {
          const len = currentComp.items.length;
          if (len > 0) {
            setCompletionState({
              ...currentComp,
              selected: (currentComp.selected - 1 + len) % len,
            });
          }
          return true;
        }
        if (isEnter || isTab) {
          acceptCompletion();
          return true;
        }
        if (isEsc) {
          closeCompletion();
          return true;
        }

        if (key.ctrl && !key.meta && key.name === "c" && session.running() !== null) {
          closeCompletion();
          return false;
        }
        if (key.ctrl && (key.name === "s" || key.name === "enter")) {
          closeCompletion();
          void runStatement();
          return true;
        }

        // Every other key is handled exactly as with the popup closed (the
        // engine's insert mode), and the popup then recomputes or closes.
        if (!isWordKeyForCompletionBounds(key)) {
          cachedStmtBounds = null;
        }
        const res = view.feed(key);
        recomputeOpenCompletion();
        return res === "handled";
      }
    }

    if (key.ctrl && !key.meta && key.name === "c" && session.running() !== null) {
      return false;
    }
    if (key.ctrl && (key.name === "s" || key.name === "enter")) {
      void runStatement();
      return true;
    }
    if (view.mode() !== "insert") {
      if (view.pending() === "g" && (key.text === "t" || key.text === "T")) {
        view.engine.reset();
        key.text === "t" ? nextBuffer() : previousBuffer();
        return true;
      }
      if (view.pending() === "" && (key.text === "/" || key.text === "?")) {
        openSearch(key.text === "/" ? 1 : -1);
        return true;
      }
      if (key.name === "enter") {
        void (view.mode() === "normal" ? runStatement() : runSelection());
        return true;
      }
      const leader = config.config().leader;
      const isLeader =
        leader === "space"
          ? !key.ctrl && !key.meta && key.name === "space"
          : !key.ctrl && !key.meta && key.text === leader;
      if (view.pending() === "" && isLeader) {
        return false;
      }
    }
    return view.feed(key) === "handled";
  }

  keys.setPaneHandler("editor", onKey);
  keys.setPasteHandler("editor", (pasted) => {
    insert(pasted);
  });
  onCleanup(() => {
    keys.setPaneHandler("editor", null);
    keys.setPasteHandler("editor", null);
  });

  status.register("editor", () => {
    const view = activeHandle();
    if (!view) {
      return { mode: "NORMAL", pending: "", position: "1:1" };
    }
    const cur = view.cursor();
    return {
      mode: MODE_LABELS[view.mode()],
      pending: view.pending(),
      position: `${cur.row + 1}:${cur.col + 1}`,
    };
  });

  commands.register({
    id: "run.statement",
    title: "Run the statement",
    ex: ["run"],
    keys: "r",
    run: (_ctx, args) => (args.trim() === "all" ? runAll() : runStatement()),
  });

  commands.register({
    id: "run.all",
    title: "Run every statement",
    keys: "R",
    run: () => runAll(),
  });

  commands.register({
    id: "run.explain",
    title: "Explain the statement",
    ex: ["explain"],
    keys: "x",
    run: async (_ctx, args) => {
      const stmt = statement();
      if (!stmt) {
        status.say("No statement under the cursor", "error");
        return;
      }
      if (session.running() !== null) {
        status.say("A Run is already in progress", "error");
        return;
      }
      const outcomes = await session.explain(stmt.text, args.trim() === "analyze");
      reportUnshownOutcomes(outcomes);
    },
  });

  commands.register({
    id: "buffer.list",
    title: "List Buffers",
    group: "Buffer",
    ex: ["ls", "buffers"],
    keys: "b l",
    run: async () => {
      const list = store.buffers();
      const currentId = store.activeBuffer().id;
      const chosen = await dialog.select<number>({
        title: "Buffers",
        current: currentId,
        options: list.map((b, i) => ({
          title: b.name,
          value: b.id,
          description: b.path ?? undefined,
          hint: `#${i + 1}`,
        })),
      });
      if (chosen !== null) {
        const idx = store.buffers().findIndex((b) => b.id === chosen);
        if (idx >= 0) {
          store.setActive(idx);
        }
      }
    },
  });

  commands.register({
    id: "buffer.new",
    title: "New Buffer",
    group: "Buffer",
    ex: ["new"],
    keys: "b n",
    run: () => {
      focus.leaveZoom();
      store.openBuffer({ text: "" });
    },
  });

  commands.register({
    id: "buffer.close",
    title: "Close Buffer",
    group: "Buffer",
    ex: ["bd", "bdelete"],
    keys: "b d",
    run: () => {
      store.closeActive();
    },
  });

  commands.register({
    id: "buffer.next",
    title: "Next Buffer",
    ex: ["bn", "bnext"],
    run: () => {
      nextBuffer();
    },
  });

  commands.register({
    id: "buffer.previous",
    title: "Previous Buffer",
    ex: ["bp", "bprevious"],
    run: () => {
      previousBuffer();
    },
  });

  commands.register({
    id: "buffer.write",
    title: "Write the Buffer to a file",
    ex: ["w", "write"],
    run: async (_ctx, args) => {
      const arg = args.trim();
      const buf = store.activeBuffer();
      const targetPath = arg.length > 0 ? resolve(deps.cwd, arg) : buf.path;
      if (!targetPath) {
        throw new Error("No file name (use :w <path>)");
      }
      const content = getText();
      await writeFile(targetPath, content + "\n", "utf8");
      const name = store.setPath(buf.id, targetPath);
      const lineCount = content.split("\n").length;
      status.say(`"${name}" written, ${lineCount === 1 ? "1 line" : `${lineCount} lines`}`);
    },
  });

  commands.register({
    id: "buffer.edit",
    title: "Open a file",
    ex: ["e", "edit"],
    run: async (_ctx, args) => {
      const arg = args.trim();
      if (arg.length === 0) {
        throw new Error("Usage: :e <path>");
      }
      const targetPath = resolve(deps.cwd, arg);
      focus.leaveZoom();
      const existingIdx = store.buffers().findIndex((b) => b.path === targetPath);
      if (existingIdx >= 0) {
        store.setActive(existingIdx);
        return;
      }
      let fileText = "";
      try {
        const info = await stat(targetPath);
        if (info.isDirectory()) {
          status.say(printable(`Cannot open "${arg}": is a directory`), "error");
          return;
        }
        if (!info.isFile()) {
          status.say(printable(`Not a regular file: ${arg}`), "error");
          return;
        }
        if (info.size > MAX_OPEN_FILE_BYTES) {
          status.say(
            printable(`Cannot open "${arg}": file exceeds maximum size of ${MAX_OPEN_FILE_BYTES} bytes`),
            "error",
          );
          return;
        }
        const raw = await readFile(targetPath);
        if (raw.byteLength > MAX_OPEN_FILE_BYTES) {
          status.say(
            printable(`Cannot open "${arg}": file exceeds maximum size of ${MAX_OPEN_FILE_BYTES} bytes`),
            "error",
          );
          return;
        }
        if (raw.includes(0)) {
          status.say(printable(`Cannot open "${arg}": binary file (contains NUL character)`), "error");
          return;
        }
        fileText = raw.toString("utf8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        if (code === "ENOENT") {
          fileText = "";
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          status.say(printable(msg), "error");
          return;
        }
      }
      if (fileText.endsWith("\r\n")) {
        fileText = fileText.slice(0, -2);
      } else if (fileText.endsWith("\n") || fileText.endsWith("\r")) {
        fileText = fileText.slice(0, -1);
      }
      fileText = fileText.replace(/\r\n?/g, "\n");
      store.openBuffer({ path: targetPath, text: fileText });
    },
  });

  commands.register({
    id: "editor.gotoLine",
    title: "Go to line",
    run: (_ctx, args) => {
      const view = activeHandle();
      if (!view) return;
      const lineNum = Number.parseInt(args.trim(), 10);
      if (Number.isNaN(lineNum)) return;
      const total = view.buffer.lineCount();
      const row = Math.max(0, Math.min(Math.max(0, total - 1), lineNum - 1));
      const lineText = view.buffer.line(row);
      const col = firstNonBlankCol(lineText);
      view.buffer.setCursor({ row, col });
    },
  });

  commands.register({
    id: "editor.noh",
    title: "Clear the search highlight",
    ex: ["noh", "nohlsearch"],
    run: () => {
      activeHandle()?.engine.clearSearch();
    },
  });

  const api: EditorApi = {
    buffers: store.buffers,
    active: store.active,
    text: getText,
    setText,
    mode: () => activeHandle()?.mode() ?? "normal",
    cursor: () => activeHandle()?.cursor() ?? { row: 0, col: 0 },
    statement,
    insert,
    replace,
    openBuffer(options) {
      focus.leaveZoom();
      closeCompletion();
      store.openBuffer(options);
    },
    flush: () => store.flush(),
    completion() {
      const c = completionState();
      return c ? { items: c.items, selected: c.selected } : null;
    },
  };

  props.expose?.(api);
  props.onQuit?.(() => store.flush());

  let tabBoxRef: BoxRenderable | null = null;
  let editorAreaRef: BoxRenderable | null = null;
  const [tabBarWidth, setTabBarWidth] = createSignal(80);
  const [layoutTick, setLayoutTick] = createSignal(0);
  let prevTabFirst = 0;

  const tabViewport = createMemo<TabViewport>(() => {
    layoutTick();
    const dims = dimensions();
    const boxW = tabBoxRef && tabBoxRef.width > 0 ? tabBoxRef.width : 0;
    const w = boxW > 0 ? boxW : Math.max(0, dims.width > 0 ? dims.width - 2 : tabBarWidth());
    const vp = computeTabViewport(store.buffers(), store.active(), prevTabFirst, w);
    prevTabFirst = vp.firstIndex;
    return vp;
  });

  // The first item the popup showed, so that it scrolls only when the
  // selection leaves the rows shown.
  let popupFirst = 0;

  const popupPlacement = createMemo<PopupPlacement | null>(() => {
    const comp = completionState();
    if (!comp) {
      popupFirst = 0;
      return null;
    }
    layoutTick();
    const view = activeHandle();
    if (!view) return null;
    view.cursor();

    const termW = dimensions().width;
    const termH = dimensions().height;
    const hasArea = editorAreaRef !== null && editorAreaRef.width > 0 && editorAreaRef.height > 0;
    const area = hasArea
      ? {
          top: Math.trunc(editorAreaRef!.y),
          bottom: Math.trunc(editorAreaRef!.y) + Math.trunc(editorAreaRef!.height),
          left: Math.trunc(editorAreaRef!.x),
          right: Math.trunc(editorAreaRef!.x) + Math.trunc(editorAreaRef!.width),
        }
      : { top: 0, bottom: termH, left: 0, right: termW };

    let cursorRow = 0;
    let anchorCol = 0;
    const textarea = (
      view.buffer as unknown as { textarea?: TextareaRenderable }
    ).textarea;
    if (textarea && !textarea.isDestroyed) {
      const editBuffer = textarea.editBuffer;
      const editorView = textarea.editorView;
      const vCursor = textarea.visualCursor;
      const curPos = view.buffer.cursor();
      const fromPos = offsetToPosition(view.buffer, comp.from);
      const lineText = view.buffer.line(fromPos.row);

      const curDisplayCol = toBufferCol(editBuffer, view.buffer.line(curPos.row), curPos.col);
      const fromDisplayCol = toBufferCol(editBuffer, lineText, fromPos.col);
      const colDelta = Math.max(0, curDisplayCol - fromDisplayCol);

      let visualFromCol: number;
      if (textarea.wrapMode !== "none" && vCursor.visualCol < colDelta) {
        const vp = editorView.getViewport();
        const wrapWidth = Math.max(1, vp.width);
        visualFromCol = fromDisplayCol % wrapWidth;
      } else {
        visualFromCol = vCursor.visualCol - colDelta;
      }
      // The popup keeps clear of the cursor's own row (not of the row where
      // the word began, when the word wraps).
      cursorRow = Math.trunc(textarea.y) + vCursor.visualRow;
      anchorCol = Math.trunc(textarea.x) + visualFromCol;
    }

    // The popup's rows lie inside the Editor Pane's own box: what lay below it would be drawn
    // over by the Results Pane.
    const placement = placePopupInBox({
      cursorRow,
      anchorCol,
      itemCount: comp.items.length,
      selected: comp.selected,
      previousFirst: popupFirst,
      width: computePopupWidth(comp.items, termW > 0 ? termW : undefined),
      terminal: { width: termW, height: termH },
      area,
    });
    popupFirst = placement?.first ?? 0;
    return placement;
  });

  // Where there is no free row above or below the cursor's row, there is no
  // popup: an open completion that cannot be shown is closed, so that its
  // keys do nothing unseen.
  createEffect(() => {
    if (completionState() !== null && popupPlacement() === null) {
      closeCompletion();
    }
  });

  return (
    <PaneFrame pane="editor">
      <box
        ref={(el: BoxRenderable) => {
          tabBoxRef = el;
          if (el.width > 0) {
            setTabBarWidth(el.width);
          }
        }}
        onSizeChange={() => {
          if (tabBoxRef && tabBoxRef.width > 0) {
            setTabBarWidth(tabBoxRef.width);
          }
          setLayoutTick((t) => t + 1);
        }}
        height={1}
        width="100%"
        flexShrink={0}
        flexDirection="row"
      >
        <Show when={tabViewport().hasLeft}>
          <text fg={theme.color("textMuted")} bg={theme.color("paneBackground")} flexShrink={0}>
            {"‹ "}
          </text>
        </Show>
        <For each={tabViewport().tabs}>
          {(item) => {
            const isActiveTab = () => store.active() === item.index;
            return (
              <text
                flexShrink={0}
                fg={isActiveTab() ? theme.color("text") : theme.color("textMuted")}
                bg={
                  isActiveTab()
                    ? theme.color("backgroundElement")
                    : theme.color("paneBackground")
                }
                attributes={isActiveTab() ? TextAttributes.BOLD : undefined}
              >
                {item.label}
              </text>
            );
          }}
        </For>
        <Show when={tabViewport().hasRight}>
          <text fg={theme.color("textMuted")} bg={theme.color("paneBackground")} flexShrink={0}>
            {" ›"}
          </text>
        </Show>
      </box>
      <box
        ref={(el: BoxRenderable) => {
          editorAreaRef = el;
        }}
        onSizeChange={() => {
          setLayoutTick((t) => t + 1);
        }}
        flexGrow={1}
        width="100%"
        flexDirection="column"
      >
        <For each={store.buffers()}>
          {(buf) => {
            onCleanup(() => {
              handles.delete(buf.id);
            });
            const isCurrent = () => store.activeBuffer().id === buf.id;
            const isFocused = () => isCurrent() && focus.pane() === "editor";
            return (
              <VimTextarea
                language="sql"
                initialText={buf.text}
                active={isFocused()}
                visible={isCurrent()}
                onReady={(h) => {
                  handles.set(buf.id, h);
                  setHandleVersion((v) => v + 1);
                }}
                onChange={(t) => {
                  store.updateText(buf.id, t);
                }}
              />
            );
          }}
        </For>
      </box>
      <Show when={popupPlacement()}>
        {(placement: () => PopupPlacement) => (
          <CompletionPopup
            items={completionState()?.items ?? []}
            selected={completionState()?.selected ?? 0}
            placement={placement()}
          />
        )}
      </Show>
    </PaneFrame>
  );
}
