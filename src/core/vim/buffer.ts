export interface Position {
  row: number;
  col: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface TextBuffer {
  lineCount(): number;
  line(row: number): string;
  text(): string;
  setText(text: string): void;
  cursor(): Position;
  setCursor(position: Position): void;
  replace(range: Range, text: string): void;
  setSelection(range: Range | null, linewise?: boolean): void;
}

export class MemoryBuffer implements TextBuffer {
  private lines: string[];
  private pos: Position = { row: 0, col: 0 };
  selection: { range: Range; linewise: boolean } | null = null;

  constructor(text = "") {
    this.lines = text.split("\n");
    if (this.lines.length === 0) {
      this.lines = [""];
    }
  }

  lineCount(): number {
    return this.lines.length;
  }

  line(row: number): string {
    return this.lines[row] ?? "";
  }

  text(): string {
    return this.lines.join("\n");
  }

  setText(text: string): void {
    this.lines = text.split("\n");
    if (this.lines.length === 0) {
      this.lines = [""];
    }
    this.setCursor(this.pos);
  }

  cursor(): Position {
    return { row: this.pos.row, col: this.pos.col };
  }

  setCursor(position: Position): void {
    const maxRow = Math.max(0, this.lines.length - 1);
    const row = Math.max(0, Math.min(maxRow, position.row));
    const line = this.lines[row]!;
    const maxCol = line.length;
    let col = Math.max(0, Math.min(maxCol, position.col));
    if (col > 0 && col < maxCol) {
      const low = line.charCodeAt(col);
      const high = line.charCodeAt(col - 1);
      if (low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff) {
        col--;
      }
    }
    this.pos = { row, col };
  }

  replace(range: Range, text: string): void {
    const startOffset = positionToOffset(this, range.start);
    const endOffset = positionToOffset(this, range.end);
    const full = this.text();
    const updated = full.slice(0, startOffset) + text + full.slice(endOffset);
    this.lines = updated.split("\n");
    if (this.lines.length === 0) {
      this.lines = [""];
    }
    this.setCursor(this.pos);
  }

  setSelection(range: Range | null, linewise = false): void {
    if (range === null) {
      this.selection = null;
    } else {
      this.selection = {
        range: {
          start: { row: range.start.row, col: range.start.col },
          end: { row: range.end.row, col: range.end.col },
        },
        linewise,
      };
    }
  }
}

export function comparePositions(a: Position, b: Position): number {
  if (a.row !== b.row) return a.row - b.row;
  return a.col - b.col;
}

export function positionToOffset(buffer: TextBuffer, position: Position): number {
  const totalLines = buffer.lineCount();
  const clampedRow = Math.max(0, Math.min(totalLines - 1, position.row));
  let offset = 0;
  for (let r = 0; r < clampedRow; r++) {
    offset += buffer.line(r).length + 1;
  }
  const lineLen = buffer.line(clampedRow).length;
  const clampedCol = Math.max(0, Math.min(lineLen, position.col));
  return offset + clampedCol;
}

export function offsetToPosition(buffer: TextBuffer, offset: number): Position {
  if (offset <= 0) return { row: 0, col: 0 };
  const totalLines = buffer.lineCount();
  let remaining = offset;
  for (let r = 0; r < totalLines; r++) {
    const len = buffer.line(r).length;
    if (remaining <= len) {
      return { row: r, col: remaining };
    }
    remaining -= len + 1;
  }
  const lastRow = totalLines - 1;
  return { row: lastRow, col: buffer.line(lastRow).length };
}
