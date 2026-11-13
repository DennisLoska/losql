import { createEffect, createSignal, type JSX, onCleanup } from "solid-js";
import { type CopyResult, copyToClipboard } from "../../../core/clipboard";
import { highlightJson, highlightSql } from "../../../core/sql/highlight";
import type { Position, Range, TextBuffer } from "../../../core/vim/buffer";
import { VimEngine, type VimMode, type VimOptions } from "../../../core/vim/engine";
import type { Key } from "../../../core/vim/keys";
import { sqlStatementRange } from "../../../core/vim/sql";
import { useConfig } from "../../context/config";
import { useDeps } from "../../context/deps";
import { useStatus } from "../../context/status";
import { useTheme } from "../../context/theme";
import { printable } from "../../ui/printable";
import { EditBufferTextBuffer, isAsciiPrintable, toBufferCol } from "./edit-buffer-text";
import { spansByLine } from "./line-spans";
import { VimTextareaRenderable } from "./VimTextareaRenderable";

void VimTextareaRenderable;

export interface VimTextareaHandle {
  engine: VimEngine;
  buffer: TextBuffer;
  text(): string;
  setText(text: string): void;
  feed(key: Key): "handled" | "ignored";
  mode(): VimMode;
  pending(): string;
  cursor(): Position;
  markError(offset: number | null): void;
}

function isBlankChar(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function wordSpanAt(text: string, offset: number): { start: number; end: number } | null {
  if (text.length === 0) return null;
  const idx = Math.max(0, Math.min(text.length - 1, offset));
  if (isBlankChar(text[idx]!)) {
    return { start: idx, end: idx + 1 };
  }
  let start = idx;
  while (start > 0 && !isBlankChar(text[start - 1]!)) {
    start--;
  }
  let end = idx + 1;
  while (end < text.length && !isBlankChar(text[end]!)) {
    end++;
  }
  return { start, end };
}

export const SYNC_HIGHLIGHT_MAX_CHARS = 50_000;

const ALL_STYLE_ROLES = [
  "keyword",
  "function",
  "variable",
  "string",
  "number",
  "type",
  "operator",
  "punctuation",
  "comment",
  "search",
  "error",
  "flash",
] as const;

interface LineHighlightEntry {
  start: number;
  end: number;
  styleId: number;
  priority?: number;
}

interface AppliedLineState {
  text: string;
  utf16Spans: LineHighlightEntry[];
  highlights: LineHighlightEntry[];
}

function sameLineHighlights(a: readonly LineHighlightEntry[], b: readonly LineHighlightEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.start !== y.start ||
      x.end !== y.end ||
      x.styleId !== y.styleId ||
      (x.priority ?? 0) !== (y.priority ?? 0)
    ) {
      return false;
    }
  }
  return true;
}

