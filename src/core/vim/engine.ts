import { comparePositions, offsetToPosition, type Position, positionToOffset, type Range, type TextBuffer } from "./buffer";
import { type Key, keyFromEvent } from "./keys";
import {
  charLenAt,
  clampNormalColOnLine,
  firstNonBlankCol,
  isSurrogatePairAt,
  type FindKind,
  type FindState,
  type MotionContext,
  moveDown,
  moveFindCharWithResult,
  moveFirstNonBlank,
  moveGotoFirstLine,
  moveGotoLastLine,
  moveHalfPageDown,
  moveHalfPageUp,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveMatchBracket,
  moveParagraphBackward,
  moveParagraphForward,
  moveRight,
  moveUp,
  moveWordBackward,
  moveWordEnd,
  moveWordForward,
  moveWordForwardOperator,
  nextCharCol,
  prevCharCol,
} from "./motions";
import { type RegisterEntry, Registers } from "./registers";
import { compilePattern, findMatches } from "./search";
import { resolveTextObject } from "./textobjects";
import { UndoHistory, type UndoSnapshot } from "./undo";

export const MAX_COUNT = 999999;

export type VimMode = "normal" | "insert" | "visual" | "visual-line";

export interface VimOptions {
  readOnly?: boolean;
  clipboard?: (text: string) => void;
  statementRange?: (position: Position) => Range | null;
  pageSize?: () => number;
}

export interface YankEvent {
  range: Range;
  linewise: boolean;
  text: string;
}

type OperatorKind = "d" | "c" | "y" | ">" | "<";

type PrefixState =
  | { kind: "none" }
  | { kind: "g" }
  | { kind: "find"; findKind: FindKind }
  | { kind: "register" }
  | { kind: "replace" }
  | { kind: "textobj"; around: boolean };

interface RecordedChange {
  prefixKeys: Key[];
  count: number;
  bodyKeys: Key[];
}

type MotionShape = "exclusive" | "inclusive" | "linewise";

interface MotionOutcome {
  position: Position;
  vertical: boolean;
  shape: MotionShape;
  failed?: boolean;
  allowEmptyChange?: boolean;
}

const INVERT_FIND: Record<FindKind, FindKind> = {
  f: "F",
  F: "f",
  t: "T",
  T: "t",
};

const FUNCTION_KEYS = new Set(["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12"]);
const NORMAL_IGNORED_KEYS = new Set(["enter", "space", ":", "tab"]);
const NORMAL_IGNORED_CTRL = new Set(["w", "s", "p", "c", "h", "j", "k", "l", "enter"]);
const INSERT_IGNORED_CTRL = new Set(["n", "p", "s", "enter"]);

function isIgnoredInNormalOrVisual(key: Key): boolean {
  if (FUNCTION_KEYS.has(key.name)) return true;
  if (key.meta) return false;
  if (key.ctrl) return NORMAL_IGNORED_CTRL.has(key.name);
  return NORMAL_IGNORED_KEYS.has(key.name);
}

function isIgnoredInInsert(key: Key): boolean {
  if (FUNCTION_KEYS.has(key.name)) return true;
  return Boolean(key.ctrl) && !key.meta && INSERT_IGNORED_CTRL.has(key.name);
}

function leadingWhitespace(line: string): string {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) {
    i++;
  }
  return line.slice(0, i);
}

function isWordChar(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_";
}

function isSingleCodePoint(s: string): boolean {
  return s.length === 1 || (s.length === 2 && isSurrogatePairAt(s, 0));
}

function advanceColsByCodePoints(line: string, startCol: number, count: number): number {
  let col = startCol;
  for (let i = 0; i < count; i++) {
    if (col >= line.length) break;
    col = nextCharCol(line, col);
  }
  return col;
}

function retreatColsByCodePoints(line: string, startCol: number, count: number): number {
  let col = startCol;
  for (let i = 0; i < count; i++) {
    if (col <= 0) break;
    col = prevCharCol(line, col);
  }
  return col;
}

function toggleCase(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const len = charLenAt(text, i);
    const ch = text.slice(i, i + len);
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    out += ch === lower ? upper : lower;
    i += len;
  }
  return out;
}

export class VimEngine {
  private readonly buffer: TextBuffer;
  private readonly options: VimOptions;

  private _mode: VimMode = "normal";
  private countStr = "";
  private opCountStr = "";
  private operator: OperatorKind | null = null;
  private selectedRegister: string | null = null;
  private _pending = "";
  private prefix: PrefixState = { kind: "none" };
  private preferredCol = 0;
  private lastFind: FindState | null = null;
  private visualAnchor: Position | null = null;

  private registers = new Registers();

  private lastChange: RecordedChange | null = null;
  private recordingChange = false;
  private recordingPrefixKeys: Key[] = [];
  private recordingCount = 1;
  private recordingBodyKeys: Key[] = [];
  private replaying = false;

  private lastSearchPattern: string | null = null;
  private lastSearchDir: 1 | -1 = 1;
  private searchVisible = false;

  private undoHistory = new UndoHistory();
  private insertSnapshot: UndoSnapshot | null = null;
  /**
   * Where the text of the current insert session begins. Everything between
   * it and the cursor was written by keys of the session, so a replay of the
   * session writes it again. It is null outside insert mode, and from entering
   * insert mode until the session's first key or edit: the commands that enter
   * insert mode place the cursor after switching the mode, so the start is
   * taken from the cursor then. Keys that move the cursor begin the text anew
   * (as in vim); keys that delete back past it move it back.
   */
  private insertStart: Position | null = null;

  private modeListeners = new Set<(mode: VimMode) => void>();
  private changeListeners = new Set<() => void>();
  private yankListeners = new Set<(event: YankEvent) => void>();
  private searchListeners = new Set<() => void>();

  constructor(buffer: TextBuffer, options: VimOptions = {}) {
    this.buffer = buffer;
    this.options = options;
    this.clampNormalCursor();
    this.preferredCol = buffer.cursor().col;
  }

  get mode(): VimMode {
    return this._mode;
  }

  get pending(): string {
    return this._pending;
  }

  reset(): void {
    this.countStr = "";
    this.opCountStr = "";
    this.operator = null;
    this.selectedRegister = null;
    this._pending = "";
    this.prefix = { kind: "none" };
    if (!this.replaying && this._mode !== "insert") {
      this.cancelRecording();
    }
  }

  enterInsert(): void {
    if (this.options.readOnly) return;
    this.reset();
    if (this._mode !== "insert") {
      if (this._mode === "visual" || this._mode === "visual-line") {
        this.buffer.setSelection(null);
        this.visualAnchor = null;
      }
      this.insertSnapshot = this.takeSnapshot();
      this.setMode("insert");
    }
  }

  moveTo(position: Position): void {
    this.reset();
    if (this._mode === "insert") {
      const clamped = this.clampPositionToText(position);
      this.buffer.setCursor(clamped);
      this.preferredCol = clamped.col;
      this.insertStart = clamped;
      return;
    }
    const maxRow = Math.max(0, this.buffer.lineCount() - 1);
    const row = Math.max(0, Math.min(maxRow, position.row));
    this.applyMotion({ row, col: position.col }, false);
    this.updateVisualSelection();
  }

  on(event: "mode", listener: (mode: VimMode) => void): () => void;
  on(event: "change", listener: () => void): () => void;
  on(event: "yank", listener: (event: YankEvent) => void): () => void;
  on(event: "search", listener: () => void): () => void;
  on(
    event: "mode" | "change" | "yank" | "search",
    listener: ((mode: VimMode) => void) | (() => void) | ((event: YankEvent) => void),
  ): () => void {
    if (event === "mode") {
      const l = listener as (mode: VimMode) => void;
      this.modeListeners.add(l);
      return () => this.modeListeners.delete(l);
    }
    if (event === "change") {
      const l = listener as () => void;
      this.changeListeners.add(l);
      return () => this.changeListeners.delete(l);
    }
    if (event === "yank") {
      const l = listener as (event: YankEvent) => void;
      this.yankListeners.add(l);
      return () => this.yankListeners.delete(l);
    }
    const l = listener as () => void;
    this.searchListeners.add(l);
    return () => this.searchListeners.delete(l);
  }

  feed(key: Key): "handled" | "ignored" {
    if (this._mode === "insert") {
      if (!this.replaying && this.recordingChange && !isIgnoredInInsert(key)) {
        this.recordingBodyKeys.push(key);
      }
      if (this.insertStart === null) {
        this.insertStart = this.buffer.cursor();
      }
      const result = this.feedInsert(key);
      if (this._mode === "insert") {
        this.trackInsertStart(key);
      }
      return result;
    }
    return this.feedNormalOrVisual(key);
  }

  /** Keeps `insertStart` right after a key of the insert session (see there). */
  private trackInsertStart(key: Key): void {
    const cur = this.buffer.cursor();
    const moved =
      !key.ctrl &&
      !key.meta &&
      (key.name === "left" ||
        key.name === "right" ||
        key.name === "up" ||
        key.name === "down" ||
        key.name === "home" ||
        key.name === "end");
    if (moved || this.insertStart === null || comparePositions(cur, this.insertStart) < 0) {
      this.insertStart = cur;
    }
  }

