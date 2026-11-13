import type { Position, TextBuffer } from "./buffer";

export type FindKind = "f" | "F" | "t" | "T";

export interface FindState {
  kind: FindKind;
  char: string;
}

export interface MotionContext {
  preferredCol: number;
  hasExplicitCount: boolean;
  pageSize: number;
}

export function isSurrogatePairAt(line: string, col: number): boolean {
  if (col < 0 || col + 1 >= line.length) return false;
  const high = line.charCodeAt(col);
  const low = line.charCodeAt(col + 1);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

export function charLenAt(line: string, col: number): number {
  if (col < 0 || col >= line.length) return 0;
  return isSurrogatePairAt(line, col) ? 2 : 1;
}

export function prevCharCol(line: string, col: number): number {
  if (col <= 0) return 0;
  const c = Math.min(col, line.length);
  if (c >= 2 && isSurrogatePairAt(line, c - 2)) {
    return c - 2;
  }
  return c - 1;
}

export function nextCharCol(line: string, col: number): number {
  if (col >= line.length) return line.length;
  const c = Math.max(0, col);
  return Math.min(line.length, c + charLenAt(line, c));
}

export function clampNormalColOnLine(line: string, col: number): number {
  if (line.length === 0) return 0;
  const lastStart = prevCharCol(line, line.length);
  let c = Math.max(0, Math.min(lastStart, col));
  if (c > 0 && isSurrogatePairAt(line, c - 1)) {
    c--;
  }
  return c;
}

export function clampNormalCol(lineLen: number, col: number): number {
  return Math.max(0, Math.min(Math.max(0, lineLen - 1), col));
}

export function firstNonBlankCol(line: string): number {
  for (let i = 0; i < line.length; i += charLenAt(line, i)) {
    const ch = line[i]!;
    if (ch !== " " && ch !== "\t") return i;
  }
  return clampNormalColOnLine(line, 0);
}

type CharClass = "blank" | "word" | "punct";

function classifyChar(ch: string, bigWord: boolean): CharClass {
  if (ch === " " || ch === "\t") return "blank";
  if (bigWord) return "word";
  if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_") {
    return "word";
  }
  return "punct";
}

export function moveLeft(buffer: TextBuffer, cursor: Position, count: number): Position {
  const line = buffer.line(cursor.row);
  let col = clampNormalColOnLine(line, cursor.col);
  for (let i = 0; i < count; i++) {
    if (col === 0) break;
    col = prevCharCol(line, col);
  }
  return { row: cursor.row, col };
}

export function moveRight(buffer: TextBuffer, cursor: Position, count: number): Position {
  const line = buffer.line(cursor.row);
  if (line.length === 0) return { row: cursor.row, col: 0 };
  const lastStart = prevCharCol(line, line.length);
  let col = clampNormalColOnLine(line, cursor.col);
  for (let i = 0; i < count; i++) {
    if (col >= lastStart) break;
    col = Math.min(lastStart, nextCharCol(line, col));
  }
  return { row: cursor.row, col };
}

export function moveDown(buffer: TextBuffer, cursor: Position, count: number, ctx: MotionContext): Position {
  const maxRow = Math.max(0, buffer.lineCount() - 1);
  const row = Math.min(maxRow, cursor.row + count);
  const line = buffer.line(row);
  const col = clampNormalColOnLine(line, ctx.preferredCol);
  return { row, col };
}

export function moveUp(buffer: TextBuffer, cursor: Position, count: number, ctx: MotionContext): Position {
  const row = Math.max(0, cursor.row - count);
  const line = buffer.line(row);
  const col = clampNormalColOnLine(line, ctx.preferredCol);
  return { row, col };
}

export function moveLineStart(_buffer: TextBuffer, cursor: Position): Position {
  return { row: cursor.row, col: 0 };
}

