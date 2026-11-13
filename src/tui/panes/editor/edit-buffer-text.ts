import type { EditBuffer, RGBA, TextareaRenderable } from "@opentui/core";
import type { Position, Range, TextBuffer } from "../../../core/vim/buffer";

const ASCII_PRINTABLE_RE = /^[\x20-\x7e]*$/;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function isAsciiPrintable(text: string): boolean {
  return ASCII_PRINTABLE_RE.test(text);
}

let toBufferColConversions = 0;

export function getToBufferColConversions(): number {
  return toBufferColConversions;
}

export function resetToBufferColConversions(): void {
  toBufferColConversions = 0;
}

/**
 * Converts a UTF-16 column index on `line` to the display column unit expected by OpenTUI's `EditBuffer`.
 * When `utf16Col` falls inside a grapheme cluster, returns the display column of that cluster's start.
 */
export function toBufferCol(
  editBuffer: EditBuffer,
  line: string,
  utf16Col: number,
  asciiLine?: boolean,
): number {
  toBufferColConversions++;
  const clamped = Math.max(0, Math.min(line.length, utf16Col));
  if (clamped === 0) return 0;
  if (asciiLine ?? ASCII_PRINTABLE_RE.test(line)) return clamped;
  if (clamped >= line.length) return editBuffer.measureText(line);
  let clusterStart = clamped;
  for (const seg of GRAPHEME_SEGMENTER.segment(line)) {
    const start = seg.index;
    const end = start + seg.segment.length;
    if (clamped >= start && clamped < end) {
      clusterStart = start;
      break;
    }
    if (start >= clamped) break;
  }
  if (clusterStart === 0) return 0;
  const prefix = line.slice(0, clusterStart);
  if (ASCII_PRINTABLE_RE.test(prefix)) return clusterStart;
  return editBuffer.measureText(prefix);
}

/**
 * Converts an OpenTUI `EditBuffer` display column on `row` back to a UTF-16 column index on `line`.
 */
export function fromBufferCol(
  editBuffer: EditBuffer,
  row: number,
  line: string,
  bufferCol: number,
): number {
  if (bufferCol <= 0 || line.length === 0) return 0;
  if (ASCII_PRINTABLE_RE.test(line)) return Math.min(line.length, bufferCol);
  return Math.min(line.length, editBuffer.getTextRangeByCoords(row, 0, row, bufferCol).length);
}

/** TextBuffer over an OpenTUI EditBuffer. Columns are UTF-16 code units, converted to/from EditBuffer columns here. */
export class EditBufferTextBuffer implements TextBuffer {
  private lines: string[] | null = null;
  private cachedText: string | null = null;
  private currentSelection: { range: Range; linewise: boolean } | null = null;
  private stickyCursor: { row: number; bufCol: number; utf16Col: number } | null = null;

  constructor(
    private readonly textarea: TextareaRenderable,
    private readonly selectionColor: () => RGBA,
  ) {}

  private all(): string[] {
    if (this.lines === null) {
      const raw = this.cachedText ?? this.textarea.editBuffer.getText();
      this.cachedText = raw;
      this.lines = raw.split("\n");
    }
    return this.lines;
  }

  private readLineFromBuffer(row: number): string {
    const buffer = this.textarea.editBuffer;
    const startOffset = buffer.getLineStartOffset(row);
    const totalLines = buffer.getLineCount();
    const endOffset =
      row + 1 < totalLines
        ? Math.max(startOffset, buffer.getLineStartOffset(row + 1) - 1)
        : buffer._getEOF().offset;
    return buffer.getTextRange(startOffset, endOffset);
  }

  private syncAllFromBuffer(): void {
    const raw = this.textarea.editBuffer.getText();
    this.cachedText = raw;
    this.lines = raw.split("\n");
  }

  lineCount(): number {
    return this.all().length;
  }

  line(row: number): string {
    return this.all()[row] ?? "";
  }

  text(): string {
    if (this.cachedText === null) {
      this.cachedText =
        this.lines !== null ? this.lines.join("\n") : this.textarea.editBuffer.getText();
    }
    return this.cachedText;
  }

  setText(text: string): void {
    const prevPos = this.cursor();
    this.stickyCursor = null;
    this.textarea.editBuffer.setText(text);
    this.syncAllFromBuffer();
    this.setCursor(prevPos);
  }

  cursor(): Position {
    const { row, col } = this.textarea.editBuffer.getCursorPosition();
    if (this.stickyCursor && this.stickyCursor.row === row && this.stickyCursor.bufCol === col) {
      const lineText = this.line(row);
      return {
        row,
        col: Math.max(0, Math.min(lineText.length, this.stickyCursor.utf16Col)),
      };
    }
    this.stickyCursor = null;
    const lineText = this.line(row);
    return {
      row,
      col: fromBufferCol(this.textarea.editBuffer, row, lineText, col),
    };
  }

