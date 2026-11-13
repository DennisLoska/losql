import { offsetToPosition, type Position, positionToOffset, type Range, type TextBuffer } from "./buffer";
import { clampNormalColOnLine, nextCharCol, prevCharCol } from "./motions";

export interface TextObjectResult {
  range: Range;
  linewise?: boolean;
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

function isBlankLine(line: string): boolean {
  return line.trim().length === 0;
}

function wordObject(buffer: TextBuffer, cursor: Position, around: boolean, bigWord: boolean): TextObjectResult | null {
  const line = buffer.line(cursor.row);
  if (line.length === 0) return null;
  const col = clampNormalColOnLine(line, cursor.col);
  const cls = classifyChar(line[col]!, bigWord);

  let start = col;
  let end = nextCharCol(line, col);
  while (start > 0) {
    const prev = prevCharCol(line, start);
    if (classifyChar(line[prev]!, bigWord) !== cls) break;
    start = prev;
  }
  while (end < line.length && classifyChar(line[end]!, bigWord) === cls) {
    end = nextCharCol(line, end);
  }

  if (around) {
    if (cls === "blank") {
      if (end < line.length) {
        const nextCls = classifyChar(line[end]!, bigWord);
        while (end < line.length && classifyChar(line[end]!, bigWord) === nextCls) {
          end = nextCharCol(line, end);
        }
      } else if (start > 0) {
        const prev0 = prevCharCol(line, start);
        const prevCls = classifyChar(line[prev0]!, bigWord);
        while (start > 0) {
          const prev = prevCharCol(line, start);
          if (classifyChar(line[prev]!, bigWord) !== prevCls) break;
          start = prev;
        }
      }
    } else {
      let trailEnd = end;
      while (trailEnd < line.length && classifyChar(line[trailEnd]!, bigWord) === "blank") {
        trailEnd = nextCharCol(line, trailEnd);
      }
      if (trailEnd > end) {
        end = trailEnd;
      } else {
        while (start > 0) {
          const prev = prevCharCol(line, start);
          if (classifyChar(line[prev]!, bigWord) !== "blank") break;
          start = prev;
        }
      }
    }
  }

  return {
    range: {
      start: { row: cursor.row, col: start },
      end: { row: cursor.row, col: end },
    },
  };
}

function quoteObject(buffer: TextBuffer, cursor: Position, around: boolean, quote: string): TextObjectResult | null {
  const line = buffer.line(cursor.row);
  const indices: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === quote) {
      indices.push(i);
    }
  }
  if (indices.length < 2) return null;

  let openIdx = -1;
  let closeIdx = -1;

  for (let p = 0; p + 1 < indices.length; p += 2) {
    const o = indices[p]!;
    const c = indices[p + 1]!;
    if (cursor.col <= c) {
      openIdx = o;
      closeIdx = c;
      break;
    }
  }

  if (openIdx < 0) return null;

  if (!around) {
    return {
      range: {
        start: { row: cursor.row, col: openIdx + 1 },
        end: { row: cursor.row, col: closeIdx },
      },
    };
  }

  let endCol = closeIdx + 1;
  while (endCol < line.length && (line[endCol] === " " || line[endCol] === "\t")) {
    endCol++;
  }
  let startCol = openIdx;
  if (endCol === closeIdx + 1) {
    while (startCol > 0 && (line[startCol - 1] === " " || line[startCol - 1] === "\t")) {
      startCol--;
    }
  }

  return {
    range: {
      start: { row: cursor.row, col: startCol },
      end: { row: cursor.row, col: endCol },
    },
  };
}