export function moveFirstNonBlank(buffer: TextBuffer, cursor: Position): Position {
  const line = buffer.line(cursor.row);
  return { row: cursor.row, col: firstNonBlankCol(line) };
}

export function moveLineEnd(buffer: TextBuffer, cursor: Position, count: number): Position {
  const maxRow = Math.max(0, buffer.lineCount() - 1);
  const row = Math.min(maxRow, cursor.row + Math.max(0, count - 1));
  const line = buffer.line(row);
  return { row, col: clampNormalColOnLine(line, line.length) };
}

export function moveGotoFirstLine(buffer: TextBuffer, _cursor: Position, count: number, ctx: MotionContext): Position {
  const maxRow = Math.max(0, buffer.lineCount() - 1);
  const row = ctx.hasExplicitCount ? Math.max(0, Math.min(maxRow, count - 1)) : 0;
  return { row, col: firstNonBlankCol(buffer.line(row)) };
}

export function moveGotoLastLine(buffer: TextBuffer, _cursor: Position, count: number, ctx: MotionContext): Position {
  const maxRow = Math.max(0, buffer.lineCount() - 1);
  const row = ctx.hasExplicitCount ? Math.max(0, Math.min(maxRow, count - 1)) : maxRow;
  return { row, col: firstNonBlankCol(buffer.line(row)) };
}

export function moveHalfPageDown(buffer: TextBuffer, cursor: Position, count: number, ctx: MotionContext): Position {
  const step = Math.max(1, Math.floor(ctx.pageSize / 2)) * count;
  return moveDown(buffer, cursor, step, ctx);
}

export function moveHalfPageUp(buffer: TextBuffer, cursor: Position, count: number, ctx: MotionContext): Position {
  const step = Math.max(1, Math.floor(ctx.pageSize / 2)) * count;
  return moveUp(buffer, cursor, step, ctx);
}

function stepWordForwardOnce(buffer: TextBuffer, pos: Position, bigWord: boolean): Position {
  const totalLines = buffer.lineCount();
  let row = pos.row;
  let col = pos.col;
  let line = buffer.line(row);

  if (line.length > 0 && col < line.length) {
    const startClass = classifyChar(line[col]!, bigWord);
    if (startClass !== "blank") {
      while (col < line.length && classifyChar(line[col]!, bigWord) === startClass) {
        col = nextCharCol(line, col);
      }
    }
    while (col < line.length && classifyChar(line[col]!, bigWord) === "blank") {
      col = nextCharCol(line, col);
    }
    if (col < line.length) {
      return { row, col };
    }
  }

  while (row + 1 < totalLines) {
    row++;
    line = buffer.line(row);
    if (line.length === 0) {
      return { row, col: 0 };
    }
    col = 0;
    while (col < line.length && classifyChar(line[col]!, bigWord) === "blank") {
      col = nextCharCol(line, col);
    }
    if (col < line.length) {
      return { row, col };
    }
  }

  const lastLine = buffer.line(row);
  return { row, col: clampNormalColOnLine(lastLine, lastLine.length) };
}

export function moveWordForward(buffer: TextBuffer, cursor: Position, count: number, bigWord: boolean): Position {
  let pos = { row: cursor.row, col: cursor.col };
  for (let i = 0; i < count; i++) {
    const next = stepWordForwardOnce(buffer, pos, bigWord);
    if (next.row === pos.row && next.col === pos.col) break;
    pos = next;
  }
  return pos;
}

