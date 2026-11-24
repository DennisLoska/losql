import { TextAttributes } from "@opentui/core";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { copyToClipboard } from "../../../core/clipboard";
import { cellText } from "../../../core/db/format";
import { extractPassword } from "../../../core/db/postgres";
import { redactConnectionText, redactMessage } from "../../../core/db/redact";
import type { Driver, RelationDetails, RelationRef, Result } from "../../../core/db/types";
import type { VimMode } from "../../../core/vim/engine";
import type { Key } from "../../../core/vim/keys";
import { useCmdline, useCommands } from "../../context/commands";
import { useConfig } from "../../context/config";
import { useDeps } from "../../context/deps";
import { useDialog } from "../../context/dialog";
import { type PaneId, useFocus } from "../../context/focus";
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
import { detailsFromSnapshot, findRelation, pickRelation, sameRelation } from "./relations";
import {
  DETAIL_MAX_ROWS,
  definitionText,
  detailRows,
  detailWindow,
  sectionsOf,
  sectionTable,
  type StructureSection,
  type StructureState,
  StructureView,
  wrapRanges,
} from "./StructureView";

export type { StructureSection, StructureState } from "./StructureView";

export type ResultView = "table" | "json" | "record";

export interface ResultsApi {
  view(): ResultView;
  setView(view: ResultView): void;
  cursor(): { row: number; column: number };
  /** Opens the Structure of a Relation in the Results Pane and focuses it. */
  inspect(ref: RelationRef): void;
  /** The Structure shown instead of the Result view, or null. */
  structure(): StructureState | null;
  /** The Relation most recently inspected, kept after Structure closes (the picker preselects it). */
  lastInspected(): RelationRef | null;
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
  const dialog = useDialog();

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
  let gridRowCount = 8;
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
      // A new outcome opens in the Table view, so Structure returns there too.
      if (structureReturn) structureReturn.view = "table";
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

  // ── Structure ────────────────────────────────────────────────────────────
  // Structure replaces the Result view while it is open; it never touches `session.shown()`. Each load
  // is tagged with a request id, the Session id and the Driver it was sent to, and its completion is
  // accepted only while all three are still current.
  const [structure, setStructure] = createSignal<StructureState | null>(null);
  const [structureCursor, setStructureCursor] = createSignal({ row: 0, column: 0 });
  const [structurePendingG, setStructurePendingG] = createSignal(false);
  const [detailOpen, setDetailOpen] = createSignal(false);
  const [definitionTop, setDefinitionTop] = createSignal(0);
  const [detailTop, setDetailTop] = createSignal(0);
  // The measured Definition viewport and Enter detail width; 0 until the first layout.
  const [definitionViewport, setDefinitionViewport] = createSignal({ width: 0, height: 8 });
  const [detailWidth, setDetailWidth] = createSignal(0);
  // The measured height of the section the Enter detail opens in; DETAIL_MAX_ROWS until the first layout.
  const [detailMaxRows, setDetailMaxRows] = createSignal(DETAIL_MAX_ROWS);
  const [structureFlash, setStructureFlash] = createSignal<FlashSpec | null>(null);
  const [lastInspected, setLastInspected] = createSignal<RelationRef | null>(null);

  // Where q returns: saved on the first entry, kept while the target changes.
  let structureReturn: { view: ResultView; pane: PaneId } | null = null;
  // Bumped on every entry from closed, so a picker opened from one Structure cannot act on another.
  let structureEntry = 0;
  let loadSeq = 0;
  let loadController: AbortController | null = null;
  let loadSessionId = -1;
  let loadRevision = -1;
  let structureGridRows = 8;
  let cancelStructureFlash: (() => void) | null = null;

  const stopStructureFlash = () => {
    cancelStructureFlash?.();
    cancelStructureFlash = null;
    setStructureFlash(null);
  };

  const abortLoad = () => {
    loadSeq++;
    loadController?.abort();
    loadController = null;
  };

  onCleanup(() => {
    abortLoad();
    stopStructureFlash();
  });

  // Also while a reload of the same Relation is in flight: what it showed stays usable until then.
  const structureTable = createMemo(() => {
    const state = structure();
    if (!state || !state.details) return null;
    return sectionTable(state.details, state.section);
  });

