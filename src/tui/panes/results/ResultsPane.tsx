import { TextAttributes } from "@opentui/core";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { copyToClipboard } from "../../../core/clipboard";
import { cellText } from "../../../core/db/format";
import type { Result } from "../../../core/db/types";
import type { VimMode } from "../../../core/vim/engine";
import type { Key } from "../../../core/vim/keys";
import { useCmdline, useCommands } from "../../context/commands";
import { useConfig } from "../../context/config";
import { useDeps } from "../../context/deps";
import { useFocus } from "../../context/focus";
import { useKeys } from "../../context/keys";
import { type RunOutcome, useSession } from "../../context/session";
import { useStatus } from "../../context/status";
import { useTheme } from "../../context/theme";
import { countUp } from "../../motion/shimmer";
import { formatDuration } from "../../ui/duration";
import { printable } from "../../ui/printable";
import { Spinner } from "../../ui/spinner";
import type { VimTextareaHandle } from "../editor/VimTextarea";
import { PaneFrame } from "../frame";
import { NULL_GLYPH, recordFields, rowsToJson, searchCells } from "./grid-model";
import { JsonView } from "./JsonView";
import { RecordView } from "./RecordView";
import { type FlashSpec, ResultGrid } from "./ResultGrid";

export type ResultView = "table" | "json" | "record";

export interface ResultsApi {
  view(): ResultView;
  setView(view: ResultView): void;
  cursor(): { row: number; column: number };
}

const VIEWS: readonly { id: ResultView; label: string }[] = [
  { id: "table", label: "Table" },
  { id: "json", label: "JSON" },
  { id: "record", label: "Record" },
];

const MODE_LABELS: Record<VimMode, string> = {
  normal: "NORMAL",
  insert: "INSERT",
  visual: "VISUAL",
  "visual-line": "V-LINE",
};