export function moveWordForwardOperator(
  buffer: TextBuffer,
  cursor: Position,
  count: number,
  bigWord: boolean,
): Position {
  let pos = { row: cursor.row, col: cursor.col };
  for (let i = 0; i < count; i++) {
    const line = buffer.line(pos.row);
    let col = pos.col;
    if (line.length > 0 && col < line.length) {
      const startClass = classifyChar(line[col]!, bigWord);
      if (startClass !== "blank") {
        while (col < line.length && classifyChar(line[col]!, bigWord) === startClass) {
          col = nextCharCol(line, col);
        }
      }
      while (col < line.length && classifyChar(line[col]!, bigWord) === "blank") {
        col = nextCharCol(line, col);
      }
      if (col < line.length || i + 1 === count || pos.row + 1 >= buffer.lineCount()) {
        pos = { row: pos.row, col };
        if (col >= line.length && pos.row + 1 >= buffer.lineCount()) break;
        continue;
      }
    }
    const next = stepWordForwardOnce(buffer, pos, bigWord);
    if (next.row === pos.row && next.col === pos.col) break;
    pos = next;
  }
  return pos;
}

function stepWordBackwardOnce(buffer: TextBuffer, pos: Position, bigWord: boolean): Position {
  let row = pos.row;
  let col = pos.col;
  let line = buffer.line(row);

  if (col > 0) {
    col = prevCharCol(line, col);
  } else {
    col = -1;
  }
  while (true) {
    if (col >= 0) {
      while (col >= 0 && classifyChar(line[col]!, bigWord) === "blank") {
        col = col > 0 ? prevCharCol(line, col) : -1;
      }
      if (col >= 0) {
        const cls = classifyChar(line[col]!, bigWord);
        while (col > 0) {
          const prev = prevCharCol(line, col);
          if (classifyChar(line[prev]!, bigWord) !== cls) break;
          col = prev;
        }
        return { row, col };
      }
    }

    if (row === 0) {
      return { row: 0, col: 0 };
    }
    row--;
    line = buffer.line(row);
    if (line.length === 0) {
      return { row, col: 0 };
    }
    col = prevCharCol(line, line.length);
  }
}

export function moveWordBackward(buffer: TextBuffer, cursor: Position, count: number, bigWord: boolean): Position {
  let pos = { row: cursor.row, col: cursor.col };
  for (let i = 0; i < count; i++) {
    const next = stepWordBackwardOnce(buffer, pos, bigWord);
    if (next.row === pos.row && next.col === pos.col) break;
    pos = next;
  }
  return pos;
}

function stepWordEndOnce(buffer: TextBuffer, pos: Position, bigWord: boolean): Position {
  const totalLines = buffer.lineCount();
  let row = pos.row;
  let line = buffer.line(row);
  let col = nextCharCol(line, pos.col);

  while (true) {
    while (col < line.length && classifyChar(line[col]!, bigWord) === "blank") {
      col = nextCharCol(line, col);
    }
    if (col < line.length) {
      const cls = classifyChar(line[col]!, bigWord);
      while (true) {
        const next = nextCharCol(line, col);
        if (next >= line.length || classifyChar(line[next]!, bigWord) !== cls) break;
        col = next;
      }
      return { row, col };
    }
    if (row + 1 >= totalLines) {
      return { row, col: clampNormalColOnLine(line, line.length) };
    }
    row++;
    line = buffer.line(row);
    col = 0;
  }
}

export function moveWordEnd(buffer: TextBuffer, cursor: Position, count: number, bigWord: boolean): Position {
  let pos = { row: cursor.row, col: cursor.col };
  for (let i = 0; i < count; i++) {
    const next = stepWordEndOnce(buffer, pos, bigWord);
    if (next.row === pos.row && next.col === pos.col) break;
    pos = next;
  }
  return pos;
}