  register(name: string): string {
    return this.registers.read(name)?.text ?? "";
  }

  search(pattern: string, direction: 1 | -1): boolean {
    this.lastSearchPattern = pattern;
    this.lastSearchDir = direction;
    return this.runSearch(pattern, direction);
  }

  searchMatches(): Range[] {
    if (!this.searchVisible || !this.lastSearchPattern) return [];
    const text = this.buffer.text();
    const matches = findMatches(text, compilePattern(this.lastSearchPattern));
    if (matches.length === 0) return [];

    const totalLines = this.buffer.lineCount();
    let row = 0;
    let lineStartOffset = 0;
    let lineLen = this.buffer.line(0).length;

    const advanceTo = (offset: number): Position => {
      if (offset <= 0) return { row: 0, col: 0 };
      while (row + 1 < totalLines && offset > lineStartOffset + lineLen) {
        lineStartOffset += lineLen + 1;
        row++;
        lineLen = this.buffer.line(row).length;
      }
      return {
        row,
        col: Math.min(lineLen, offset - lineStartOffset),
      };
    };

    const result: Range[] = new Array(matches.length);
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i]!;
      const start = advanceTo(m.start);
      const end = advanceTo(m.end);
      result[i] = { start, end };
    }
    return result;
  }

  clearSearch(): void {
    if (!this.searchVisible) return;
    this.searchVisible = false;
    this.emitSearch();
  }

  private clampPositionToText(pos: Position): Position {
    const maxRow = Math.max(0, this.buffer.lineCount() - 1);
    const row = Math.max(0, Math.min(maxRow, pos.row));
    const line = this.buffer.line(row);
    let col = Math.max(0, Math.min(line.length, pos.col));
    if (col > 0 && col < line.length && isSurrogatePairAt(line, col - 1)) {
      col--;
    }
    return { row, col };
  }

  /**
   * Replaces `range` with `text` outside the keyboard flow.
   *
   * During an insert session the edit is applied whole and stays part of the
   * session's single undo step. It is recorded for `.` when the session is
   * recording, `range` ends at the cursor, `text` contains no line break and no
   * other control character, and the part of the range that lies inside the
   * session's own text (see `insertStart`) is on the cursor's line. What is
   * recorded is only what the session contributed, as vim does after a
   * completion: one insert-mode Backspace per whole character (code point) of
   * the range that lies inside the session's text, then one text key per whole
   * character of `text` without its first k code units, k being the number of
   * code units of the range that lie before the session's text (when the cut
   * would split a surrogate pair, the whole character is written; when `text`
   * is not longer than k, nothing is written). So a replay never deletes text
   * that the replayed keys did not write. A range wholly inside the session's
   * text has k = 0: its Backspaces and the whole `text` are recorded.
   *
   * An `edit` that does not meet those conditions is not recorded for `.`, and
   * the session's text begins anew at the cursor after it. Outside an insert
   * session an edit is its own undo step and is never recorded for `.`.
   */
  edit(range: Range, text: string): void {
    if (this.options.readOnly) return;
    let start = this.clampPositionToText(range.start);
    let end = this.clampPositionToText(range.end);
    const reversed = comparePositions(start, end) > 0;
    if (reversed) {
      [start, end] = [end, start];
    }
    const normalizedRange: Range = { start, end };
    const startOffset = positionToOffset(this.buffer, start);
    const endOffset = positionToOffset(this.buffer, end);
    if (this.buffer.text().slice(startOffset, endOffset) === text) {
      return;
    }

    if (this._mode === "insert") {
      const cur = this.buffer.cursor();
      const curOffset = positionToOffset(this.buffer, cur);
      const sessionStart =
        this.insertStart === null
          ? curOffset
          : Math.min(curOffset, positionToOffset(this.buffer, this.clampPositionToText(this.insertStart)));
      // Offset (after the edit) where the session's text begins; null: anew at the cursor.
      let nextSessionStart: number | null = null;
      if (this.recordingChange && !this.replaying && !reversed) {
        let hasControl = false;
        for (let i = 0; i < text.length; i++) {
          const code = text.charCodeAt(i);
          if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
            hasControl = true;
            break;
          }
        }
        const ownStart = offsetToPosition(this.buffer, Math.max(startOffset, sessionStart));
        if (
          !hasControl &&
          end.row === cur.row &&
          end.col === cur.col &&
          range.end.row === cur.row &&
          range.end.col === cur.col &&
          ownStart.row === cur.row &&
          ownStart.col <= cur.col
        ) {
          const line = this.buffer.line(cur.row);
          for (let col = ownStart.col; col < cur.col; col = nextCharCol(line, col)) {
            this.appendRecordingKey({ name: "backspace" });
          }
          let skip = Math.min(text.length, Math.max(0, sessionStart - startOffset));
          if (skip > 0 && skip < text.length && isSurrogatePairAt(text, skip - 1)) {
            skip--;
          }
          for (const ch of text.slice(skip)) {
            this.appendRecordingKey(
              keyFromEvent({ name: ch, ctrl: false, meta: false, shift: false, sequence: ch }),
            );
          }
          nextSessionStart = startOffset < sessionStart ? startOffset + skip : sessionStart;
        }
      }
      this.buffer.replace(normalizedRange, text);
      const afterPos = offsetToPosition(this.buffer, startOffset + text.length);
      this.buffer.setCursor(afterPos);
      this.preferredCol = afterPos.col;
      this.insertStart =
        nextSessionStart === null ? afterPos : offsetToPosition(this.buffer, nextSessionStart);
      this.emitChange();
      return;
    }

    if (this._mode === "visual" || this._mode === "visual-line") {
      this.buffer.setSelection(null);
      this.visualAnchor = null;
      this.setMode("normal");
    }
    this.reset();
    this.pushUndo(this.takeSnapshot());
    this.buffer.replace(normalizedRange, text);
    const afterPos = offsetToPosition(this.buffer, startOffset + text.length);
    const clampedCol = clampNormalColOnLine(this.buffer.line(afterPos.row), afterPos.col);
    this.buffer.setCursor({ row: afterPos.row, col: clampedCol });
    this.preferredCol = clampedCol;
    this.emitChange();
  }

  private setMode(next: VimMode): void {
    if (this._mode === next) return;
    this._mode = next;
    this.insertStart = null;
    for (const listener of this.modeListeners) {
      listener(next);
    }
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) {
      listener();
    }
  }

  private emitYank(event: YankEvent): void {
    for (const listener of this.yankListeners) {
      listener(event);
    }
  }

  private emitSearch(): void {
    for (const listener of this.searchListeners) {
      listener();
    }
  }

  private takeSnapshot(): UndoSnapshot {
    return {
      text: this.buffer.text(),
      cursor: this.buffer.cursor(),
    };
  }

  private pushUndo(snapshot: UndoSnapshot): void {
    this.undoHistory.push(snapshot);
  }

  private clampNormalCursor(): void {
    const cur = this.buffer.cursor();
    const maxRow = Math.max(0, this.buffer.lineCount() - 1);
    const row = Math.max(0, Math.min(maxRow, cur.row));
    const line = this.buffer.line(row);
    const col = clampNormalColOnLine(line, cur.col);
    if (row !== cur.row || col !== cur.col) {
      this.buffer.setCursor({ row, col });
    }
  }

  private writeRegister(regName: string | null, text: string, linewise: boolean, isYank: boolean): void {
    this.registers.write(regName, { text, linewise }, isYank);
  }

  private getRegisterEntry(regName: string | null): RegisterEntry | null {
    return this.registers.read(regName);
  }

  private startRecording(prefixKeys: Key[], count: number, firstKey: Key): void {
    if (this.replaying || this.options.readOnly) return;
    this.recordingChange = true;
    this.recordingPrefixKeys = [...prefixKeys];
    this.recordingCount = count;
    this.recordingBodyKeys = [firstKey];
  }

  private appendRecordingKey(key: Key): void {
    if (this.replaying || !this.recordingChange) return;
    this.recordingBodyKeys.push(key);
  }

  private commitRecording(): void {
    if (this.replaying || !this.recordingChange) return;
    this.lastChange = {
      prefixKeys: this.recordingPrefixKeys,
      count: this.recordingCount,
      bodyKeys: this.recordingBodyKeys,
    };
    this.recordingChange = false;
    this.recordingPrefixKeys = [];
    this.recordingBodyKeys = [];
  }

  private replayCancelled = false;

  private cancelRecording(): void {
    if (this.replaying) {
      this.replayCancelled = true;
    }
    this.recordingChange = false;
    this.recordingPrefixKeys = [];
    this.recordingBodyKeys = [];
  }

  private replayLastChange(overrideCount: number | null): void {
    if (this.replaying || this.options.readOnly || !this.lastChange) return;
    const count = Math.min(MAX_COUNT, overrideCount ?? this.lastChange.count);
    const keys: Key[] = [...this.lastChange.prefixKeys];
    if (count > 1) {
      for (const ch of String(count)) {
        keys.push({ name: ch, text: ch });
      }
    }
    keys.push(...this.lastChange.bodyKeys);
    this.replaying = true;
    this.replayCancelled = false;
    try {
      for (const k of keys) {
        this.feed(k);
        if (this.replayCancelled) {
          this.reset();
          break;
        }
      }
    } finally {
      this.replaying = false;
      this.replayCancelled = false;
    }
  }

  private motionContext(hasExplicitCount: boolean): MotionContext {
    const pageSize = this.options.pageSize ? this.options.pageSize() : 20;
    return {
      preferredCol: this.preferredCol,
      hasExplicitCount,
      pageSize,
    };
  }

  private effectiveCount(): { count: number; hasExplicit: boolean } {
    const c1 = this.countStr.length > 0 ? Math.min(MAX_COUNT, parseInt(this.countStr, 10)) : 1;
    const c2 = this.opCountStr.length > 0 ? Math.min(MAX_COUNT, parseInt(this.opCountStr, 10)) : 1;
    const hasExplicit = this.countStr.length > 0 || this.opCountStr.length > 0;
    return { count: Math.min(MAX_COUNT, c1 * c2), hasExplicit };
  }

  private isWaitingCharArg(): boolean {
    return (
      this.prefix.kind === "find" ||
      this.prefix.kind === "replace" ||
      this.prefix.kind === "register"
    );
  }

  private updateVisualSelection(): void {
    if (this._mode !== "visual" && this._mode !== "visual-line") return;
    const anchor = this.visualAnchor ?? this.buffer.cursor();
    const cur = this.buffer.cursor();
    const [first, second] = comparePositions(anchor, cur) <= 0 ? [anchor, cur] : [cur, anchor];
    if (this._mode === "visual-line") {
      this.buffer.setSelection(
        {
          start: { row: first.row, col: 0 },
          end: { row: second.row, col: this.buffer.line(second.row).length },
        },
        true,
      );
    } else {
      const endLine = this.buffer.line(second.row);
      const endCol = endLine.length === 0 ? 0 : nextCharCol(endLine, second.col);
      this.buffer.setSelection(
        {
          start: { row: first.row, col: first.col },
          end: { row: second.row, col: endCol },
        },
        false,
      );
    }
  }

  private leaveVisual(): void {
    if (this._mode === "visual" || this._mode === "visual-line") {
      this.buffer.setSelection(null);
      this.visualAnchor = null;
      this.setMode("normal");
    }
  }

  private feedNormalOrVisual(key: Key): "handled" | "ignored" {
    this.clampNormalCursor();
    if (this.visualAnchor) {
      const maxRow = Math.max(0, this.buffer.lineCount() - 1);
      const aRow = Math.max(0, Math.min(maxRow, this.visualAnchor.row));
      const aCol = clampNormalColOnLine(this.buffer.line(aRow), this.visualAnchor.col);
      this.visualAnchor = { row: aRow, col: aCol };
    }

    if (isIgnoredInNormalOrVisual(key)) {
      if (!(this.isWaitingCharArg() && key.text)) {
        this.reset();
        return "ignored";
      }
    }

    if (key.name === "escape" || (key.ctrl && key.name === "[")) {
      this.reset();
      this.leaveVisual();
      return "handled";
    }

    // 1. Waiting for a character argument: register, replace, find
    if (this.prefix.kind === "register") {
      this.prefix = { kind: "none" };
      if (key.text && key.text.length === 1 && !key.ctrl && !key.meta) {
        this.selectedRegister = key.text;
        this._pending += key.text;
      } else {
        this.reset();
      }
      return "handled";
    }

    if (this.prefix.kind === "replace") {
      const { count } = this.effectiveCount();
      this.appendRecordingKey(key);
      this.prefix = { kind: "none" };
      this.countStr = "";
      this.opCountStr = "";
      this._pending = "";
      this.selectedRegister = null;

      if (key.text && isSingleCodePoint(key.text) && !key.ctrl && !key.meta && !this.options.readOnly) {
        const cur = this.buffer.cursor();
        const line = this.buffer.line(cur.row);
        if (line.length > 0) {
          let endReplaceCol = cur.col;
          let steps = 0;
          while (steps < count && endReplaceCol < line.length) {
            endReplaceCol = nextCharCol(line, endReplaceCol);
            steps++;
          }
          if (steps === count) {
            const replacement = key.text.repeat(count);
            const original = line.slice(cur.col, endReplaceCol);
            const endCol = cur.col + key.text.length * (count - 1);
            if (original !== replacement) {
              this.pushUndo(this.takeSnapshot());
              this.buffer.replace(
                { start: cur, end: { row: cur.row, col: endReplaceCol } },
                replacement,
              );
              this.buffer.setCursor({ row: cur.row, col: endCol });
              this.preferredCol = endCol;
              this.emitChange();
              this.commitRecording();
            } else {
              this.buffer.setCursor({ row: cur.row, col: endCol });
              this.preferredCol = endCol;
              this.cancelRecording();
            }
            return "handled";
          }
        }
      }
      this.cancelRecording();
      return "handled";
    }

    if (this.prefix.kind === "find") {
      const findKind = this.prefix.findKind;
      const { count } = this.effectiveCount();
      const op = this.operator;
      const reg = this.selectedRegister;
      this.appendRecordingKey(key);
      this.prefix = { kind: "none" };
      this.countStr = "";
      this.opCountStr = "";
      this.operator = null;
      this.selectedRegister = null;
      this._pending = "";

      if (key.text && isSingleCodePoint(key.text) && !key.ctrl && !key.meta) {
        const findState: FindState = { kind: findKind, char: key.text };
        this.lastFind = findState;
        const cur = this.buffer.cursor();
        const { position: nextPos, found } = moveFindCharWithResult(this.buffer, cur, count, findState);
        const shape: MotionShape = findKind === "f" || findKind === "t" ? "inclusive" : "exclusive";
        if (op) {
          this.recordingCount = count;
          if (!found) {
            this.cancelRecording();
          } else {
            this.applyOperatorMotion(op, reg, cur, { position: nextPos, vertical: false, shape });
          }
        } else {
          this.applyMotion(nextPos, false);
          this.updateVisualSelection();
        }
      } else {
        this.cancelRecording();
      }
      return "handled";
    }

    if (this.prefix.kind === "textobj") {
      const around = this.prefix.around;
      const { count } = this.effectiveCount();
      const op = this.operator;
      const reg = this.selectedRegister;
      this.appendRecordingKey(key);
      this.prefix = { kind: "none" };
      this.countStr = "";
      this.opCountStr = "";
      this.operator = null;
      this.selectedRegister = null;
      this._pending = "";

      const objKey = key.text && key.text.length === 1 && !key.ctrl && !key.meta ? key.text : null;
      if (!objKey) {
        this.cancelRecording();
        return "handled";
      }

      const resolved = resolveTextObject(this.buffer, this.buffer.cursor(), around, objKey, this.options.statementRange);
      if (!resolved) {
        this.cancelRecording();
        return "handled";
      }

      if (op) {
        this.recordingCount = count;
        this.applyOperatorRange(op, reg, resolved.range, Boolean(resolved.linewise));
      } else if (this._mode === "visual" || this._mode === "visual-line") {
        if (resolved.linewise) {
          this.setMode("visual-line");
          this.visualAnchor = { row: resolved.range.start.row, col: 0 };
          const endRow = resolved.range.end.row;
          const endLine = this.buffer.line(endRow);
          const endCol = clampNormalColOnLine(endLine, endLine.length);
          this.buffer.setCursor({ row: endRow, col: endCol });
          this.preferredCol = endCol;
        } else {
          this.visualAnchor = { ...resolved.range.start };
          const endPos = this.inclusiveEndFromExclusiveRange(resolved.range);
          this.buffer.setCursor(endPos);
          this.preferredCol = endPos.col;
        }
        this.updateVisualSelection();
      }
      return "handled";
    }

    if (this.prefix.kind === "g") {
      const { count, hasExplicit } = this.effectiveCount();
      const ctx = this.motionContext(hasExplicit);
      const op = this.operator;
      const reg = this.selectedRegister;
      this.appendRecordingKey(key);
      this.prefix = { kind: "none" };
      this.countStr = "";
      this.opCountStr = "";
      this.operator = null;
      this.selectedRegister = null;
      this._pending = "";

      if (!key.ctrl && !key.meta && !key.shift && key.name === "g") {
        const cur = this.buffer.cursor();
        const nextPos = moveGotoFirstLine(this.buffer, cur, count, ctx);
        if (op) {
          this.recordingCount = count;
          this.applyOperatorMotion(op, reg, cur, { position: nextPos, vertical: false, shape: "linewise" });
        } else {
          this.applyMotion(nextPos, false);
          this.updateVisualSelection();
        }
      } else if (
        !op &&
        this._mode === "normal" &&
        !this.options.readOnly &&
        !key.ctrl &&
        !key.meta &&
        key.text === "J"
      ) {
        // gJ joins lines exactly as J does (plain J is taken by the Editor Pane to move the focus).
        const prefixKeys: Key[] = reg ? [{ name: '"', text: '"' }, { name: reg, text: reg }] : [];
        this.startRecording(prefixKeys, count, { name: "g", text: "g" });
        this.appendRecordingKey(key);
        if (this.joinLines(count)) {
          this.commitRecording();
        } else {
          this.cancelRecording();
        }
      } else {
        this.cancelRecording();
      }
      return "handled";
    }

    // 2. Count accumulation
    if (!key.ctrl && !key.meta && !key.shift && key.text && key.text >= "0" && key.text <= "9") {
      const activeCount = this.operator ? this.opCountStr : this.countStr;
      if (key.text !== "0" || activeCount.length > 0) {
        const nextStr = String(Math.min(MAX_COUNT, parseInt(activeCount + key.text, 10)));
        if (this.operator) {
          this.opCountStr = nextStr;
        } else {
          this.countStr = nextStr;
        }
        this._pending += key.text;
        return "handled";
      }
    }

    // 3. Register prefix '"' (allowed before operator or before normal command)
    if (!key.ctrl && !key.meta && key.text === '"' && !this.operator) {
      this.prefix = { kind: "register" };
      this._pending += '"';
      return "handled";
    }

    // 4. Text object prefix 'i' or 'a' (when operator is pending OR in visual mode)
    if (
      !key.ctrl &&
      !key.meta &&
      !key.shift &&
      (key.name === "i" || key.name === "a") &&
      (this.operator !== null || this._mode === "visual" || this._mode === "visual-line")
    ) {
      this.prefix = { kind: "textobj", around: key.name === "a" };
      this._pending += key.name;
      this.appendRecordingKey(key);
      return "handled";
    }

    // 5. Prefix 'g' or find ('f', 'F', 't', 'T')
    if (!key.ctrl && !key.meta && !key.shift && key.name === "g") {
      this.prefix = { kind: "g" };
      this._pending += "g";
      this.appendRecordingKey(key);
      return "handled";
    }

    if (!key.ctrl && !key.meta && (key.text === "f" || key.text === "F" || key.text === "t" || key.text === "T")) {
      const findKind = key.text as FindKind;
      this.prefix = { kind: "find", findKind };
      this._pending += findKind;
      this.appendRecordingKey(key);
      return "handled";
    }

    // 6. If an operator is currently pending
    if (this.operator !== null) {
      const op = this.operator;
      const reg = this.selectedRegister;
      const { count, hasExplicit } = this.effectiveCount();
      const ctx = this.motionContext(hasExplicit);
      this.recordingCount = count;
      this.appendRecordingKey(key);
      this.countStr = "";
      this.opCountStr = "";
      this.operator = null;
      this.selectedRegister = null;
      this._pending = "";

      // Double operator for linewise: dd, cc, yy, >>, <<
      if (!key.ctrl && !key.meta && key.text === op) {
        this.applyLinewiseOperatorCount(op, reg, count);
        return "handled";
      }

      const motionOutcome = this.tryMotion(key, count, ctx, op);
      if (motionOutcome) {
        if (motionOutcome.failed) {
          this.cancelRecording();
        } else {
          this.applyOperatorMotion(op, reg, this.buffer.cursor(), motionOutcome);
        }
        return "handled";
      }

      this.cancelRecording();
      return "handled";
    }

    // 7. No operator pending: check motions or commands
    const { count, hasExplicit } = this.effectiveCount();
    const ctx = this.motionContext(hasExplicit);
    const reg = this.selectedRegister;
    const prefixKeysForRecord: Key[] = reg ? [{ name: '"', text: '"' }, { name: reg, text: reg }] : [];

    // Check if key starts an operator in Normal mode
    if (this._mode === "normal" && !key.ctrl && !key.meta && (key.text === "d" || key.text === "c" || key.text === "y" || key.text === ">" || key.text === "<")) {
      const op = key.text as OperatorKind;
      this.operator = op;
      this._pending += op;
      if (op !== "y") {
        this.startRecording(prefixKeysForRecord, count, key);
      }
      return "handled";
    }

    // Check if key starts 'r' in Normal mode
    if (this._mode === "normal" && !key.ctrl && !key.meta && !key.shift && key.name === "r") {
      this.prefix = { kind: "replace" };
      this._pending += "r";
      this.startRecording(prefixKeysForRecord, count, key);
      return "handled";
    }

    this.countStr = "";
    this.opCountStr = "";
    this.operator = null;
    this.selectedRegister = null;
    this._pending = "";
    this.prefix = { kind: "none" };

    // Check motions
    const motionOutcome = this.tryMotion(key, count, ctx, null);
    if (motionOutcome) {
      this.cancelRecording();
      this.applyMotion(motionOutcome.position, motionOutcome.vertical);
      this.updateVisualSelection();
      return "handled";
    }

    // Visual mode commands vs Normal mode commands
    if (this._mode === "visual" || this._mode === "visual-line") {
      this.cancelRecording();
      this.runVisualCommand(key, reg);
    } else {
      this.runNormalCommand(key, count, hasExplicit, reg, prefixKeysForRecord);
    }
    return "handled";
  }

  private inclusiveEndFromExclusiveRange(range: Range): Position {
    const startOffset = positionToOffset(this.buffer, range.start);
    const endOffset = positionToOffset(this.buffer, range.end);
    if (endOffset <= startOffset) return { ...range.start };
    const pos = offsetToPosition(this.buffer, endOffset - 1);
    const line = this.buffer.line(pos.row);
    return { row: pos.row, col: clampNormalColOnLine(line, pos.col) };
  }

  private tryMotion(
    key: Key,
    count: number,
    ctx: MotionContext,
    forOperator: OperatorKind | null,
  ): MotionOutcome | null {
    const cur = this.buffer.cursor();

    if (key.ctrl && !key.meta && !key.shift) {
      if (key.name === "d") {
        return { position: moveHalfPageDown(this.buffer, cur, count, ctx), vertical: true, shape: "exclusive" };
      }
      if (key.name === "u") {
        return { position: moveHalfPageUp(this.buffer, cur, count, ctx), vertical: true, shape: "exclusive" };
      }
      return null;
    }

    if (key.ctrl || key.meta) return null;

    if (!key.shift) {
      switch (key.name) {
        case "h":
        case "left":
          return { position: moveLeft(this.buffer, cur, count), vertical: false, shape: "exclusive" };
        case "l":
        case "right":
          if (forOperator) {
            const line = this.buffer.line(cur.row);
            return {
              position: { row: cur.row, col: advanceColsByCodePoints(line, cur.col, count) },
              vertical: false,
              shape: "exclusive",
            };
          }
          return { position: moveRight(this.buffer, cur, count), vertical: false, shape: "exclusive" };
        case "j":
        case "down":
          return { position: moveDown(this.buffer, cur, count, ctx), vertical: true, shape: "linewise" };
        case "k":
        case "up":
          return { position: moveUp(this.buffer, cur, count, ctx), vertical: true, shape: "linewise" };
        case "w":
          if (forOperator === "c") {
            if (this.buffer.line(cur.row).length === 0) {
              return { position: cur, vertical: false, shape: "exclusive", allowEmptyChange: true };
            }
            if (this.shouldChangeWordLikeEnd(cur, false)) {
              return { position: moveWordEnd(this.buffer, cur, count, false), vertical: false, shape: "inclusive", allowEmptyChange: true };
            }
          }
          if (forOperator === "d" && count === 1 && this.buffer.line(cur.row).length === 0 && cur.row + 1 < this.buffer.lineCount()) {
            return { position: { row: cur.row + 1, col: 0 }, vertical: false, shape: "exclusive", allowEmptyChange: true };
          }
          if (forOperator) {
            return { position: moveWordForwardOperator(this.buffer, cur, count, false), vertical: false, shape: "exclusive", allowEmptyChange: true };
          }
          return { position: moveWordForward(this.buffer, cur, count, false), vertical: false, shape: "exclusive" };
        case "b":
          return { position: moveWordBackward(this.buffer, cur, count, false), vertical: false, shape: "exclusive" };
        case "e":
          return { position: moveWordEnd(this.buffer, cur, count, false), vertical: false, shape: "inclusive" };
        case "0":
        case "home":
          return { position: moveLineStart(this.buffer, cur), vertical: false, shape: "exclusive" };
        case "^":
          return { position: moveFirstNonBlank(this.buffer, cur), vertical: false, shape: "exclusive" };
        case "$":
        case "end":
          return { position: moveLineEnd(this.buffer, cur, count), vertical: false, shape: "inclusive", allowEmptyChange: true };
        case "%": {
          const next = moveMatchBracket(this.buffer, cur);
          const failed = next.row === cur.row && next.col === cur.col;
          return { position: next, vertical: false, shape: "inclusive", failed };
        }
        case "{":
          return { position: moveParagraphBackward(this.buffer, cur, count), vertical: false, shape: "exclusive" };
        case "}":
          return { position: moveParagraphForward(this.buffer, cur, count), vertical: false, shape: "exclusive" };
        case ";": {
          if (!this.lastFind) return { position: cur, vertical: false, shape: "exclusive", failed: true };
          const { position: next, found } = moveFindCharWithResult(this.buffer, cur, count, this.lastFind, true);
          const shape: MotionShape = this.lastFind.kind === "f" || this.lastFind.kind === "t" ? "inclusive" : "exclusive";
          return { position: next, vertical: false, shape, failed: !found };
        }
        case ",": {
          if (!this.lastFind) return { position: cur, vertical: false, shape: "exclusive", failed: true };
          const invKind = INVERT_FIND[this.lastFind.kind];
          const { position: next, found } = moveFindCharWithResult(
            this.buffer,
            cur,
            count,
            { kind: invKind, char: this.lastFind.char },
            true,
          );
          const shape: MotionShape = invKind === "f" || invKind === "t" ? "inclusive" : "exclusive";
          return { position: next, vertical: false, shape, failed: !found };
        }
      }
    } else {
      switch (key.name) {
        case "w":
          if (forOperator === "c") {
            if (this.buffer.line(cur.row).length === 0) {
              return { position: cur, vertical: false, shape: "exclusive", allowEmptyChange: true };
            }
            if (this.shouldChangeWordLikeEnd(cur, true)) {
              return { position: moveWordEnd(this.buffer, cur, count, true), vertical: false, shape: "inclusive", allowEmptyChange: true };
            }
          }
          if (forOperator === "d" && count === 1 && this.buffer.line(cur.row).length === 0 && cur.row + 1 < this.buffer.lineCount()) {
            return { position: { row: cur.row + 1, col: 0 }, vertical: false, shape: "exclusive", allowEmptyChange: true };
          }
          if (forOperator) {
            return { position: moveWordForwardOperator(this.buffer, cur, count, true), vertical: false, shape: "exclusive", allowEmptyChange: true };
          }
          return { position: moveWordForward(this.buffer, cur, count, true), vertical: false, shape: "exclusive" };
        case "b":
          return { position: moveWordBackward(this.buffer, cur, count, true), vertical: false, shape: "exclusive" };
        case "e":
          return { position: moveWordEnd(this.buffer, cur, count, true), vertical: false, shape: "inclusive" };
        case "g":
          return { position: moveGotoLastLine(this.buffer, cur, count, ctx), vertical: false, shape: "linewise" };
      }
    }

    return null;
  }

  private shouldChangeWordLikeEnd(cur: Position, bigWord: boolean): boolean {
    const line = this.buffer.line(cur.row);
    if (cur.col >= line.length) return false;
    const ch = line[cur.col]!;
    if (ch === " " || ch === "\t") return false;
    const nextCol = nextCharCol(line, cur.col);
    if (nextCol < line.length) {
      const nextCh = line[nextCol]!;
      if (nextCh !== " " && nextCh !== "\t") {
        if (bigWord || isWordChar(ch) === isWordChar(nextCh)) {
          return true;
        }
      }
    }
    return false;
  }

  private applyMotion(position: Position, vertical: boolean): void {
    const line = this.buffer.line(position.row);
    const clampedCol = clampNormalColOnLine(line, position.col);
    this.buffer.setCursor({ row: position.row, col: clampedCol });
    if (!vertical) {
      this.preferredCol = clampedCol;
    }
  }

  private applyLinewiseOperatorCount(op: OperatorKind, reg: string | null, count: number): void {
    const cur = this.buffer.cursor();
    const maxRow = Math.max(0, this.buffer.lineCount() - 1);
    const endRow = Math.min(maxRow, cur.row + Math.max(0, count - 1));
    const range: Range = {
      start: { row: cur.row, col: 0 },
      end: { row: endRow, col: this.buffer.line(endRow).length },
    };
    this.applyOperatorRange(op, reg, range, true);
  }

  private applyOperatorMotion(
    op: OperatorKind,
    reg: string | null,
    startCursor: Position,
    outcome: MotionOutcome,
  ): void {
    if (outcome.shape === "linewise") {
      const startRow = Math.min(startCursor.row, outcome.position.row);
      const endRow = Math.max(startCursor.row, outcome.position.row);
      const range: Range = {
        start: { row: startRow, col: 0 },
        end: { row: endRow, col: this.buffer.line(endRow).length },
      };
      this.applyOperatorRange(op, reg, range, true);
      return;
    }

    let first = startCursor;
    let second = outcome.position;
    if (op === "c") {
      const line = this.buffer.line(startCursor.row);
      const nextCol = nextCharCol(line, startCursor.col);
      if (
        startCursor.col < line.length &&
        line[startCursor.col] !== " " &&
        line[startCursor.col] !== "\t" &&
        outcome.shape === "exclusive" &&
        second.row === startCursor.row &&
        second.col > nextCol &&
        (line[nextCol] === " " || line[nextCol] === "\t")
      ) {
        second = { row: startCursor.row, col: nextCol };
      }
    }

    if (comparePositions(first, second) > 0) {
      [first, second] = [second, first];
    }

    let endCol = second.col;
    if (outcome.shape === "inclusive") {
      const endLine = this.buffer.line(second.row);
      if (endLine.length > 0) {
        endCol = nextCharCol(endLine, second.col);
      }
    }

    const range: Range = {
      start: { row: first.row, col: first.col },
      end: { row: second.row, col: endCol },
    };
    this.applyOperatorRange(op, reg, range, false);
  }

  private extractText(range: Range, linewise: boolean): string {
    if (linewise) {
      const lines: string[] = [];
      for (let r = range.start.row; r <= range.end.row; r++) {
        lines.push(this.buffer.line(r));
      }
      return lines.join("\n") + "\n";
    }
    const startOffset = positionToOffset(this.buffer, range.start);
    const endOffset = positionToOffset(this.buffer, range.end);
    return this.buffer.text().slice(startOffset, endOffset);
  }

  private isEmptyOperatorRange(range: Range, linewise: boolean): boolean {
    if (linewise) {
      return this.buffer.lineCount() === 1 && this.buffer.line(0).length === 0;
    }
    return range.start.row === range.end.row && range.start.col === range.end.col;
  }

  private applyOperatorRange(op: OperatorKind, reg: string | null, range: Range, linewise: boolean): void {
    const startRow = range.start.row;
    const endRow = range.end.row;
    const normalizedRange: Range = linewise
      ? {
          start: { row: startRow, col: 0 },
          end: { row: endRow, col: this.buffer.line(endRow).length },
        }
      : range;

    if (op === "y") {
      if (!linewise && this.isEmptyOperatorRange(normalizedRange, false)) {
        return;
      }
      const text = this.extractText(normalizedRange, linewise);
      this.writeRegister(reg, text, linewise, true);
      if (this.options.clipboard) {
        this.options.clipboard(text);
      }
      this.emitYank({
        range: {
          start: { ...normalizedRange.start },
          end: { ...normalizedRange.end },
        },
        linewise,
        text,
      });
      return;
    }

    if (this.options.readOnly) {
      this.cancelRecording();
      return;
    }

    if (op === ">" || op === "<") {
      const changed = this.indentLines(startRow, endRow, op === ">");
      if (changed) {
        this.commitRecording();
      } else {
        this.cancelRecording();
      }
      return;
    }

    if (op === "d") {
      if (this.isEmptyOperatorRange(normalizedRange, linewise)) {
        this.cancelRecording();
        return;
      }
      const text = this.extractText(normalizedRange, linewise);
      this.writeRegister(reg, text, linewise, false);
      this.pushUndo(this.takeSnapshot());
      if (linewise) {
        this.deleteLines(startRow, endRow);
      } else {
        this.buffer.replace(normalizedRange, "");
        const row = normalizedRange.start.row;
        const col = clampNormalColOnLine(this.buffer.line(row), normalizedRange.start.col);
        this.buffer.setCursor({ row, col });
        this.preferredCol = col;
      }
      this.emitChange();
      this.commitRecording();
      return;
    }

    if (op === "c") {
      const empty = this.isEmptyOperatorRange(normalizedRange, linewise);
      if (empty) {
        this.insertSnapshot = this.takeSnapshot();
        this.setMode("insert");
        return;
      }
      const text = this.extractText(normalizedRange, linewise);
      const snap = this.takeSnapshot();
      this.insertSnapshot = snap;
      if (linewise) {
        const indent = leadingWhitespace(this.buffer.line(startRow));
        this.buffer.replace(normalizedRange, indent);
        const nextCursor = { row: startRow, col: indent.length };
        this.buffer.setCursor(nextCursor);
        this.preferredCol = nextCursor.col;
      } else {
        this.buffer.replace(normalizedRange, "");
        this.buffer.setCursor({ ...normalizedRange.start });
        this.preferredCol = normalizedRange.start.col;
      }
      if (this.buffer.text() !== snap.text) {
        this.writeRegister(reg, text, linewise, false);
        this.emitChange();
      }
      this.setMode("insert");
    }
  }

  private deleteLines(startRow: number, endRow: number): void {
    const total = this.buffer.lineCount();
    if (startRow === 0 && endRow >= total - 1) {
      this.buffer.setText("");
      this.buffer.setCursor({ row: 0, col: 0 });
      this.preferredCol = 0;
      return;
    }
    if (endRow < total - 1) {
      this.buffer.replace(
        {
          start: { row: startRow, col: 0 },
          end: { row: endRow + 1, col: 0 },
        },
        "",
      );
      const targetRow = Math.min(startRow, this.buffer.lineCount() - 1);
      const col = firstNonBlankCol(this.buffer.line(targetRow));
      this.buffer.setCursor({ row: targetRow, col });
      this.preferredCol = col;
    } else {
      const prevRow = startRow - 1;
      const prevLen = this.buffer.line(prevRow).length;
      this.buffer.replace(
        {
          start: { row: prevRow, col: prevLen },
          end: { row: endRow, col: this.buffer.line(endRow).length },
        },
        "",
      );
      const targetRow = Math.max(0, this.buffer.lineCount() - 1);
      const col = firstNonBlankCol(this.buffer.line(targetRow));
      this.buffer.setCursor({ row: targetRow, col });
      this.preferredCol = col;
    }
  }

  private indentLines(startRow: number, endRow: number, indentRight: boolean): boolean {
    const snap = this.takeSnapshot();
    let changed = false;
    for (let r = startRow; r <= endRow; r++) {
      const line = this.buffer.line(r);
      if (indentRight) {
        if (line.length > 0) {
          this.buffer.replace({ start: { row: r, col: 0 }, end: { row: r, col: 0 } }, "  ");
          changed = true;
        }
      } else {
        let remove = 0;
        if (line.startsWith("  ")) remove = 2;
        else if (line.startsWith(" ") || line.startsWith("\t")) remove = 1;
        if (remove > 0) {
          this.buffer.replace({ start: { row: r, col: 0 }, end: { row: r, col: remove } }, "");
          changed = true;
        }
      }
    }
    const col = firstNonBlankCol(this.buffer.line(startRow));
    this.buffer.setCursor({ row: startRow, col });
    this.preferredCol = col;
    if (changed) {
      this.pushUndo(snap);
      this.emitChange();
    }
    return changed;
  }

  private runVisualCommand(key: Key, reg: string | null): void {
    if (key.ctrl || key.meta) return;

    if (!key.shift && key.name === "v") {
      if (this._mode === "visual") {
        this.leaveVisual();
      } else {
        this.setMode("visual");
        this.updateVisualSelection();
      }
      return;
    }
    if (key.shift && key.name === "v") {
      if (this._mode === "visual-line") {
        this.leaveVisual();
      } else {
        this.setMode("visual-line");
        this.updateVisualSelection();
      }
      return;
    }

    if (!key.shift && key.name === "o") {
      if (this.visualAnchor) {
        const cur = this.buffer.cursor();
        this.buffer.setCursor(this.visualAnchor);
        this.visualAnchor = cur;
        this.preferredCol = this.buffer.cursor().col;
        this.updateVisualSelection();
      }
      return;
    }

    // Search repeat in visual mode
    if (!key.shift && key.name === "n") {
      this.repeatSearch(1);
      this.updateVisualSelection();
      return;
    }
    if (key.shift && key.name === "n") {
      this.repeatSearch(-1);
      this.updateVisualSelection();
      return;
    }
    if (key.text === "*" || key.text === "#") {
      this.searchWordUnderCursor(key.text === "*" ? 1 : -1);
      this.updateVisualSelection();
      return;
    }

    const anchor = this.visualAnchor ?? this.buffer.cursor();
    const cur = this.buffer.cursor();
    const [first, second] = comparePositions(anchor, cur) <= 0 ? [anchor, cur] : [cur, anchor];
    const linewise = this._mode === "visual-line";
    const endLine = this.buffer.line(second.row);
    const range: Range = linewise
      ? {
          start: { row: first.row, col: 0 },
          end: { row: second.row, col: endLine.length },
        }
      : {
          start: { row: first.row, col: first.col },
          end: { row: second.row, col: endLine.length === 0 ? 0 : nextCharCol(endLine, second.col) },
        };

    if (!key.shift && key.name === "y") {
      this.leaveVisual();
      this.applyOperatorRange("y", reg, range, linewise);
      const targetCol = clampNormalColOnLine(this.buffer.line(first.row), first.col);
      this.buffer.setCursor({ row: first.row, col: targetCol });
      this.preferredCol = targetCol;
      return;
    }

    if (this.options.readOnly) return;

    if ((!key.shift && (key.name === "d" || key.name === "x" || key.name === "delete")) || (key.shift && key.name === "x")) {
      const actualLinewise = linewise || Boolean(key.shift && key.name === "x");
      this.leaveVisual();
      this.applyOperatorRange("d", reg, range, actualLinewise);
      return;
    }

    if ((!key.shift && (key.name === "c" || key.name === "s")) || (key.shift && (key.name === "c" || key.name === "s"))) {
      const actualLinewise = linewise || Boolean(key.shift && (key.name === "c" || key.name === "s"));
      this.leaveVisual();
      this.applyOperatorRange("c", reg, range, actualLinewise);
      return;
    }

    if (key.text === ">" || key.text === "<") {
      this.leaveVisual();
      this.applyOperatorRange(key.text, reg, range, true);
      return;
    }

    if (key.text === "~") {
      this.leaveVisual();
      const text = this.extractText(range, linewise);
      const toggled = toggleCase(text);
      const targetCol = clampNormalColOnLine(this.buffer.line(first.row), first.col);
      if (toggled !== text) {
        this.pushUndo(this.takeSnapshot());
        if (linewise) {
          for (let r = range.start.row; r <= range.end.row; r++) {
            const l = this.buffer.line(r);
            this.buffer.replace({ start: { row: r, col: 0 }, end: { row: r, col: l.length } }, toggleCase(l));
          }
        } else {
          this.buffer.replace(range, toggled);
        }
        this.buffer.setCursor({ row: first.row, col: targetCol });
        this.preferredCol = targetCol;
        this.emitChange();
      } else {
        this.buffer.setCursor({ row: first.row, col: targetCol });
        this.preferredCol = targetCol;
      }
      return;
    }

    if (!key.shift && key.name === "p") {
      const entry = this.getRegisterEntry(reg);
      this.leaveVisual();
      if (!entry) return;
      const replacedText = this.extractText(range, linewise);
      const rawRangeText = this.extractText(range, false);
      const pasteText = entry.linewise && !linewise ? entry.text.replace(/\n$/, "") : linewise && !entry.linewise ? entry.text : entry.text.replace(/\n$/, "");
      const startOffset = positionToOffset(this.buffer, range.start);
      const endOffset = pasteText.length > 0 ? startOffset + prevCharCol(pasteText, pasteText.length) : startOffset;
      if (rawRangeText === pasteText) {
        const nextPos = offsetToPosition(this.buffer, endOffset);
        const col = clampNormalColOnLine(this.buffer.line(nextPos.row), nextPos.col);
        this.buffer.setCursor({ row: nextPos.row, col });
        this.preferredCol = col;
        return;
      }
      this.pushUndo(this.takeSnapshot());
      this.buffer.replace(range, pasteText);
      const nextPos = offsetToPosition(this.buffer, endOffset);
      const col = clampNormalColOnLine(this.buffer.line(nextPos.row), nextPos.col);
      this.buffer.setCursor({ row: nextPos.row, col });
      this.preferredCol = col;
      this.writeRegister(null, replacedText, linewise, false);
      this.emitChange();
      return;
    }
  }

  private runNormalCommand(
    key: Key,
    count: number,
    hasExplicitCount: boolean,
    reg: string | null,
    prefixKeys: Key[],
  ): void {
    if (key.ctrl && !key.meta && !key.shift && key.name === "r") {
      if (!this.options.readOnly) {
        this.redo(count);
      }
      return;
    }

    if (key.ctrl || key.meta) return;

    // Mode changes to visual / visual-line
    if (!key.shift && key.name === "v") {
      this.visualAnchor = this.buffer.cursor();
      this.setMode("visual");
      this.updateVisualSelection();
      return;
    }
    if (key.shift && key.name === "v") {
      this.visualAnchor = this.buffer.cursor();
      this.setMode("visual-line");
      this.updateVisualSelection();
      return;
    }

    // Search repeat & word search (allowed in readOnly)
    if (!key.shift && key.name === "n") {
      this.repeatSearch(1);
      return;
    }
    if (key.shift && key.name === "n") {
      this.repeatSearch(-1);
      return;
    }
    if (key.text === "*") {
      this.searchWordUnderCursor(1);
      return;
    }
    if (key.text === "#") {
      this.searchWordUnderCursor(-1);
      return;
    }

    // Y yanks to end of line (allowed in readOnly)
    if (key.shift && key.name === "y") {
      const cur = this.buffer.cursor();
      const lineLen = this.buffer.line(cur.row).length;
      const range: Range = {
        start: { row: cur.row, col: cur.col },
        end: { row: cur.row, col: lineLen },
      };
      this.applyOperatorRange("y", reg, range, false);
      return;
    }

    if (this._mode !== "normal" || this.options.readOnly) {
      return;
    }

    if (key.text === ".") {
      this.replayLastChange(hasExplicitCount ? count : null);
      return;
    }

    const cur = this.buffer.cursor();
    const line = this.buffer.line(cur.row);

    if (!key.shift) {
      switch (key.name) {
        case "i":
          this.startRecording(prefixKeys, count, key);
          this.enterInsertForChange();
          return;
        case "a": {
          this.startRecording(prefixKeys, count, key);
          this.enterInsertForChange();
          const col = nextCharCol(line, cur.col);
          this.buffer.setCursor({ row: cur.row, col });
          this.preferredCol = col;
          return;
        }
        case "o": {
          this.startRecording(prefixKeys, count, key);
          this.enterInsertForChange();
          const indent = leadingWhitespace(line);
          const endCol = line.length;
          this.buffer.replace({ start: { row: cur.row, col: endCol }, end: { row: cur.row, col: endCol } }, "\n" + indent);
          const nextCursor = { row: cur.row + 1, col: indent.length };
          this.buffer.setCursor(nextCursor);
          this.preferredCol = nextCursor.col;
          this.emitChange();
          return;
        }
        case "s": {
          this.startRecording(prefixKeys, count, key);
          const endCol = advanceColsByCodePoints(line, cur.col, count);
          const range: Range = {
            start: { row: cur.row, col: cur.col },
            end: { row: cur.row, col: endCol },
          };
          this.applyOperatorRange("c", reg, range, false);
          return;
        }
        case "x":
        case "delete": {
          if (line.length === 0) return;
          const endCol = advanceColsByCodePoints(line, cur.col, count);
          if (endCol <= cur.col) return;
          this.startRecording(prefixKeys, count, key);
          const range: Range = {
            start: { row: cur.row, col: cur.col },
            end: { row: cur.row, col: endCol },
          };
          const deleted = this.extractText(range, false);
          this.writeRegister(reg, deleted, false, false);
          this.pushUndo(this.takeSnapshot());
          this.buffer.replace(range, "");
          this.clampNormalCursor();
          this.preferredCol = this.buffer.cursor().col;
          this.emitChange();
          this.commitRecording();
          return;
        }
        case "p": {
          this.startRecording(prefixKeys, count, key);
          if (this.put(reg, true)) {
            this.commitRecording();
          } else {
            this.cancelRecording();
          }
          return;
        }
        case "u":
          this.undo(count);
          return;
      }
    } else {
      switch (key.name) {
        case "i": {
          this.startRecording(prefixKeys, count, key);
          this.enterInsertForChange();
          const col = firstNonBlankCol(line);
          this.buffer.setCursor({ row: cur.row, col });
          this.preferredCol = col;
          return;
        }
        case "a": {
          this.startRecording(prefixKeys, count, key);
          this.enterInsertForChange();
          const col = line.length;
          this.buffer.setCursor({ row: cur.row, col });
          this.preferredCol = col;
          return;
        }
        case "o": {
          this.startRecording(prefixKeys, count, key);
          this.enterInsertForChange();
          const indent = leadingWhitespace(line);
          this.buffer.replace({ start: { row: cur.row, col: 0 }, end: { row: cur.row, col: 0 } }, indent + "\n");
          const nextCursor = { row: cur.row, col: indent.length };
          this.buffer.setCursor(nextCursor);
          this.preferredCol = nextCursor.col;
          this.emitChange();
          return;
        }
        case "d": {
          this.startRecording(prefixKeys, count, key);
          const endRow = Math.min(this.buffer.lineCount() - 1, cur.row + Math.max(0, count - 1));
          const range: Range = {
            start: { row: cur.row, col: cur.col },
            end: { row: endRow, col: this.buffer.line(endRow).length },
          };
          this.applyOperatorRange("d", reg, range, false);
          return;
        }
        case "c": {
          this.startRecording(prefixKeys, count, key);
          const endRow = Math.min(this.buffer.lineCount() - 1, cur.row + Math.max(0, count - 1));
          const range: Range = {
            start: { row: cur.row, col: cur.col },
            end: { row: endRow, col: this.buffer.line(endRow).length },
          };
          this.applyOperatorRange("c", reg, range, false);
          return;
        }
        case "s": {
          this.startRecording(prefixKeys, count, key);
          this.applyLinewiseOperatorCount("c", reg, count);
          return;
        }
        case "x": {
          if (cur.col === 0) return;
          const startCol = retreatColsByCodePoints(line, cur.col, count);
          if (startCol >= cur.col) return;
          this.startRecording(prefixKeys, count, key);
          const range: Range = {
            start: { row: cur.row, col: startCol },
            end: { row: cur.row, col: cur.col },
          };
          const deleted = this.extractText(range, false);
          this.writeRegister(reg, deleted, false, false);
          this.pushUndo(this.takeSnapshot());
          this.buffer.replace(range, "");
          this.buffer.setCursor({ row: cur.row, col: startCol });
          this.preferredCol = startCol;
          this.emitChange();
          this.commitRecording();
          return;
        }
        case "j": {
          this.startRecording(prefixKeys, count, key);
          if (this.joinLines(count)) {
            this.commitRecording();
          } else {
            this.cancelRecording();
          }
          return;
        }
        case "p": {
          this.startRecording(prefixKeys, count, key);
          if (this.put(reg, false)) {
            this.commitRecording();
          } else {
            this.cancelRecording();
          }
          return;
        }
      }
    }

    if (key.text === "~") {
      if (line.length === 0) return;
      const endCol = advanceColsByCodePoints(line, cur.col, count);
      if (endCol <= cur.col) return;
      const slice = line.slice(cur.col, endCol);
      const toggled = toggleCase(slice);
      const nextCol = clampNormalColOnLine(line, endCol);
      if (toggled === slice) {
        this.buffer.setCursor({ row: cur.row, col: nextCol });
        this.preferredCol = nextCol;
        return;
      }
      this.startRecording(prefixKeys, count, key);
      this.pushUndo(this.takeSnapshot());
      this.buffer.replace(
        { start: { row: cur.row, col: cur.col }, end: { row: cur.row, col: endCol } },
        toggled,
      );
      const updatedCol = clampNormalColOnLine(this.buffer.line(cur.row), cur.col + toggled.length);
      this.buffer.setCursor({ row: cur.row, col: updatedCol });
      this.preferredCol = updatedCol;
      this.emitChange();
      this.commitRecording();
    }
  }

  private enterInsertForChange(): void {
    this.insertSnapshot = this.takeSnapshot();
    this.setMode("insert");
  }

  private joinLines(count: number): boolean {
    const steps = Math.max(1, count - 1);
    const cur = this.buffer.cursor();
    if (cur.row + 1 >= this.buffer.lineCount()) return false;
    this.pushUndo(this.takeSnapshot());
    let spaceCol = cur.col;
    for (let i = 0; i < steps; i++) {
      const row = this.buffer.cursor().row;
      if (row + 1 >= this.buffer.lineCount()) break;
      const firstLine = this.buffer.line(row);
      const secondLine = this.buffer.line(row + 1).replace(/^[ \t]+/, "");
      spaceCol = firstLine.length;
      const joined = secondLine.length > 0 ? firstLine + " " + secondLine : firstLine;
      this.buffer.replace(
        {
          start: { row, col: 0 },
          end: { row: row + 1, col: this.buffer.line(row + 1).length },
        },
        joined,
      );
    }
    const row = this.buffer.cursor().row;
    const col = clampNormalColOnLine(this.buffer.line(row), spaceCol);
    this.buffer.setCursor({ row, col });
    this.preferredCol = col;
    this.emitChange();
    return true;
  }

  private put(reg: string | null, after: boolean): boolean {
    const entry = this.getRegisterEntry(reg);
    if (!entry || entry.text.length === 0) return false;

    this.pushUndo(this.takeSnapshot());
    const cur = this.buffer.cursor();

    if (entry.linewise) {
      const raw = entry.text.endsWith("\n") ? entry.text.slice(0, -1) : entry.text;
      if (after) {
        const lineLen = this.buffer.line(cur.row).length;
        this.buffer.replace(
          { start: { row: cur.row, col: lineLen }, end: { row: cur.row, col: lineLen } },
          "\n" + raw,
        );
        const targetRow = cur.row + 1;
        const col = firstNonBlankCol(this.buffer.line(targetRow));
        this.buffer.setCursor({ row: targetRow, col });
        this.preferredCol = col;
      } else {
        this.buffer.replace(
          { start: { row: cur.row, col: 0 }, end: { row: cur.row, col: 0 } },
          raw + "\n",
        );
        const col = firstNonBlankCol(this.buffer.line(cur.row));
        this.buffer.setCursor({ row: cur.row, col });
        this.preferredCol = col;
      }
      this.emitChange();
      return true;
    }

    const line = this.buffer.line(cur.row);
    const insertCol = after ? nextCharCol(line, cur.col) : cur.col;
    const insertPos = { row: cur.row, col: insertCol };
    const startOffset = positionToOffset(this.buffer, insertPos);
    this.buffer.replace({ start: insertPos, end: insertPos }, entry.text);
    const lastOffset = startOffset + prevCharCol(entry.text, entry.text.length);
    const endPos = offsetToPosition(this.buffer, lastOffset);
    const col = clampNormalColOnLine(this.buffer.line(endPos.row), endPos.col);
    this.buffer.setCursor({ row: endPos.row, col });
    this.preferredCol = col;
    this.emitChange();
    return true;
  }

  private runSearch(pattern: string, direction: 1 | -1): boolean {
    const text = this.buffer.text();
    const matches = findMatches(text, compilePattern(pattern));
    const wasVisible = this.searchVisible;
    this.searchVisible = matches.length > 0;
    if (wasVisible || this.searchVisible) {
      this.emitSearch();
    }
    if (matches.length === 0) return false;

    const curOffset = positionToOffset(this.buffer, this.buffer.cursor());

    const totalLines = this.buffer.lineCount();
    let row = 0;
    let lineStartOffset = 0;
    let line = this.buffer.line(0);
    let lineLen = line.length;

    let firstPos: Position | null = null;
    let lastPos: Position | null = null;
    let chosenPos: Position | null = null;

    for (let i = 0; i < matches.length; i++) {
      const start = matches[i]!.start;
      while (row + 1 < totalLines && start > lineStartOffset + lineLen) {
        lineStartOffset += lineLen + 1;
        row++;
        line = this.buffer.line(row);
        lineLen = line.length;
      }
      const rawCol = Math.max(0, Math.min(lineLen, start - lineStartOffset));
      const landingCol = clampNormalColOnLine(line, rawCol);
      const landingOffset = lineStartOffset + landingCol;
      const landingPos = { row, col: landingCol };

      if (i === 0) firstPos = landingPos;
      lastPos = landingPos;

      if (direction === 1) {
        if (landingOffset > curOffset) {
          chosenPos = landingPos;
          break;
        }
      } else if (landingOffset < curOffset) {
        chosenPos = landingPos;
      }
    }

    const pos = chosenPos ?? (direction === 1 ? firstPos! : lastPos!);
    this.applyMotion(pos, false);
    return true;
  }

  private repeatSearch(multiplier: 1 | -1): void {
    if (!this.lastSearchPattern) return;
    const dir = (this.lastSearchDir * multiplier) as 1 | -1;
    this.runSearch(this.lastSearchPattern, dir);
  }

  private searchWordUnderCursor(direction: 1 | -1): void {
    const cur = this.buffer.cursor();
    const line = this.buffer.line(cur.row);
    if (line.length === 0) return;
    let col = cur.col;
    while (col < line.length && !isWordChar(line[col]!)) {
      col = nextCharCol(line, col);
    }
    if (col >= line.length) return;
    let start = col;
    let end = col + 1;
    while (start > 0 && isWordChar(line[start - 1]!)) start--;
    while (end < line.length && isWordChar(line[end]!)) end++;
    const word = line.slice(start, end);
    this.search(`\\b${word}\\b`, direction);
  }

  private undo(count: number): void {
    let changed = false;
    for (let i = 0; i < count; i++) {
      const snap = this.undoHistory.undo(this.takeSnapshot());
      if (!snap) break;
      this.buffer.setText(snap.text);
      this.buffer.setCursor(snap.cursor);
      this.clampNormalCursor();
      this.preferredCol = this.buffer.cursor().col;
      changed = true;
    }
    if (changed) {
      this.emitChange();
    }
  }

  private redo(count: number): void {
    let changed = false;
    for (let i = 0; i < count; i++) {
      const snap = this.undoHistory.redo(this.takeSnapshot());
      if (!snap) break;
      this.buffer.setText(snap.text);
      this.buffer.setCursor(snap.cursor);
      this.clampNormalCursor();
      this.preferredCol = this.buffer.cursor().col;
      changed = true;
    }
    if (changed) {
      this.emitChange();
    }
  }

  private leaveInsert(): void {
    const snap = this.insertSnapshot;
    this.insertSnapshot = null;
    if (snap && snap.text !== this.buffer.text()) {
      this.pushUndo(snap);
    }
    const cur = this.buffer.cursor();
    const line = this.buffer.line(cur.row);
    const col = clampNormalColOnLine(line, prevCharCol(line, cur.col));
    this.buffer.setCursor({ row: cur.row, col });
    this.preferredCol = col;
    this.setMode("normal");
    if (this.recordingChange) {
      this.commitRecording();
    }
  }

  private feedInsert(key: Key): "handled" | "ignored" {
    if (isIgnoredInInsert(key)) {
      return "ignored";
    }

    if (key.name === "escape" || (key.ctrl && (key.name === "[" || key.name === "c"))) {
      this.leaveInsert();
      return "handled";
    }

    const cur = this.buffer.cursor();
    const line = this.buffer.line(cur.row);

    if (key.ctrl && !key.meta && !key.shift) {
      if (key.name === "w") {
        this.insertDeleteWordBack(cur, line);
        return "handled";
      }
      if (key.name === "u") {
        this.insertDeleteLineBack(cur);
        return "handled";
      }
      return "handled";
    }

    if (!key.ctrl && !key.meta) {
      switch (key.name) {
        case "enter": {
          const indent = leadingWhitespace(line);
          this.buffer.replace({ start: cur, end: cur }, "\n" + indent);
          const next = { row: cur.row + 1, col: indent.length };
          this.buffer.setCursor(next);
          this.preferredCol = next.col;
          this.emitChange();
          return "handled";
        }
        case "tab": {
          if (key.shift) return "handled";
          this.buffer.replace({ start: cur, end: cur }, "  ");
          const next = { row: cur.row, col: cur.col + 2 };
          this.buffer.setCursor(next);
          this.preferredCol = next.col;
          this.emitChange();
          return "handled";
        }
        case "backspace": {
          this.insertBackspace(cur);
          return "handled";
        }
        case "delete": {
          this.insertDeleteForward(cur, line);
          return "handled";
        }
        case "left": {
          const col = prevCharCol(line, cur.col);
          this.buffer.setCursor({ row: cur.row, col });
          this.preferredCol = col;
          return "handled";
        }
        case "right": {
          const col = nextCharCol(line, cur.col);
          this.buffer.setCursor({ row: cur.row, col });
          this.preferredCol = col;
          return "handled";
        }
        case "up": {
          const row = Math.max(0, cur.row - 1);
          const targetLine = this.buffer.line(row);
          let col = Math.min(targetLine.length, this.preferredCol);
          if (col > 0 && col < targetLine.length && isSurrogatePairAt(targetLine, col - 1)) {
            col--;
          }
          this.buffer.setCursor({ row, col });
          return "handled";
        }
        case "down": {
          const maxRow = Math.max(0, this.buffer.lineCount() - 1);
          const row = Math.min(maxRow, cur.row + 1);
          const targetLine = this.buffer.line(row);
          let col = Math.min(targetLine.length, this.preferredCol);
          if (col > 0 && col < targetLine.length && isSurrogatePairAt(targetLine, col - 1)) {
            col--;
          }
          this.buffer.setCursor({ row, col });
          return "handled";
        }
        case "home": {
          this.buffer.setCursor({ row: cur.row, col: 0 });
          this.preferredCol = 0;
          return "handled";
        }
        case "end": {
          this.buffer.setCursor({ row: cur.row, col: line.length });
          this.preferredCol = line.length;
          return "handled";
        }
      }

      if (key.text !== undefined && key.text.length > 0) {
        this.buffer.replace({ start: cur, end: cur }, key.text);
        const next = { row: cur.row, col: cur.col + key.text.length };
        this.buffer.setCursor(next);
        this.preferredCol = next.col;
        this.emitChange();
        return "handled";
      }
    }

    return "handled";
  }

  private insertBackspace(cur: Position): void {
    if (cur.col > 0) {
      const line = this.buffer.line(cur.row);
      const start = { row: cur.row, col: prevCharCol(line, cur.col) };
      this.buffer.replace({ start, end: cur }, "");
      this.buffer.setCursor(start);
      this.preferredCol = start.col;
      this.emitChange();
    } else if (cur.row > 0) {
      const prevRow = cur.row - 1;
      const prevLen = this.buffer.line(prevRow).length;
      const start = { row: prevRow, col: prevLen };
      this.buffer.replace({ start, end: cur }, "");
      this.buffer.setCursor(start);
      this.preferredCol = start.col;
      this.emitChange();
    }
  }

  private insertDeleteForward(cur: Position, line: string): void {
    if (cur.col < line.length) {
      const endCol = nextCharCol(line, cur.col);
      this.buffer.replace({ start: cur, end: { row: cur.row, col: endCol } }, "");
      this.buffer.setCursor(cur);
      this.preferredCol = cur.col;
      this.emitChange();
    } else if (cur.row + 1 < this.buffer.lineCount()) {
      this.buffer.replace({ start: cur, end: { row: cur.row + 1, col: 0 } }, "");
      this.buffer.setCursor(cur);
      this.preferredCol = cur.col;
      this.emitChange();
    }
  }

  private insertDeleteWordBack(cur: Position, line: string): void {
    if (cur.col === 0) {
      this.insertBackspace(cur);
      return;
    }
    let col = cur.col;
    while (col > 0 && (line[col - 1] === " " || line[col - 1] === "\t")) {
      col--;
    }
    if (col > 0) {
      const prev0 = prevCharCol(line, col);
      const word = isWordChar(line[prev0]!);
      while (col > 0) {
        const prev = prevCharCol(line, col);
        if (line[prev] === " " || line[prev] === "\t" || isWordChar(line[prev]!) !== word) break;
        col = prev;
      }
    }
    const start = { row: cur.row, col };
    this.buffer.replace({ start, end: cur }, "");
    this.buffer.setCursor(start);
    this.preferredCol = start.col;
    this.emitChange();
  }

  private insertDeleteLineBack(cur: Position): void {
    if (cur.col === 0) return;
    const start = { row: cur.row, col: 0 };
    this.buffer.replace({ start, end: cur }, "");
    this.buffer.setCursor(start);
    this.preferredCol = 0;
    this.emitChange();
  }
}