export function ResultsPane(props: {
  expose?: (api: ResultsApi) => void;
}): JSX.Element {
  const deps = useDeps();
  const config = useConfig();
  const focus = useFocus();
  const theme = useTheme();
  const keys = useKeys();
  const status = useStatus();
  const cmdline = useCmdline();
  const commands = useCommands();
  const session = useSession();

  const [view, setViewSignal] = createSignal<ResultView>("table");
  const [returnView, setReturnView] = createSignal<ResultView>("table");
  const [cursorSignal, setCursorSignal] = createSignal<{ row: number; column: number }>({
    row: 0,
    column: 0,
  });
  const [fieldCursor, setFieldCursor] = createSignal(0);
  const [pendingCount, setPendingCount] = createSignal("");
  const [pendingOp, setPendingOp] = createSignal<"" | "g">("");
  const [rowSelectionAnchor, setRowSelectionAnchor] = createSignal<number | null>(null);
  const [lastWasSingleYank, setLastWasSingleYank] = createSignal(false);
  const [searchMatches, setSearchMatches] = createSignal<{ row: number; column: number }[]>([]);
  const [lastSearchPattern, setLastSearchPattern] = createSignal("");
  const [flash, setFlash] = createSignal<FlashSpec | null>(null);
  const [animatedCount, setAnimatedCount] = createSignal(0);

  let jsonHandle: VimTextareaHandle | null = null;
  let gridBoxHeight = 10;
  let recordBoxHeight = 10;
  let cancelFlash: (() => void) | null = null;
  let cancelCountUp: (() => void) | null = null;
  let prevOutcome: RunOutcome | null = null;

  const stopFlash = () => {
    if (cancelFlash) {
      cancelFlash();
      cancelFlash = null;
    }
    setFlash(null);
  };

  const stopCountUp = () => {
    if (cancelCountUp) {
      cancelCountUp();
      cancelCountUp = null;
    }
  };

  onCleanup(() => {
    stopFlash();
    stopCountUp();
  });

  const triggerFlash = (spec: FlashSpec) => {
    if (!config.animations()) return;
    stopFlash();
    setFlash(spec);
    cancelFlash = deps.clock.after(150, () => {
      cancelFlash = null;
      setFlash(null);
    });
  };

  const currentResult = createMemo<Result | null>(() => {
    const out = session.shown();
    if (!out || !out.ok || out.result.columns.length === 0) return null;
    return out.result;
  });

  const clampedCursor = createMemo(() => {
    const res = currentResult();
    const cur = cursorSignal();
    if (!res) return { row: 0, column: 0 };
    const maxRow = Math.max(0, res.rows.length - 1);
    const maxCol = Math.max(0, res.columns.length - 1);
    return {
      row: Math.max(0, Math.min(maxRow, cur.row)),
      column: Math.max(0, Math.min(maxCol, cur.column)),
    };
  });

  const clampedFieldCursor = createMemo(() => {
    const res = currentResult();
    if (!res) return 0;
    const maxField = Math.max(0, res.columns.length - 1);
    return Math.max(0, Math.min(maxField, fieldCursor()));
  });

  const selectedRowsRange = createMemo<{ start: number; end: number } | null>(() => {
    const anchor = rowSelectionAnchor();
    if (anchor === null) return null;
    const curRow = clampedCursor().row;
    return {
      start: Math.min(anchor, curRow),
      end: Math.max(anchor, curRow),
    };
  });

  createEffect(() => {
    const out = session.shown();
    if (out !== prevOutcome) {
      prevOutcome = out;
      stopFlash();
      stopCountUp();
      setViewSignal("table");
      setReturnView("table");
      setCursorSignal({ row: 0, column: 0 });
      setFieldCursor(0);
      setPendingCount("");
      setPendingOp("");
      setRowSelectionAnchor(null);
      setLastWasSingleYank(false);
      setSearchMatches([]);
      setLastSearchPattern("");

      if (out && out.ok && out.result.columns.length > 0) {
        const target = out.result.rows.length;
        if (config.animations()) {
          const start = deps.clock.now();
          setAnimatedCount(0);
          cancelCountUp = deps.clock.onFrame((now) => {
            const elapsed = now - start;
            setAnimatedCount(countUp(target, elapsed, 200));
            if (elapsed >= 200) {
              stopCountUp();
            }
          });
        } else {
          setAnimatedCount(target);
        }
      } else {
        setAnimatedCount(0);
      }
    }
  });

  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  // Copies without blocking the key handler; the yanked cells flash only once
  // the copy happened (and the same result is still shown), a failed copy says
  // why instead. A result that arrives after the Pane is gone changes nothing.
  const copyText = (text: string, flashSpec?: FlashSpec) => {
    const shown = currentResult();
    void copyToClipboard(text, {
      write: deps.write,
      which: deps.which,
      exec: deps.exec,
    }).then((res) => {
      if (disposed) return;
      if (!res.ok) {
        status.say(`Could not copy: ${printable(res.reason)}`, "error");
        return;
      }
      if (flashSpec && currentResult() === shown) triggerFlash(flashSpec);
    });
  };

  const setView = (nextView: ResultView) => {
    setReturnView(view());
    setViewSignal(nextView);
    setPendingCount("");
    setPendingOp("");
    setRowSelectionAnchor(null);
    setLastWasSingleYank(false);
  };

  const cycleView = (delta: 1 | -1) => {
    const idx = VIEWS.findIndex((v) => v.id === view());
    const nextIdx = (idx + delta + VIEWS.length) % VIEWS.length;
    setView(VIEWS[nextIdx]!.id);
  };

  const takeCount = (): { count: number; hasExplicitCount: boolean } => {
    const raw = pendingCount();
    setPendingCount("");
    if (raw === "") return { count: 1, hasExplicitCount: false };
    const parsed = Number.parseInt(raw, 10);
    return {
      count: Number.isNaN(parsed) || parsed < 1 ? 1 : parsed,
      hasExplicitCount: true,
    };
  };

  const clearPending = () => {
    setPendingCount("");
    setPendingOp("");
  };

  const moveTableCursor = (dRow: number, dCol: number) => {
    const res = currentResult();
    if (!res) return;
    const cur = clampedCursor();
    const maxRow = Math.max(0, res.rows.length - 1);
    const maxCol = Math.max(0, res.columns.length - 1);
    setCursorSignal({
      row: Math.max(0, Math.min(maxRow, cur.row + dRow)),
      column: Math.max(0, Math.min(maxCol, cur.column + dCol)),
    });
  };

  const setTableRow = (row: number) => {
    const res = currentResult();
    if (!res) return;
    const cur = clampedCursor();
    const maxRow = Math.max(0, res.rows.length - 1);
    setCursorSignal({
      row: Math.max(0, Math.min(maxRow, row)),
      column: cur.column,
    });
  };

  const setTableCol = (col: number) => {
    const res = currentResult();
    if (!res) return;
    const cur = clampedCursor();
    const maxCol = Math.max(0, res.columns.length - 1);
    setCursorSignal({
      row: cur.row,
      column: Math.max(0, Math.min(maxCol, col)),
    });
  };

  const openTableSearch = () => {
    cmdline.open({
      prefix: "/",
      onSubmit(pattern) {
        if (pattern.length === 0) return;
        const res = currentResult();
        if (!res) return;
        setLastSearchPattern(pattern);
        const matches = searchCells(res, pattern);
        setSearchMatches(matches);
        if (matches.length === 0) {
          status.say(`Pattern not found: ${printable(pattern)}`, "error");
          return;
        }
        const cur = clampedCursor();
        const next =
          matches.find(
            (m) => m.row > cur.row || (m.row === cur.row && m.column >= cur.column),
          ) ?? matches[0]!;
        setCursorSignal({ row: next.row, column: next.column });
      },
    });
  };

  const stepTableSearch = (direction: 1 | -1) => {
    const res = currentResult();
    if (!res) return;
    let matches = searchMatches();
    const pat = lastSearchPattern();
    if (matches.length === 0 && pat.length > 0) {
      matches = searchCells(res, pat);
      setSearchMatches(matches);
    }
    if (matches.length === 0) {
      if (pat.length > 0) {
        status.say(`Pattern not found: ${printable(pat)}`, "error");
      }
      return;
    }
    const cur = clampedCursor();
    if (direction === 1) {
      const next =
        matches.find(
          (m) => m.row > cur.row || (m.row === cur.row && m.column > cur.column),
        ) ?? matches[0]!;
      setCursorSignal({ row: next.row, column: next.column });
    } else {
      let prev: { row: number; column: number } | undefined;
      for (let i = matches.length - 1; i >= 0; i--) {
        const m = matches[i]!;
        if (m.row < cur.row || (m.row === cur.row && m.column < cur.column)) {
          prev = m;
          break;
        }
      }
      const chosen = prev ?? matches[matches.length - 1]!;
      setCursorSignal({ row: chosen.row, column: chosen.column });
    }
  };

  const openJsonSearch = (direction: 1 | -1) => {
    cmdline.open({
      prefix: direction === 1 ? "/" : "?",
      onSubmit(pattern) {
        if (pattern.length === 0 || !jsonHandle) return;
        const ok = jsonHandle.engine.search(pattern, direction);
        if (!ok) {
          status.say(`Pattern not found: ${printable(pattern)}`, "error");
        }
      },
    });
  };

  const handleTableKey = (key: Key): boolean => {
    const res = currentResult();
    if (!res) return false;

    const isPlain = !key.ctrl && !key.meta;

    if (pendingOp() === "g") {
      setPendingOp("");
      const { hasExplicitCount, count } = takeCount();
      setLastWasSingleYank(false);
      if (isPlain && key.text === "g") {
        setTableRow(hasExplicitCount ? count - 1 : 0);
        return true;
      }
      return false;
    }

    if (isPlain && key.text && /^[1-9]$/.test(key.text)) {
      setLastWasSingleYank(false);
      setPendingCount((prev) => prev + key.text!);
      return true;
    }

    if (isPlain && key.text === "0" && pendingCount() !== "") {
      setLastWasSingleYank(false);
      setPendingCount((prev) => prev + "0");
      return true;
    }

    if (isPlain && key.text === "g") {
      setLastWasSingleYank(false);
      setPendingOp("g");
      return true;
    }

    if (isPlain && key.text === "y") {
      clearPending();
      const sel = selectedRowsRange();
      if (sel) {
        const rowIndices: number[] = [];
        for (let r = sel.start; r <= sel.end; r++) {
          rowIndices.push(r);
        }
        setRowSelectionAnchor(null);
        setLastWasSingleYank(false);
        if (rowIndices.length > 0) {
          copyText(rowsToJson(res, rowIndices), { rows: new Set(rowIndices), column: null });
        }
        return true;
      }

      const cur = clampedCursor();
      if (lastWasSingleYank()) {
        if (res.rows.length > 0) {
          copyText(rowsToJson(res, [cur.row]), { rows: new Set([cur.row]), column: null });
        }
        return true;
      }

      setLastWasSingleYank(true);
      if (res.rows.length > 0 && res.columns.length > 0) {
        const cell = res.rows[cur.row]?.[cur.column] ?? null;
        copyText(cellText(cell), { rows: new Set([cur.row]), column: cur.column });
      }
      return true;
    }

    setLastWasSingleYank(false);

    if (isPlain && key.text === "Y") {
      clearPending();
      setRowSelectionAnchor(null);
      if (res.rows.length > 0) {
        const cur = clampedCursor();
        copyText(rowsToJson(res, [cur.row]), { rows: new Set([cur.row]), column: null });
      }
      return true;
    }

    if (isPlain && key.text === "V") {
      clearPending();
      if (rowSelectionAnchor() !== null) {
        setRowSelectionAnchor(null);
      } else if (res.rows.length > 0) {
        setRowSelectionAnchor(clampedCursor().row);
      }
      return true;
    }

    if (key.name === "escape") {
      clearPending();
      if (rowSelectionAnchor() !== null) {
        setRowSelectionAnchor(null);
        return true;
      }
      return false;
    }

    if (isPlain && (key.text === "j" || key.name === "down")) {
      const { count } = takeCount();
      moveTableCursor(count, 0);
      return true;
    }

    if (isPlain && (key.text === "k" || key.name === "up")) {
      const { count } = takeCount();
      moveTableCursor(-count, 0);
      return true;
    }

    if (isPlain && (key.text === "h" || key.name === "left")) {
      const { count } = takeCount();
      moveTableCursor(0, -count);
      return true;
    }

    if (isPlain && (key.text === "l" || key.name === "right")) {
      const { count } = takeCount();
      moveTableCursor(0, count);
      return true;
    }

    if (isPlain && key.text === "0") {
      clearPending();
      setTableCol(0);
      return true;
    }

    if (isPlain && key.text === "$") {
      clearPending();
      setTableCol(Math.max(0, res.columns.length - 1));
      return true;
    }

    if (isPlain && key.text === "G") {
      const { count, hasExplicitCount } = takeCount();
      const targetRow = hasExplicitCount ? count - 1 : Math.max(0, res.rows.length - 1);
      setTableRow(targetRow);
      return true;
    }

    if (key.ctrl && !key.meta && key.name === "d") {
      clearPending();
      const half = Math.max(1, Math.floor(Math.max(1, gridBoxHeight - 1) / 2));
      moveTableCursor(half, 0);
      return true;
    }

    if (key.ctrl && !key.meta && key.name === "u") {
      clearPending();
      const half = Math.max(1, Math.floor(Math.max(1, gridBoxHeight - 1) / 2));
      moveTableCursor(-half, 0);
      return true;
    }

    if (isPlain && key.name === "enter") {
      clearPending();
      setRowSelectionAnchor(null);
      if (res.rows.length === 0) {
        status.say("No rows");
        return true;
      }
      setReturnView("table");
      setFieldCursor(clampedCursor().column);
      setViewSignal("record");
      return true;
    }

    if (isPlain && key.text === "/") {
      clearPending();
      openTableSearch();
      return true;
    }

    if (isPlain && key.text === "n") {
      clearPending();
      stepTableSearch(1);
      return true;
    }

    if (isPlain && key.text === "N") {
      clearPending();
      stepTableSearch(-1);
      return true;
    }

    clearPending();
    return false;
  };

  const handleJsonKey = (key: Key): boolean => {
    if (!jsonHandle) return false;
    const isPlain = !key.ctrl && !key.meta;
    if (jsonHandle.pending() === "" && isPlain && (key.text === "/" || key.text === "?")) {
      openJsonSearch(key.text === "/" ? 1 : -1);
      return true;
    }
    const leader = config.config().leader;
    const isLeader =
      leader === "space"
        ? !key.ctrl && !key.meta && key.name === "space"
        : !key.ctrl && !key.meta && key.text === leader;
    if (jsonHandle.pending() === "" && isLeader) {
      return false;
    }
    return jsonHandle.feed(key) === "handled";
  };

  const moveRecordField = (delta: number) => {
    const res = currentResult();
    if (!res) return;
    const maxField = Math.max(0, res.columns.length - 1);
    setFieldCursor((prev) => Math.max(0, Math.min(maxField, prev + delta)));
  };

  const setRecordField = (idx: number) => {
    const res = currentResult();
    if (!res) return;
    const maxField = Math.max(0, res.columns.length - 1);
    setFieldCursor(Math.max(0, Math.min(maxField, idx)));
  };

  const handleRecordKey = (key: Key): boolean => {
    const res = currentResult();
    if (!res) return false;
    const isPlain = !key.ctrl && !key.meta;

    if (pendingOp() === "g") {
      setPendingOp("");
      const { hasExplicitCount, count } = takeCount();
      if (isPlain && key.text === "g") {
        setRecordField(hasExplicitCount ? count - 1 : 0);
        return true;
      }
      return false;
    }

    if (isPlain && key.text && /^[1-9]$/.test(key.text)) {
      setPendingCount((prev) => prev + key.text!);
      return true;
    }

    if (isPlain && key.text === "0" && pendingCount() !== "") {
      setPendingCount((prev) => prev + "0");
      return true;
    }

    if (isPlain && key.text === "g") {
      setPendingOp("g");
      return true;
    }

    if (isPlain && (key.text === "j" || key.name === "down")) {
      const { count } = takeCount();
      moveRecordField(count);
      return true;
    }

    if (isPlain && (key.text === "k" || key.name === "up")) {
      const { count } = takeCount();
      moveRecordField(-count);
      return true;
    }

    if (isPlain && key.text === "G") {
      const { count, hasExplicitCount } = takeCount();
      const target = hasExplicitCount ? count - 1 : Math.max(0, res.columns.length - 1);
      setRecordField(target);
      return true;
    }

    if (key.ctrl && !key.meta && key.name === "d") {
      clearPending();
      const half = Math.max(1, Math.floor(recordBoxHeight / 2));
      moveRecordField(half);
      return true;
    }

    if (key.ctrl && !key.meta && key.name === "u") {
      clearPending();
      const half = Math.max(1, Math.floor(recordBoxHeight / 2));
      moveRecordField(-half);
      return true;
    }

    if (isPlain && key.text === "y") {
      clearPending();
      const curRow = clampedCursor().row;
      const fIdx = clampedFieldCursor();
      if (curRow >= 0 && curRow < res.rows.length && fIdx >= 0 && fIdx < res.columns.length) {
        const rawCell = res.rows[curRow]?.[fIdx] ?? null;
        if (rawCell !== null && typeof rawCell === "object") {
          copyText(JSON.stringify(rawCell, null, 2));
        } else {
          copyText(cellText(rawCell));
        }
      }
      return true;
    }

    if (isPlain && key.text === "Y") {
      clearPending();
      const curRow = clampedCursor().row;
      if (res.rows.length > 0) {
        copyText(rowsToJson(res, [curRow]));
      }
      return true;
    }

    if ((isPlain && key.text === "q") || key.name === "escape") {
      clearPending();
      const prev = returnView();
      setViewSignal(prev === "record" ? "table" : prev);
      return true;
    }

    clearPending();
    return false;
  };

  function onKey(key: Key): boolean {
    if (!key.ctrl && !key.meta && key.name === "tab") {
      if (!currentResult()) return false;
      cycleView(key.shift ? -1 : 1);
      return true;
    }

    const v = view();
    if (v === "table") return handleTableKey(key);
    if (v === "json") return handleJsonKey(key);
    if (v === "record") return handleRecordKey(key);
    return false;
  }

  keys.setPaneHandler("results", onKey);
  onCleanup(() => {
    keys.setPaneHandler("results", null);
  });

  status.register("results", () => {
    const res = currentResult();
    const v = view();
    if (res && v === "json" && jsonHandle) {
      const cur = jsonHandle.cursor();
      return {
        mode: MODE_LABELS[jsonHandle.mode()],
        pending: jsonHandle.pending(),
        position: `${cur.row + 1}:${cur.col + 1}`,
      };
    }
    const mode = res && v === "table" && rowSelectionAnchor() !== null ? "V-LINE" : "NORMAL";
    const pending = pendingCount() + pendingOp();
    const cur = clampedCursor();
    const position = res && v === "table" ? `${cur.row + 1}:${cur.column + 1}` : "";
    return { mode, pending, position };
  });

  commands.register({
    id: "view.table",
    title: "Table view",
    group: "View",
    keys: "v t",
    run: () => setView("table"),
  });

  commands.register({
    id: "view.json",
    title: "JSON view",
    group: "View",
    keys: "v j",
    run: () => setView("json"),
  });

  commands.register({
    id: "view.record",
    title: "Record view",
    group: "View",
    keys: "v r",
    run: () => setView("record"),
  });

  commands.register({
    id: "view.set",
    title: "Set the Result view",
    ex: ["view"],
    run: (_ctx, args) => {
      const arg = args.trim();
      if (arg === "table" || arg === "json" || arg === "record") {
        setView(arg);
        return;
      }
      throw new Error(`Unknown view: ${arg} (table, json or record)`);
    },
  });

  const api: ResultsApi = {
    view,
    setView,
    cursor: clampedCursor,
  };

  props.expose?.(api);

  const summaryText = createMemo(() => {
    const outcome = session.shown();
    if (!outcome || !outcome.ok) return null;
    const res = outcome.result;
    const dur = formatDuration(res.durationMs);
    if (res.columns.length > 0) {
      const count = config.animations() ? animatedCount() : res.rows.length;
      const unit = count === 1 ? "row" : "rows";
      const prefix = res.truncated ? `first ${count} ${unit}` : `${count} ${unit}`;
      return `${prefix} · ${dur}`;
    }
    return `${printable(res.command)} · ${dur}`;
  });

  const headerElement = (
    <box height={1} width="100%" flexDirection="row" gap={2}>
      <text fg={theme.color("textMuted")} attributes={TextAttributes.BOLD} flexShrink={0}>
        RESULTS
      </text>
      <box flexDirection="row" gap={1} flexShrink={0}>
        <For each={VIEWS}>
          {(item) => {
            const isActive = () => view() === item.id;
            return (
              <text
                fg={isActive() ? theme.color("primary") : theme.color("textMuted")}
                attributes={isActive() ? TextAttributes.BOLD : undefined}
                flexShrink={0}
              >
                {item.label}
              </text>
            );
          }}
        </For>
      </box>
      <Show
        when={session.running() !== null}
        fallback={
          <Switch>
            <Match when={session.shown() && !session.shown()!.ok}>
              <text fg={theme.color("error")} flexShrink={0}>
                error
              </text>
            </Match>
            <Match when={summaryText() !== null}>
              <text fg={theme.color("textMuted")} flexShrink={0}>
                {summaryText()!}
              </text>
            </Match>
          </Switch>
        }
      >
        <Spinner label="running" />
      </Show>
    </box>
  );

  return (
    <PaneFrame pane="results" title={headerElement}>
      <Switch
        fallback={
          <text fg={theme.color("textMuted")}>Run a statement with Enter</text>
        }
      >
        <Match when={session.shown() && !session.shown()!.ok}>
          {(() => {
            const err = () => (session.shown() as Extract<RunOutcome, { ok: false }>).error;
            return (
              <box flexDirection="column" width="100%">
                <text fg={theme.color("error")}>{printable(err().message)}</text>
                <Show when={err().detail !== undefined && err().detail !== ""}>
                  <text fg={theme.color("textMuted")}>
                    {`Detail: ${printable(err().detail!)}`}
                  </text>
                </Show>
                <Show when={err().hint !== undefined && err().hint !== ""}>
                  <text fg={theme.color("textMuted")}>
                    {`Hint: ${printable(err().hint!)}`}
                  </text>
                </Show>
              </box>
            );
          })()}
        </Match>
        <Match
          when={
            session.shown() &&
            session.shown()!.ok &&
            (session.shown() as Extract<RunOutcome, { ok: true }>).result.columns.length === 0
          }
        >
          {(() => {
            const res = () => (session.shown() as Extract<RunOutcome, { ok: true }>).result;
            return (
              <box flexDirection="column" width="100%">
                <text fg={theme.color("text")}>{printable(res().command)}</text>
                <Show when={res().affected !== null}>
                  <text fg={theme.color("textMuted")}>
                    {res().affected === 1
                      ? "1 row affected"
                      : `${res().affected} rows affected`}
                  </text>
                </Show>
              </box>
            );
          })()}
        </Match>
        <Match when={currentResult() !== null}>
          <Switch>
            <Match when={view() === "table"}>
              <ResultGrid
                result={currentResult()!}
                cursor={clampedCursor()}
                selectedRows={selectedRowsRange()}
                flash={flash()}
                onViewport={(_vp, h) => {
                  gridBoxHeight = h;
                }}
              />
            </Match>
            <Match when={view() === "json"}>
              <JsonView
                result={currentResult()!}
                active={focus.pane() === "results"}
                onReady={(h) => {
                  jsonHandle = h;
                }}
              />
            </Match>
            <Match when={view() === "record"}>
              <RecordView
                result={currentResult()!}
                row={clampedCursor().row}
                fieldCursor={clampedFieldCursor()}
                onHeight={(h) => {
                  recordBoxHeight = h;
                }}
              />
            </Match>
          </Switch>
        </Match>
      </Switch>
    </PaneFrame>
  );
}