export function moveFindCharWithResult(
  buffer: TextBuffer,
  cursor: Position,
  count: number,
  find: FindState,
  repeat = false,
): { position: Position; found: boolean } {
  const line = buffer.line(cursor.row);
  const { kind, char } = find;

  if (kind === "f" || kind === "t") {
    let col = cursor.col;
    for (let i = 0; i < count; i++) {
      let searchStart = nextCharCol(line, col);
      if (kind === "t" && (repeat || i > 0) && line.startsWith(char, searchStart)) {
        searchStart = nextCharCol(line, searchStart);
      }
      const idx = line.indexOf(char, searchStart);
      if (idx < 0) return { position: cursor, found: false };
      col = idx;
    }
    return {
      position: { row: cursor.row, col: kind === "t" ? prevCharCol(line, col) : col },
      found: true,
    };
  } else {
    let col = cursor.col;
    for (let i = 0; i < count; i++) {
      if (col <= 0) return { position: cursor, found: false };
      let searchStart = prevCharCol(line, col);
      if (kind === "T" && (repeat || i > 0) && searchStart >= 0 && line.startsWith(char, searchStart)) {
        if (searchStart === 0) return { position: cursor, found: false };
        searchStart = prevCharCol(line, searchStart);
      }
      if (searchStart < 0) return { position: cursor, found: false };
      const idx = line.lastIndexOf(char, searchStart);
      if (idx < 0) return { position: cursor, found: false };
      col = idx;
    }
    return {
      position: { row: cursor.row, col: kind === "T" ? clampNormalColOnLine(line, nextCharCol(line, col)) : col },
      found: true,
    };
  }
}

const BRACKET_PAIRS: Record<string, { match: string; dir: 1 | -1 }> = {
  "(": { match: ")", dir: 1 },
  "[": { match: "]", dir: 1 },
  "{": { match: "}", dir: 1 },
  ")": { match: "(", dir: -1 },
  "]": { match: "[", dir: -1 },
  "}": { match: "{", dir: -1 },
};

export function moveMatchBracket(buffer: TextBuffer, cursor: Position): Position {
  const line = buffer.line(cursor.row);
  let startCol = cursor.col;
  let info = BRACKET_PAIRS[line[startCol] ?? ""];

  if (!info) {
    let found = -1;
    for (let c = startCol + 1; c < line.length; c++) {
      if (BRACKET_PAIRS[line[c]!]) {
        found = c;
        break;
      }
    }
    if (found < 0) return cursor;
    startCol = found;
    info = BRACKET_PAIRS[line[startCol]!]!;
  }

  const openChar = line[startCol]!;
  const { match: closeChar, dir } = info;
  let depth = 1;
  let r = cursor.row;
  let c = startCol + dir;
  const totalLines = buffer.lineCount();

  while (r >= 0 && r < totalLines) {
    const curLine = buffer.line(r);
    while (c >= 0 && c < curLine.length) {
      const ch = curLine[c]!;
      if (ch === openChar) {
        depth++;
      } else if (ch === closeChar) {
        depth--;
        if (depth === 0) {
          return { row: r, col: c };
        }
      }
      c += dir;
    }
    r += dir;
    if (r >= 0 && r < totalLines) {
      c = dir === 1 ? 0 : buffer.line(r).length - 1;
    }
  }

  return cursor;
}

function isBlankLine(line: string): boolean {
  return line.trim().length === 0;
}

export function moveParagraphBackward(buffer: TextBuffer, cursor: Position, count: number): Position {
  let row = cursor.row;
  for (let i = 0; i < count; i++) {
    const prev = row;
    while (row > 0 && isBlankLine(buffer.line(row))) {
      row--;
    }
    while (row > 0 && !isBlankLine(buffer.line(row))) {
      row--;
    }
    if (row === prev) break;
  }
  const line = buffer.line(row);
  return { row, col: clampNormalCol(line.length, 0) };
}

export function moveParagraphForward(buffer: TextBuffer, cursor: Position, count: number): Position {
  const maxRow = Math.max(0, buffer.lineCount() - 1);
  let row = cursor.row;
  for (let i = 0; i < count; i++) {
    const prev = row;
    while (row < maxRow && isBlankLine(buffer.line(row))) {
      row++;
    }
    while (row < maxRow && !isBlankLine(buffer.line(row))) {
      row++;
    }
    if (row === prev) break;
  }
  const line = buffer.line(row);
  return { row, col: clampNormalCol(line.length, 0) };
}
