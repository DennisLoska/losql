import { rowToObject } from "../../../core/db/format";
import { uniqueColumnNames } from "../../../core/db/cells";
import type { Cell, Result } from "../../../core/db/types";
import { compilePattern } from "../../../core/vim/search";
import { cellWidth, cutCells, fitCells } from "../../ui/cells";
import { printable } from "../../ui/printable";

export const MAX_COLUMN_WIDTH = 40;
export const NULL_GLYPH = "∅";

export function displayCell(cell: Cell): string {
  return cleanCellText(rawCellText(cell));
}

/** The text of a cell before line breaks, tabs and control characters are made visible. */
function rawCellText(cell: Cell): string {
  if (cell === null) return NULL_GLYPH;
  return typeof cell === "object" ? JSON.stringify(cell) : String(cell);
}

function cleanCellText(raw: string): string {
  return printable(raw.replace(/\r\n|\n|\r/g, "↵").replace(/\t/g, " "));
}

/**
 * A cell as `fit(displayCell(cell), width, align)` draws it, reading only a prefix of the value bounded by
 * the width: a cell of 50 MB costs what a short one does.
 */
export function fitCell(cell: Cell, width: number, align: "left" | "right"): string {
  return fitCells(rawCellText(cell), width, align, { clean: cleanCellText });
}

export function isNumericColumn(result: Result, column: number): boolean {
  let hasValue = false;
  for (let i = 0; i < result.rows.length; i++) {
    const val = result.rows[i]?.[column] ?? null;
    if (val !== null) {
      if (typeof val !== "number") return false;
      hasValue = true;
    }
  }
  return hasValue;
}

export function columnWidths(result: Result, sampleRows = 200): number[] {
  const limit = Math.min(result.rows.length, Math.max(0, sampleRows));
  return result.columns.map((col, colIdx) => {
    let maxW = cappedWidth(col.name, printable);
    for (let r = 0; r < limit; r++) {
      const cell = result.rows[r]?.[colIdx] ?? null;
      const w = cappedWidth(rawCellText(cell), cleanCellText);
      if (w > maxW) {
        maxW = w;
        if (maxW >= MAX_COLUMN_WIDTH) break;
      }
    }
    return Math.max(1, Math.min(MAX_COLUMN_WIDTH, maxW));
  });
}

/** The drawn width of a text, read from a prefix bounded by the widest column (anything wider counts as wider). */
function cappedWidth(raw: string, clean: (text: string) => string): number {
  return cellWidth(cutCells(raw, MAX_COLUMN_WIDTH + 1, { clean }));
}

export function fit(text: string, width: number, align: "left" | "right"): string {
  return fitCells(text, width, align);
}

export interface Viewport {
  firstRow: number;
  rowCount: number;
  firstColumn: number;
  columns: number[];
}

export function viewport(input: {
  widths: number[];
  rows: number;
  cursor: { row: number; column: number };
  previous: { firstRow: number; firstColumn: number };
  width: number;
  height: number;
}): Viewport {
  const { widths, rows, cursor, previous, width, height } = input;
  const maxDataRows = Math.max(0, height - 1);
  const rowCount = Math.min(Math.max(0, rows), maxDataRows);

  let firstRow = previous.firstRow;
  if (rowCount === 0 || rows <= 0) {
    firstRow = 0;
  } else {
    const cursorRow = Math.max(0, Math.min(rows - 1, cursor.row));
    if (cursorRow < firstRow) {
      firstRow = cursorRow;
    } else if (cursorRow >= firstRow + rowCount) {
      firstRow = cursorRow - rowCount + 1;
    }
    firstRow = Math.max(0, Math.min(rows - rowCount, firstRow));
  }

  const colCount = widths.length;
  if (colCount === 0) {
    return { firstRow, rowCount, firstColumn: 0, columns: [] };
  }

  const cursorCol = Math.max(0, Math.min(colCount - 1, cursor.column));
  let firstColumn = Math.max(0, Math.min(colCount - 1, previous.firstColumn));
  if (cursorCol < firstColumn) {
    firstColumn = cursorCol;
  }

  const takeFrom = (start: number): number[] => {
    const cols: number[] = [];
    let used = 0;
    for (let i = start; i < colCount; i++) {
      const cost = widths[i]! + 1;
      if (cols.length > 0 && used + cost > width) {
        break;
      }
      if (cols.length === 0 && cost > width) {
        cols.push(i);
        break;
      }
      cols.push(i);
      used += cost;
    }
    return cols;
  };

  let columns = takeFrom(firstColumn);
  while (!columns.includes(cursorCol) && firstColumn < cursorCol) {
    firstColumn++;
    columns = takeFrom(firstColumn);
  }

  return {
    firstRow,
    rowCount,
    firstColumn,
    columns,
  };
}

export function searchCells(result: Result, pattern: string): { row: number; column: number }[] {
  if (pattern.length === 0) return [];
  const regex = compilePattern(pattern);
  const flags = regex.flags.replace("g", "");
  const tester = new RegExp(regex.source, flags);
  const matches: { row: number; column: number }[] = [];
  const colCount = result.columns.length;

  for (let r = 0; r < result.rows.length; r++) {
    const row = result.rows[r]!;
    for (let c = 0; c < colCount; c++) {
      const cell = row[c] ?? null;
      if (tester.test(displayCell(cell))) {
        matches.push({ row: r, column: c });
      }
    }
  }
  return matches;
}

export function recordFields(
  result: Result,
  row: number,
): { name: string; type: string; lines: string[]; json: boolean }[] {
  if (row < 0 || row >= result.rows.length) return [];
  const dataRow = result.rows[row]!;
  return result.columns.map((col, idx) => {
    const cell = dataRow[idx] ?? null;
    if (cell === null) {
      return { name: col.name, type: col.type, lines: [NULL_GLYPH], json: false };
    }
    if (typeof cell === "object") {
      const pretty = JSON.stringify(cell, null, 2);
      return { name: col.name, type: col.type, lines: pretty.split("\n"), json: true };
    }
    const text = String(cell);
    return {
      name: col.name,
      type: col.type,
      lines: text.split(/\r\n|\n|\r/),
      json: false,
    };
  });
}

export function rowsToJson(result: Result, rows: number[]): string {
  const keys = uniqueColumnNames(result.columns.map((c) => c.name));
  const objects = rows
    .filter((r) => r >= 0 && r < result.rows.length)
    .map((r) => rowToObject(result.columns, result.rows[r]!, keys));
  if (rows.length === 1) {
    return JSON.stringify(objects[0] ?? {}, null, 2);
  }
  return JSON.stringify(objects, null, 2);
}