  // The cursor kept inside the section shown, so a reload that shrinks it never leaves it past the end.
  const clampedStructureCursor = createMemo(() => {
    const table = structureTable();
    const cur = structureCursor();
    if (!table) return { row: 0, column: 0 };
    return {
      row: Math.max(0, Math.min(table.rows.length - 1, cur.row)),
      column: Math.max(0, Math.min(table.columns.length - 1, cur.column)),
    };
  });

  const detailShown = createMemo(() => detailOpen() && (structureTable()?.rows.length ?? 0) > 0);
  const structureDetailRows = createMemo(() =>
    detailShown() ? detailRows(structureTable(), clampedStructureCursor(), detailWidth()) : [],
  );
  const maxDetailTop = () => {
    const total = structureDetailRows().length;
    return Math.max(0, total - detailWindow(total, detailMaxRows()).visible);
  };
  const clampedDetailTop = createMemo(() => Math.max(0, Math.min(maxDetailTop(), detailTop())));

  const definitionRows = createMemo(() =>
    wrapRanges(definitionText(structure()?.details ?? null), definitionViewport().width),
  );
  const definitionHeight = () => Math.max(1, definitionViewport().height);
  const maxDefinitionTop = () => Math.max(0, definitionRows().length - definitionHeight());
  const clampedDefinitionTop = createMemo(() => Math.max(0, Math.min(maxDefinitionTop(), definitionTop())));

  const safeError = (err: unknown, driver: Driver): string => {
    const raw = err instanceof Error ? err.message : String(err);
    const url = driver.connection.url;
    return printable(redactConnectionText(redactMessage(raw, { url, password: extractPassword(url) })));
  };

  const settleLoad = (details: RelationDetails | null) => {
    setStructure((prev) => {
      if (!prev) return prev;
      if (details === null) return { ref: prev.ref, status: "missing", details: null, section: prev.section };
      const section = sectionsOf(details).includes(prev.section) ? prev.section : "columns";
      return { ref: prev.ref, status: "ready", details, section };
    });
    // A reload may shrink what was shown: keep the cursor and scroll positions inside it.
    setStructureCursor(untrack(clampedStructureCursor));
    if (!untrack(detailShown)) setDetailOpen(false);
    setDetailTop(untrack(clampedDetailTop));
    setDefinitionTop(untrack(clampedDefinitionTop));
  };