  setCursor(position: Position): void {
    const total = this.lineCount();
    const row = Math.max(0, Math.min(Math.max(0, total - 1), position.row));
    const lineText = this.line(row);
    let col = Math.max(0, Math.min(lineText.length, position.col));
    if (col > 0 && col < lineText.length) {
      const low = lineText.charCodeAt(col);
      const high = lineText.charCodeAt(col - 1);
      if (low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff) {
        col--;
      }
    }
    const bufCol = toBufferCol(this.textarea.editBuffer, lineText, col);
    this.textarea.editBuffer.setCursor(row, bufCol);
    const actual = this.textarea.editBuffer.getCursorPosition();
    this.stickyCursor = { row: actual.row, bufCol: actual.col, utf16Col: col };
  }

  replace(range: Range, text: string): void {
    const prevPos = this.cursor();
    this.stickyCursor = null;
    const buffer = this.textarea.editBuffer;
    const { start, end } = range;
    const totalLinesBefore = this.lineCount();
    const startLine = this.line(start.row);
    const endLine = start.row === end.row ? startLine : this.line(end.row);

    let allPlain = true;
    for (let r = start.row; r <= end.row; r++) {
      if (!isAsciiPrintable(this.line(r))) {
        allPlain = false;
        break;
      }
    }
    const insertedLines = text.split("\n");
    if (allPlain) {
      for (const l of insertedLines) {
        if (!isAsciiPrintable(l)) {
          allPlain = false;
          break;
        }
      }
    }

    const prefix = startLine.slice(0, start.col);
    const suffix = endLine.slice(end.col);
    const combined = prefix + text + suffix;
    const newLines = combined.split("\n");

    if (allPlain) {
      const startCol = start.col;
      const endCol = end.col;
      if (start.row !== end.row || startCol !== endCol) {
        buffer.deleteRange(start.row, startCol, end.row, endCol);
      }
      buffer.setCursor(start.row, startCol);
      if (text !== "") {
        buffer.insertText(text);
      }
    } else {
      const endLineWidth = buffer.measureText(endLine);
      let canDeleteWholeLines = true;
      for (let r = start.row; r <= end.row; r++) {
        const l = this.line(r);
        if (l.length > 0 && buffer.measureText(l) === 0) {
          canDeleteWholeLines = false;
          break;
        }
      }
      if (canDeleteWholeLines) {
        if (start.row !== end.row || endLineWidth > 0) {
          buffer.deleteRange(start.row, 0, end.row, endLineWidth);
        }
        buffer.setCursor(start.row, 0);
        if (combined !== "") {
          buffer.insertText(combined);
        }
      } else if (end.row + 1 < totalLinesBefore) {
        buffer.deleteRange(start.row, 0, end.row + 1, 0);
        buffer.setCursor(start.row, 0);
        buffer.insertText(combined + "\n");
      } else if (start.row > 0) {
        const prevRow = start.row - 1;
        const prevWidth = buffer.measureText(this.line(prevRow));
        buffer.deleteRange(prevRow, prevWidth, end.row, endLineWidth);
        buffer.setCursor(prevRow, prevWidth);
        buffer.insertText("\n" + combined);
      } else {
        buffer.setText(combined);
      }
    }

    const allLines = this.all();
    if (start.row === end.row && newLines.length === 1) {
      allLines[start.row] = combined;
    } else {
      allLines.splice(start.row, end.row - start.row + 1, ...newLines);
    }
    this.cachedText = null;

    if (buffer.getLineCount() !== allLines.length) {
      this.syncAllFromBuffer();
    } else {
      for (let i = 0; i < newLines.length; i++) {
        const r = start.row + i;
        const actualLine = this.readLineFromBuffer(r);
        if (actualLine !== allLines[r]) {
          this.syncAllFromBuffer();
          break;
        }
      }
    }

    this.setCursor(prevPos);
  }

  setSelection(range: Range | null, linewise = false): void {
    const view = this.textarea.editorView;
    if (range === null) {
      this.currentSelection = null;
      view.resetSelection();
      return;
    }
    this.currentSelection = {
      range: {
        start: { row: range.start.row, col: range.start.col },
        end: { row: range.end.row, col: range.end.col },
      },
      linewise,
    };
    const buffer = this.textarea.editBuffer;
    const startLine = this.line(range.start.row);
    const endLine = range.start.row === range.end.row ? startLine : this.line(range.end.row);
    const startCol = toBufferCol(buffer, startLine, range.start.col);
    const endCol = toBufferCol(buffer, endLine, range.end.col);
    view.setSelection(
      buffer.positionToOffset(range.start.row, startCol),
      buffer.positionToOffset(range.end.row, endCol),
      this.selectionColor(),
    );
  }

  selection(): { range: Range; linewise: boolean } | null {
    return this.currentSelection;
  }
}
