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

/** A column as a data grid draws it: its header name and the side its values line up on. */
export interface GridColumn {
  name: string;
  align?: "left" | "right";
}

/** The widest drawn text of each column (header included), sampled over the first rows; a `Result` fits. */
export function columnWidths(
  data: { columns: readonly GridColumn[]; rows: readonly Cell[][] },
  sampleRows = 200,
): number[] {
  const limit = Math.min(data.rows.length, Math.max(0, sampleRows));
  return data.columns.map((col, colIdx) => {
    let maxW = cappedWidth(col.name, printable);
    for (let r = 0; r < limit; r++) {
      const cell = data.rows[r]?.[colIdx] ?? null;
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

/** One drawn column: its value width and the padding cell drawn on each side of the value (0 or 1). */
export interface ViewportSlot {
  column: number;
  valueWidth: number;
  padding: 0 | 1;
}

export interface Viewport {
  firstRow: number;
  rowCount: number;
  firstColumn: number;
  columns: number[];
  /** The drawn columns, left to right; `columns` lists their indices. */
  slots: ViewportSlot[];
  /** Whether a rule row is drawn under the header (from height three on). */
  divider: boolean;
  /** Whether columns are hidden left of the first drawn one. */
  leftOverflow: boolean;
  /** Whether columns are hidden right of the last drawn one. */
  rightOverflow: boolean;
}

/** From this width on, the grid keeps one edge cell on each side for the overflow markers. */
export const EDGE_MIN_WIDTH = 8;

/**
 * Which rows and columns a grid of `width` x `height` cells draws. The header takes one row and, from
 * height three on, a rule row under it. From width eight on one edge cell is kept on each side; a slot
 * costs its value plus one padding cell each side, and one separator cell sits between neighbour slots.
 * Narrower grids draw only the cursor column. The scroll position moves only as far as the cursor needs.
 */
export function viewport(input: {
  widths: number[];
  rows: number;
  cursor: { row: number; column: number };
  previous: { firstRow: number; firstColumn: number };
  width: number;
  height: number;
}): Viewport {
  const { widths, rows, cursor, previous, width, height } = input;
  const divider = height >= 3;
  const maxDataRows = divider ? height - 2 : Math.max(0, height - 1);
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
  const rowPart = { firstRow, rowCount, divider };
  if (colCount === 0 || width <= 0) {
    return { ...rowPart, firstColumn: 0, columns: [], slots: [], leftOverflow: false, rightOverflow: false };
  }

  const cursorCol = Math.max(0, Math.min(colCount - 1, cursor.column));

  if (width < EDGE_MIN_WIDTH) {
    const padding = width >= 3 ? 1 : 0;
    return {
      ...rowPart,
      firstColumn: cursorCol,
      columns: [cursorCol],
      slots: [{ column: cursorCol, valueWidth: width - 2 * padding, padding }],
      leftOverflow: cursorCol > 0,
      rightOverflow: cursorCol < colCount - 1,
    };
  }

  const usable = width - 2;
  const takeFrom = (start: number): ViewportSlot[] => {
    const slots: ViewportSlot[] = [];
    let used = 0;
    for (let i = start; i < colCount; i++) {
      const valueWidth = widths[i]!;
      if (slots.length === 0) {
        if (valueWidth + 2 > usable) {
          slots.push({ column: i, valueWidth: Math.max(1, usable - 2), padding: 1 });
          break;
        }
        slots.push({ column: i, valueWidth, padding: 1 });
        used = valueWidth + 2;
        continue;
      }
      const cost = valueWidth + 3;
      if (used + cost > usable) break;
      slots.push({ column: i, valueWidth, padding: 1 });
      used += cost;
    }
    return slots;
  };

  let firstColumn = Math.max(0, Math.min(colCount - 1, previous.firstColumn));
  if (cursorCol < firstColumn) firstColumn = cursorCol;
  let slots = takeFrom(firstColumn);
  while (!slots.some((slot) => slot.column === cursorCol) && firstColumn < cursorCol) {
    firstColumn++;
    slots = takeFrom(firstColumn);
  }
  const lastColumn = slots[slots.length - 1]?.column ?? firstColumn;

  return {
    ...rowPart,
    firstColumn,
    columns: slots.map((slot) => slot.column),
    slots,
    leftOverflow: firstColumn > 0,
    rightOverflow: lastColumn < colCount - 1,
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