  const loadStructure = (ref: RelationRef, section: StructureSection, keepDetails: boolean) => {
    abortLoad();
    const id = loadSeq;
    const sessionId = untrack(session.sessionId);
    const driver = untrack(session.driver);
    loadSessionId = sessionId;
    loadRevision = untrack(session.schemaRevision);
    setStructure((prev) => ({
      ref,
      status: "loading",
      // A reload of the same Relation keeps what it showed until the new Structure arrives.
      details: keepDetails && prev && sameRelation(prev.ref, ref) ? prev.details : null,
      section,
    }));
    if (!driver) {
      setStructure({ ref, status: "error", details: null, error: "Not connected", section });
      return;
    }
    if (!driver.describeRelation) {
      const relation = findRelation(untrack(session.schema), ref);
      settleLoad(relation ? detailsFromSnapshot(ref, relation) : null);
      return;
    }
    const controller = new AbortController();
    loadController = controller;
    const current = () =>
      !disposed && id === loadSeq && sessionId === session.sessionId() && driver === session.driver();
    let pending: Promise<RelationDetails | null>;
    try {
      pending = driver.describeRelation(ref, { signal: controller.signal });
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending.then(
      (details) => {
        if (!current()) return;
        if (loadController === controller) loadController = null;
        settleLoad(details);
      },
      (err) => {
        if (!current()) return;
        if (loadController === controller) loadController = null;
        setStructure((prev) =>
          prev ? { ref: prev.ref, status: "error", details: null, error: safeError(err, driver), section: prev.section } : prev,
        );
      },
    );
  };

  const resetStructureCursor = () => {
    setStructureCursor({ row: 0, column: 0 });
    setStructurePendingG(false);
    setDetailOpen(false);
    setDetailTop(0);
    setDefinitionTop(0);
    stopStructureFlash();
  };

  function inspect(ref: RelationRef): void {
    const open = untrack(structure);
    if (open === null) {
      structureReturn = { view: untrack(view), pane: untrack(focus.pane) };
      structureEntry++;
    }
    const target = { namespace: ref.namespace, name: ref.name };
    setLastInspected(target);
    resetStructureCursor();
    loadStructure(target, "columns", false);
    focus.focus("results");
  }

  function closeStructure(options: { restore: boolean }): void {
    abortLoad();
    resetStructureCursor();
    const back = structureReturn;
    structureReturn = null;
    setStructure(null);
    if (options.restore && back) {
      setViewSignal(back.view);
      focus.focus(back.pane);
    }
  }

  const reloadStructure = () => {
    const state = untrack(structure);
    if (state) loadStructure(state.ref, state.section, true);
  };

  // A new Session ends Structure: the Relation belongs to the Driver that is gone.
  createEffect(
    on(session.sessionId, () => {
      if (untrack(structure) !== null) closeStructure({ restore: true });
    }, { defer: true }),
  );

  // A committed schema refresh for the same Session reloads the open Structure.
  createEffect(
    on(session.schemaRevision, (revision) => {
      if (untrack(structure) === null) return;
      if (untrack(session.sessionId) !== loadSessionId || revision <= loadRevision) return;
      reloadStructure();
    }, { defer: true }),
  );

  const openStructurePicker = () => {
    const state = untrack(structure);
    if (!state) return;
    const entry = structureEntry;
    const sessionId = untrack(session.sessionId);
    void pickRelation(dialog, untrack(session.schema), state.ref)
      .then((chosen) => {
        if (chosen === null || disposed) return;
        if (entry !== structureEntry || untrack(structure) === null) return;
        if (sessionId !== untrack(session.sessionId)) return;
        inspect(chosen);
      })
      .catch((err) => {
        status.say(printable(err instanceof Error ? err.message : String(err)), "error");
      });
  };

  const setSection = (section: StructureSection) => {
    setStructure((prev) => (prev && prev.section !== section ? { ...prev, section } : prev));
    setStructureCursor({ row: 0, column: 0 });
    setDetailOpen(false);
    setDetailTop(0);
    setDefinitionTop(0);
    stopStructureFlash();
  };

  const moveStructureCursor = (dRow: number, dCol: number, absolute?: { row?: number; column?: number }) => {
    const table = structureTable();
    if (!table) return;
    const cur = clampedStructureCursor();
    const maxRow = Math.max(0, table.rows.length - 1);
    const maxCol = Math.max(0, table.columns.length - 1);
    const row = absolute?.row ?? cur.row + dRow;
    const column = absolute?.column ?? cur.column + dCol;
    setStructureCursor({
      row: Math.max(0, Math.min(maxRow, row)),
      column: Math.max(0, Math.min(maxCol, column)),
    });
    setDetailTop(0);
  };

  const scrollDefinition = (delta: number, absolute?: number) => {
    const next = absolute ?? clampedDefinitionTop() + delta;
    setDefinitionTop(Math.max(0, Math.min(maxDefinitionTop(), next)));
  };

  // Whether the open Enter detail has more rows than it shows; its scroll keys take over only then.
  const detailScrollable = () => detailWindow(structureDetailRows().length, detailMaxRows()).scrollable;
  const scrollDetail = (delta: number, absolute?: number) => {
    const next = absolute ?? clampedDetailTop() + delta;
    setDetailTop(Math.max(0, Math.min(maxDetailTop(), next)));
  };

  const yankStructure = () => {
    const state = structure();
    if (!state || !state.details) return;
    let text: string | undefined;
    let flashSpec: FlashSpec | null = null;
    if (state.section === "definition") {
      text = state.details.definition;
    } else {
      const table = structureTable();
      const cur = clampedStructureCursor();
      text = table?.rows[cur.row]?.[cur.column];
      flashSpec = { rows: new Set([cur.row]), column: cur.column };
    }
    if (text === undefined) return;
    const ref = state.ref;
    const section = state.section;
    void copyToClipboard(text, { write: deps.write, which: deps.which, exec: deps.exec }).then((res) => {
      if (disposed) return;
      if (!res.ok) {
        status.say(`Could not copy: ${printable(res.reason)}`, "error");
        return;
      }
      const now = untrack(structure);
      if (!now || !sameRelation(now.ref, ref) || now.section !== section) return;
      if (flashSpec && config.animations()) {
        stopStructureFlash();
        setStructureFlash(flashSpec);
        cancelStructureFlash = deps.clock.after(150, () => {
          cancelStructureFlash = null;
          setStructureFlash(null);
        });
      }
    });
  };

  const handleStructureKey = (key: Key): boolean => {
    const state = structure();
    if (!state) return false;
    const isPlain = !key.ctrl && !key.meta;
    const inDefinition = state.section === "definition";
    const inDetail = !inDefinition && detailShown() && detailScrollable();

    if (structurePendingG()) {
      setStructurePendingG(false);
      if (isPlain && key.text === "g") {
        if (inDefinition) scrollDefinition(0, 0);
        else if (inDetail) scrollDetail(0, 0);
        else moveStructureCursor(0, 0, { row: 0 });
        return true;
      }
    }

    if (isPlain && key.name === "tab") {
      const sections = sectionsOf(state.details);
      const idx = Math.max(0, sections.indexOf(state.section));
      const delta = key.shift ? -1 : 1;
      setSection(sections[(idx + delta + sections.length) % sections.length]!);
      return true;
    }
    if (isPlain && key.text && /^[1-4]$/.test(key.text)) {
      const wanted = (["columns", "indexes", "constraints", "definition"] as const)[Number(key.text) - 1]!;
      if (sectionsOf(state.details).includes(wanted)) setSection(wanted);
      return true;
    }
    if (isPlain && key.text === "q") {
      closeStructure({ restore: true });
      return true;
    }
    if (key.name === "escape" && !key.ctrl && !key.meta) {
      if (detailShown()) {
        setDetailOpen(false);
        setDetailTop(0);
        return true;
      }
      closeStructure({ restore: true });
      return true;
    }
    if (isPlain && key.text === "c") {
      openStructurePicker();
      return true;
    }
    if (isPlain && key.text === "R") {
      reloadStructure();
      return true;
    }
    if (isPlain && key.text === "y") {
      yankStructure();
      return true;
    }
    if (isPlain && key.text === "g") {
      setStructurePendingG(true);
      return true;
    }
    if (isPlain && key.name === "enter") {
      if (!inDefinition && structureTable()?.rows.length) {
        setDetailOpen(!detailShown());
        setDetailTop(0);
      }
      return true;
    }

    const half = (rows: number) => Math.max(1, Math.floor(rows / 2));
    if (inDefinition) {
      if (isPlain && (key.text === "j" || key.name === "down")) scrollDefinition(1);
      else if (isPlain && (key.text === "k" || key.name === "up")) scrollDefinition(-1);
      else if (isPlain && key.text === "G") scrollDefinition(0, Number.MAX_SAFE_INTEGER);
      else if (key.ctrl && !key.meta && key.name === "d") scrollDefinition(half(definitionHeight()));
      else if (key.ctrl && !key.meta && key.name === "u") scrollDefinition(-half(definitionHeight()));
      else return false;
      return true;
    }

    if (inDetail) {
      // The detail's own scroll keys; h, l, 0 and $ still move the cursor across the fields.
      const page = half(detailWindow(structureDetailRows().length, detailMaxRows()).visible);
      let handled = true;
      if (isPlain && (key.text === "j" || key.name === "down")) scrollDetail(1);
      else if (isPlain && (key.text === "k" || key.name === "up")) scrollDetail(-1);
      else if (isPlain && key.text === "G") scrollDetail(0, Number.MAX_SAFE_INTEGER);
      else if (key.ctrl && !key.meta && key.name === "d") scrollDetail(page);
      else if (key.ctrl && !key.meta && key.name === "u") scrollDetail(-page);
      else handled = false;
      if (handled) return true;
    }

    if (isPlain && (key.text === "j" || key.name === "down")) moveStructureCursor(1, 0);
    else if (isPlain && (key.text === "k" || key.name === "up")) moveStructureCursor(-1, 0);
    else if (isPlain && (key.text === "h" || key.name === "left")) moveStructureCursor(0, -1);
    else if (isPlain && (key.text === "l" || key.name === "right")) moveStructureCursor(0, 1);
    else if (isPlain && key.text === "0") moveStructureCursor(0, 0, { column: 0 });
    else if (isPlain && key.text === "$") moveStructureCursor(0, 0, { column: Number.MAX_SAFE_INTEGER });
    else if (isPlain && key.text === "G") moveStructureCursor(0, 0, { row: Number.MAX_SAFE_INTEGER });
    else if (key.ctrl && !key.meta && key.name === "d") moveStructureCursor(half(structureGridRows), 0);
    else if (key.ctrl && !key.meta && key.name === "u") moveStructureCursor(-half(structureGridRows), 0);
    else return false;
    return true;
  };

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
    if (untrack(structure) !== null) closeStructure({ restore: false });
    // q in Record returns to the view Record was entered from, so only entering Record records it.
    if (nextView === "record" && view() !== "record") setReturnView(view());
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
      const half = Math.max(1, Math.floor(gridRowCount / 2));
      moveTableCursor(half, 0);
      return true;
    }