function pairObject(
  buffer: TextBuffer,
  cursor: Position,
  around: boolean,
  openChar: string,
  closeChar: string,
): TextObjectResult | null {
  const text = buffer.text();
  if (text.length === 0) return null;
  let curOffset = positionToOffset(buffer, cursor);
  if (curOffset >= text.length) curOffset = text.length - 1;

  // If cursor is before an openChar on the same line and not inside an enclosing pair, check if cursor is on openChar or before it on the line
  let openOffset = -1;
  let closeOffset = -1;

  if (text[curOffset] === openChar) {
    openOffset = curOffset;
  } else if (text[curOffset] === closeChar) {
    // Scan backwards from curOffset - 1 to find matching openChar
    let depth = 1;
    for (let i = curOffset - 1; i >= 0; i--) {
      if (text[i] === closeChar) depth++;
      else if (text[i] === openChar) {
        depth--;
        if (depth === 0) {
          openOffset = i;
          closeOffset = curOffset;
          break;
        }
      }
    }
  }

  if (openOffset < 0) {
    let depth = 0;
    for (let i = curOffset; i >= 0; i--) {
      if (i < curOffset && text[i] === closeChar) {
        depth++;
      } else if (text[i] === openChar) {
        if (depth === 0) {
          openOffset = i;
          break;
        }
        depth--;
      }
    }
  }

  if (openOffset < 0) return null;

  if (closeOffset < 0) {
    let depth = 1;
    for (let i = openOffset + 1; i < text.length; i++) {
      if (text[i] === openChar) depth++;
      else if (text[i] === closeChar) {
        depth--;
        if (depth === 0) {
          closeOffset = i;
          break;
        }
      }
    }
  }

  if (closeOffset < 0) return null;

  const startOffset = around ? openOffset : openOffset + 1;
  const endOffset = around ? closeOffset + 1 : closeOffset;

  return {
    range: {
      start: offsetToPosition(buffer, startOffset),
      end: offsetToPosition(buffer, endOffset),
    },
  };
}

function paragraphObject(buffer: TextBuffer, cursor: Position, around: boolean): TextObjectResult | null {
  const totalLines = buffer.lineCount();
  if (totalLines === 0) return null;

  const curBlank = isBlankLine(buffer.line(cursor.row));
  let startRow = cursor.row;
  let endRow = cursor.row;

  if (curBlank) {
    while (startRow > 0 && isBlankLine(buffer.line(startRow - 1))) {
      startRow--;
    }
    while (endRow + 1 < totalLines && isBlankLine(buffer.line(endRow + 1))) {
      endRow++;
    }
    if (around && endRow + 1 < totalLines) {
      endRow++;
      while (endRow + 1 < totalLines && !isBlankLine(buffer.line(endRow + 1))) {
        endRow++;
      }
    }
  } else {
    while (startRow > 0 && !isBlankLine(buffer.line(startRow - 1))) {
      startRow--;
    }
    while (endRow + 1 < totalLines && !isBlankLine(buffer.line(endRow + 1))) {
      endRow++;
    }
    if (around) {
      if (endRow + 1 < totalLines && isBlankLine(buffer.line(endRow + 1))) {
        while (endRow + 1 < totalLines && isBlankLine(buffer.line(endRow + 1))) {
          endRow++;
        }
      } else if (startRow > 0 && isBlankLine(buffer.line(startRow - 1))) {
        while (startRow > 0 && isBlankLine(buffer.line(startRow - 1))) {
          startRow--;
        }
      }
    }
  }

  return {
    range: {
      start: { row: startRow, col: 0 },
      end: { row: endRow, col: buffer.line(endRow).length },
    },
    linewise: true,
  };
}

function statementObject(
  buffer: TextBuffer,
  cursor: Position,
  around: boolean,
  statementRange?: (position: Position) => Range | null,
): TextObjectResult | null {
  if (!statementRange) return null;
  const inner = statementRange(cursor);
  if (!inner) return null;
  if (!around) {
    return { range: inner };
  }

  const text = buffer.text();
  const startOffset = positionToOffset(buffer, inner.start);
  let endOffset = positionToOffset(buffer, inner.end);

  while (endOffset < text.length && /\s/.test(text[endOffset]!)) {
    endOffset++;
  }
  if (endOffset < text.length && text[endOffset] === ";") {
    endOffset++;
    while (endOffset < text.length && /\s/.test(text[endOffset]!)) {
      endOffset++;
    }
  }

  return {
    range: {
      start: offsetToPosition(buffer, startOffset),
      end: offsetToPosition(buffer, endOffset),
    },
  };
}

export function resolveTextObject(
  buffer: TextBuffer,
  cursor: Position,
  around: boolean,
  key: string,
  statementRange?: (position: Position) => Range | null,
): TextObjectResult | null {
  switch (key) {
    case "w":
      return wordObject(buffer, cursor, around, false);
    case "W":
      return wordObject(buffer, cursor, around, true);
    case '"':
    case "'":
    case "`":
      return quoteObject(buffer, cursor, around, key);
    case "(":
    case ")":
    case "b":
      return pairObject(buffer, cursor, around, "(", ")");
    case "[":
    case "]":
      return pairObject(buffer, cursor, around, "[", "]");
    case "{":
    case "}":
    case "B":
      return pairObject(buffer, cursor, around, "{", "}");
    case "p":
      return paragraphObject(buffer, cursor, around);
    case "s":
      return statementObject(buffer, cursor, around, statementRange);
    default:
      return null;
  }
}
