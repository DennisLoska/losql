import { buildRowObject, uniqueColumnNames } from "./cells";
import type { Cell, Column, Result } from "./types";

export function cellText(cell: Cell): string {
  if (cell === null) return "NULL";
  if (typeof cell === "object") return JSON.stringify(cell);
  return String(cell);
}

export function rowToObject(
  columns: Column[],
  row: Cell[],
  keys?: readonly string[],
): Record<string, Cell> {
  return buildRowObject(columns, row, keys);
}

export function resultToJson(result: Result): string {
  const keys = uniqueColumnNames(result.columns.map((c) => c.name));
  const objects = result.rows.map((row) => rowToObject(result.columns, row, keys));
  return JSON.stringify(objects, null, 2);
}

function escapeCsvField(field: string): string {
  if (field.includes('"') || field.includes(",") || field.includes("\n") || field.includes("\r")) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

export function resultToCsv(result: Result): string {
  const header = result.columns.map((c) => escapeCsvField(c.name)).join(",") + "\n";
  const lines = result.rows.map((row) => {
    const fields = result.columns.map((_, i) => {
      const cell = row[i] ?? null;
      if (cell === null) return "";
      return escapeCsvField(cellText(cell));
    });
    return fields.join(",") + "\n";
  });
  return header + lines.join("");
}

function escapeTableText(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0a) {
      out += "\\n";
    } else if (code === 0x0d) {
      out += "\\r";
    } else if (code === 0x09) {
      out += "\\t";
    } else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    } else {
      out += text[i];
    }
  }
  return out;
}

function padDisplay(text: string, targetWidth: number, right: boolean): string {
  const w = Bun.stringWidth(text);
  const diff = Math.max(0, targetWidth - w);
  const spaces = " ".repeat(diff);
  return right ? spaces + text : text + spaces;
}

export function resultToTable(result: Result): string {
  if (result.columns.length === 0) {
    return `${result.command} ${result.affected ?? 0}\n`;
  }

  const escapedHeaders = result.columns.map((col) => escapeTableText(col.name));
  const formattedRows = result.rows.map((row) =>
    result.columns.map((_, i) => escapeTableText(cellText(row[i] ?? null))),
  );

  const widths = escapedHeaders.map((hdr, i) => {
    let max = Bun.stringWidth(hdr);
    for (const row of formattedRows) {
      const len = Bun.stringWidth(row[i]!);
      if (len > max) max = len;
    }
    return max;
  });

  const rightAlign = result.columns.map((_, i) => {
    let hasNonNull = false;
    for (const row of result.rows) {
      const val = row[i] ?? null;
      if (val !== null) {
        hasNonNull = true;
        if (typeof val !== "number") return false;
      }
    }
    return hasNonNull;
  });

  const headerCells = escapedHeaders.map(
    (hdr, i) => ` ${padDisplay(hdr, widths[i]!, false)} `,
  );
  const ruleCells = widths.map((w) => "-".repeat(w + 2));

  const bodyLines = formattedRows.map((row) => {
    const cells = row.map((text, i) => {
      const w = widths[i]!;
      const padded = padDisplay(text, w, Boolean(rightAlign[i]));
      return ` ${padded} `;
    });
    return cells.join("|");
  });

  const rowCount = result.rows.length;
  const rowWord = rowCount === 1 ? "row" : "rows";
  const footer = result.truncated
    ? `(${rowCount} ${rowWord}, more available)`
    : `(${rowCount} ${rowWord})`;

  return [headerCells.join("|"), ruleCells.join("+"), ...bodyLines, footer, ""].join("\n");
}