export function VimTextarea(props: {
  language: "sql" | "json";
  initialText?: string;
  readOnly?: boolean;
  active: boolean;
  visible?: boolean;
  lineNumbers?: boolean;
  onReady: (handle: VimTextareaHandle) => void;
  onChange?: (text: string) => void;
}): JSX.Element {
  const deps = useDeps();
  const config = useConfig();
  const status = useStatus();
  const theme = useTheme();

  const [mode, setMode] = createSignal<VimMode>("normal");
  const [pending, setPending] = createSignal<string>("");
  const [cursor, setCursor] = createSignal<Position>({ row: 0, col: 0 });

  let textareaRef: VimTextareaRenderable | null = null;
  let buffer: EditBufferTextBuffer | null = null;
  let errorSpan: { start: number; end: number } | null = null;
  let flashRange: Range | null = null;
  let cancelFlash: (() => void) | null = null;
  let cancelDeferredHighlight: (() => void) | null = null;
  let cleanEngineListeners: (() => void) | null = null;
  // Set when the component is disposed: a copy that finishes later changes nothing.
  let disposed = false;
  // The copy the engine asked for just before it reports the yank: the yank
  // flashes only once that copy happened.
  let pendingCopy: Promise<CopyResult> | null = null;

  const stopFlash = () => {
    if (cancelFlash) {
      cancelFlash();
      cancelFlash = null;
    }
    flashRange = null;
  };

  const stopDeferredHighlight = () => {
    if (cancelDeferredHighlight) {
      cancelDeferredHighlight();
      cancelDeferredHighlight = null;
    }
  };

  onCleanup(() => {
    disposed = true;
    pendingCopy = null;
    stopFlash();
    stopDeferredHighlight();
    cleanEngineListeners?.();
    cleanEngineListeners = null;
  });

  const setup = (ref: VimTextareaRenderable) => {
    if (textareaRef === ref) return;
    textareaRef = ref;

    ref.cursorStyle = { style: "block", blinking: false };
    const textBuffer = new EditBufferTextBuffer(ref, () => theme.color("selection"));
    buffer = textBuffer;
    textBuffer.setText(props.initialText ?? "");
    textBuffer.setCursor({ row: 0, col: 0 });

    const makeOptions = (): VimOptions => ({
      readOnly: props.readOnly,
      clipboard: (text) => {
        const copy = copyToClipboard(text, {
          write: deps.write,
          which: deps.which,
          exec: deps.exec,
        });
        pendingCopy = copy;
        void copy.then((res) => {
          if (!disposed && !res.ok) status.say(`Could not copy: ${printable(res.reason)}`, "error");
        });
      },
      statementRange: props.language === "sql" ? sqlStatementRange(textBuffer) : undefined,
      pageSize: () => Math.max(1, ref.height || 20),
    });

    let appliedLines: AppliedLineState[] = [];
    let lastSyntax: unknown = null;
    // Counts changes of the text, so a late yank flash can tell it is stale.
    let changes = 0;

    const origSetText = textBuffer.setText.bind(textBuffer);
    textBuffer.setText = (text: string) => {
      changes++;
      origSetText(text);
      appliedLines = [];
    };

    const collectRangeUtf16Spans = (
      outByRow: LineHighlightEntry[][],
      range: Range,
      styleId: number,
      priority: number,
    ) => {
      const lineCount = outByRow.length;
      if (lineCount === 0) return;
      const maxRow = lineCount - 1;
      const startRow = Math.max(0, Math.min(maxRow, range.start.row));
      const endRow = Math.max(0, Math.min(maxRow, range.end.row));
      for (let r = startRow; r <= endRow; r++) {
        const lineText = textBuffer.line(r);
        const startUtf16 = r === startRow ? range.start.col : 0;
        const endUtf16 = r === endRow ? range.end.col : lineText.length;
        if (endUtf16 > startUtf16) {
          outByRow[r]!.push({ start: startUtf16, end: endUtf16, styleId, priority });
        }
      }
    };

    const convertLineSpans = (
      editBuffer: typeof ref.editBuffer,
      lineText: string,
      utf16Spans: readonly LineHighlightEntry[],
    ): LineHighlightEntry[] => {
      if (utf16Spans.length === 0) return [];
      const ascii = isAsciiPrintable(lineText);
      const out: LineHighlightEntry[] = [];
      for (let i = 0; i < utf16Spans.length; i++) {
        const s = utf16Spans[i]!;
        const start = toBufferCol(editBuffer, lineText, s.start, ascii);
        const end = toBufferCol(editBuffer, lineText, s.end, ascii);
        if (end > start) {
          if (s.priority !== undefined) {
            out.push({ start, end, styleId: s.styleId, priority: s.priority });
          } else {
            out.push({ start, end, styleId: s.styleId });
          }
        }
      }
      return out;
    };

    const rebuildHighlights = (forceAll = false) => {
      stopDeferredHighlight();
      if (ref.isDestroyed) return;
      const editBuffer = ref.editBuffer;
      const syntax = theme.syntax();
      ref.syntaxStyle = syntax;

      const themeChanged = forceAll || syntax !== lastSyntax;
      lastSyntax = syntax;

      const styleIds: Record<string, number | null> = {};
      for (const role of ALL_STYLE_ROLES) {
        styleIds[role] = syntax.resolveStyleId(role);
      }

      const fullText = textBuffer.text();
      const lineCount = textBuffer.lineCount();
      const rawSpans =
        props.language === "sql" ? highlightSql(fullText) : highlightJson(fullText);
      const pieces = spansByLine(fullText, rawSpans);

      const utf16ByRow: LineHighlightEntry[][] = Array.from({ length: lineCount }, () => []);

      for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i]!;
        if (piece.role === "text") continue;
        const styleId = styleIds[piece.role];
        if (styleId === null || styleId === undefined) continue;
        if (piece.end > piece.start) {
          utf16ByRow[piece.row]!.push({ start: piece.start, end: piece.end, styleId });
        }
      }

      const searchStyleId = styleIds.search;
      if (searchStyleId !== null && searchStyleId !== undefined) {
        const matches = handle.engine.searchMatches();
        for (let i = 0; i < matches.length; i++) {
          collectRangeUtf16Spans(utf16ByRow, matches[i]!, searchStyleId, 1);
        }
      }

      const errorStyleId = styleIds.error;
      if (errorSpan && errorStyleId !== null && errorStyleId !== undefined) {
        const errPieces = spansByLine(fullText, [
          { start: errorSpan.start, end: errorSpan.end, role: "error" },
        ]);
        for (const piece of errPieces) {
          if (piece.end > piece.start) {
            utf16ByRow[piece.row]!.push({
              start: piece.start,
              end: piece.end,
              styleId: errorStyleId,
              priority: 1,
            });
          }
        }
      }

      const flashStyleId = styleIds.flash;
      if (flashRange && flashStyleId !== null && flashStyleId !== undefined) {
        collectRangeUtf16Spans(utf16ByRow, flashRange, flashStyleId, 1);
      }

      if (themeChanged) {
        editBuffer.clearAllHighlights();
        const nextApplied: AppliedLineState[] = new Array(lineCount);
        for (let r = 0; r < lineCount; r++) {
          const lineText = textBuffer.line(r);
          const utf16Spans = utf16ByRow[r]!;
          const hls = convertLineSpans(editBuffer, lineText, utf16Spans);
          for (let j = 0; j < hls.length; j++) {
            editBuffer.addHighlight(r, hls[j]!);
          }
          nextApplied[r] = { text: lineText, utf16Spans, highlights: hls };
        }
        appliedLines = nextApplied;
      } else {
        const nextApplied: AppliedLineState[] = new Array(lineCount);
        for (let r = 0; r < lineCount; r++) {
          const lineText = textBuffer.line(r);
          const utf16Spans = utf16ByRow[r]!;
          const prev = appliedLines[r];
          if (prev && prev.text === lineText && sameLineHighlights(prev.utf16Spans, utf16Spans)) {
            nextApplied[r] = prev;
            continue;
          }
          const hls = convertLineSpans(editBuffer, lineText, utf16Spans);
          if (!prev || prev.text !== lineText || !sameLineHighlights(prev.highlights, hls)) {
            if (!prev || prev.highlights.length > 0 || prev.text !== lineText) {
              editBuffer.clearLineHighlights(r);
            }
            for (let j = 0; j < hls.length; j++) {
              editBuffer.addHighlight(r, hls[j]!);
            }
          }
          nextApplied[r] = { text: lineText, utf16Spans, highlights: hls };
        }
        appliedLines = nextApplied;
      }

      ref.requestRender();
    };

    const scheduleOrRebuildHighlights = () => {
      if (ref.isDestroyed) return;
      if (textBuffer.text().length <= SYNC_HIGHLIGHT_MAX_CHARS) {
        rebuildHighlights();
        return;
      }
      if (cancelDeferredHighlight !== null) return;
      cancelDeferredHighlight = deps.clock.after(16, () => {
        cancelDeferredHighlight = null;
        if (ref.isDestroyed) return;
        rebuildHighlights();
      });
    };

    const syncSignals = () => {
      const eng = handle.engine;
      const m = eng.mode;
      setMode(m);
      setPending(eng.pending);
      setCursor(textBuffer.cursor());
      ref.cursorStyle =
        m === "insert"
          ? { style: "line", blinking: false }
          : { style: "block", blinking: false };
    };

    const wireEngine = (eng: VimEngine) => {
      cleanEngineListeners?.();
      const origReset = eng.reset.bind(eng);
      eng.reset = () => {
        origReset();
        setPending(eng.pending);
      };

      const offMode = eng.on("mode", () => {
        syncSignals();
      });
      const offChange = eng.on("change", () => {
        changes++;
        errorSpan = null;
        syncSignals();
        scheduleOrRebuildHighlights();
        props.onChange?.(textBuffer.text());
      });
      const offSearch = eng.on("search", () => {
        syncSignals();
        rebuildHighlights();
      });
      const offYank = eng.on("yank", (event) => {
        const copy = pendingCopy;
        pendingCopy = null;
        if (!config.animations()) return;
        const flash = () => {
          stopFlash();
          flashRange = event.range;
          rebuildHighlights();
          cancelFlash = deps.clock.after(150, () => {
            flashRange = null;
            cancelFlash = null;
            rebuildHighlights();
          });
        };
        if (!copy) {
          flash();
          return;
        }
        // Flash once the copy happened, unless the text changed meanwhile
        // (the range would no longer be what was yanked).
        const changesAtYank = changes;
        void copy.then((res) => {
          if (!disposed && res.ok && changes === changesAtYank && config.animations()) flash();
        });
      });

      cleanEngineListeners = () => {
        offMode();
        offChange();
        offSearch();
        offYank();
      };
    };

    let inFeed = false;
    const origSetCursor = textBuffer.setCursor.bind(textBuffer);
    textBuffer.setCursor = (pos: Position) => {
      if (!inFeed && handle) {
        inFeed = true;
        try {
          handle.engine.moveTo(pos);
        } finally {
          inFeed = false;
        }
        return;
      }
      origSetCursor(pos);
      setCursor(textBuffer.cursor());
    };

    const initialEngine = new VimEngine(textBuffer, makeOptions());

    const handle: VimTextareaHandle = {
      engine: initialEngine,
      buffer: textBuffer,
      text: () => textBuffer.text(),
      setText(nextText: string) {
        stopFlash();
        stopDeferredHighlight();
        errorSpan = null;
        textBuffer.setSelection(null);
        textBuffer.setText(nextText);
        textBuffer.setCursor({ row: 0, col: 0 });
        const nextEngine = new VimEngine(textBuffer, makeOptions());
        handle.engine = nextEngine;
        wireEngine(nextEngine);
        syncSignals();
        rebuildHighlights(true);
      },
      feed(key: Key): "handled" | "ignored" {
        inFeed = true;
        try {
          const res = handle.engine.feed(key);
          syncSignals();
          return res;
        } finally {
          inFeed = false;
        }
      },
      mode,
      pending,
      cursor,
      markError(offset: number | null) {
        errorSpan = offset === null ? null : wordSpanAt(textBuffer.text(), offset);
        rebuildHighlights();
      },
    };

    wireEngine(initialEngine);
    syncSignals();
    rebuildHighlights(true);

    createEffect(() => {
      theme.syntax();
      const selColor = theme.color("selection");
      const sel = textBuffer.selection();
      if (sel) {
        ref.editorView.setSelectionColors(selColor);
      }
      rebuildHighlights(true);
    });

    props.onReady(handle);
  };

  const renderTextarea = () => (
    <vim_textarea
      ref={setup}
      flexGrow={1}
      width="100%"
      height="100%"
      textColor={theme.color("text")}
      focusedTextColor={theme.color("text")}
      backgroundColor={theme.color("paneBackground")}
      syntaxStyle={theme.syntax()}
      focused={props.active}
      showCursor={props.active}
      visible={props.visible ?? true}
      wrapMode="none"
    />
  );

  return (
    <>
      {(props.lineNumbers ?? true) ? (
        <line_number
          fg={theme.color("textMuted")}
          bg={theme.color("paneBackground")}
          minWidth={3}
          paddingRight={1}
          flexGrow={1}
          width="100%"
          visible={props.visible ?? true}
        >
          {renderTextarea()}
        </line_number>
      ) : (
        renderTextarea()
      )}
    </>
  );
}