    if (key.ctrl && !key.meta && key.name === "u") {
      clearPending();
      const half = Math.max(1, Math.floor(gridRowCount / 2));
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
    if (structure() !== null) return handleStructureKey(key);
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
    if (structure() !== null) {
      const cur = clampedStructureCursor();
      const table = structureTable();
      return {
        mode: "NORMAL",
        pending: structurePendingG() ? "g" : "",
        position: table && table.rows.length > 0 ? `${cur.row + 1}:${cur.column + 1}` : "",
      };
    }
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
    run: async (_ctx, args) => {
      const arg = args.trim();
      if (arg === "table" || arg === "json" || arg === "record") {
        setView(arg);
        return;
      }
      if (arg === "structure") {
        await commands.run("view.structure", "");
        return;
      }
      throw new Error(`Unknown view: ${arg} (table, json, record or structure)`);
    },
  });

  const api: ResultsApi = {
    view,
    setView,
    cursor: clampedCursor,
    inspect,
    structure,
    lastInspected,
  };

  props.expose?.(api);

  const summaryText = createMemo(() => {
    const outcome = session.shown();
    if (!outcome || !outcome.ok) return null;
    const res = outcome.result;
    const dur = formatDuration(res.durationMs);
    if (res.columns.length > 0) {
      // The count-up's first frame shows the final count, never "0 rows" for a Result that has rows.
      const animated = animatedCount();
      const count = !config.animations() || (animated === 0 && res.rows.length > 0) ? res.rows.length : animated;
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
            const isActive = () => structure() === null && view() === item.id;
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
        <text
          fg={structure() !== null ? theme.color("primary") : theme.color("textMuted")}
          attributes={structure() !== null ? TextAttributes.BOLD : undefined}
          flexShrink={0}
          onMouseDown={() => {
            void commands.run("view.structure", "");
          }}
        >
          Structure
        </text>
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
        <Match when={structure()}>
          {(state: () => StructureState) => (
            <StructureView
              state={state()}
              cursor={clampedStructureCursor()}
              detailRows={structureDetailRows()}
              detailTop={clampedDetailTop()}
              detailMaxRows={detailMaxRows()}
              definitionRows={definitionRows()}
              definitionTop={clampedDefinitionTop()}
              definitionHeight={definitionHeight()}
              flash={structureFlash()}
              onViewport={(vp) => {
                structureGridRows = vp.rowCount;
              }}
              onDefinitionViewport={(width, height) => {
                const prev = untrack(definitionViewport);
                if (prev.width !== width || prev.height !== height) setDefinitionViewport({ width, height });
              }}
              onDetailSize={(width, height) => {
                if (untrack(detailWidth) !== width) setDetailWidth(width);
                if (untrack(detailMaxRows) !== height) setDetailMaxRows(height);
              }}
            />
          )}
        </Match>
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
                onViewport={(vp) => {
                  gridRowCount = vp.rowCount;
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
