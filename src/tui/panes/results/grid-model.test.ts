import { describe, expect, test } from "bun:test";
import type { Result } from "../../../core/db/types";
import {
  columnWidths, displayCell, fit, isNumericColumn, recordFields, rowsToJson, searchCells, viewport,
} from "./grid-model";

const result: Result = {
  columns: [{ name: "id", type: "integer" }, { name: "name", type: "text" }, { name: "meta", type: "json" }, { name: "note", type: "text" }],
  rows: [
    [1, "Ada", { a: [1, 2] }, null],
    [2, "Linus", null, "two\nlines"],
    [30, "grace hopper", [true], "x".repeat(80)],
  ],
  truncated: false, affected: null, command: "SELECT", durationMs: 1,
};

test("displayCell", () => {
  expect(displayCell(null)).toBe("∅");
  expect(displayCell(true)).toBe("true");
  expect(displayCell(1.5)).toBe("1.5");
  expect(displayCell("two\nlines")).toBe("two↵lines");
  expect(displayCell({ a: [1, 2] })).toBe('{"a":[1,2]}');
  expect(displayCell("")).toBe("");
});

test("isNumericColumn", () => {
  expect(isNumericColumn(result, 0)).toBe(true);
  expect(isNumericColumn(result, 1)).toBe(false);
  expect(isNumericColumn({ ...result, rows: [[null, "a", null, null]] }, 0)).toBe(false);
  const rows300ThenText = [
    ...Array.from({ length: 300 }, (_, i) => [i + 1, "a", null, null]),
    ["not-a-number", "a", null, null],
  ];
  expect(isNumericColumn({ ...result, rows: rows300ThenText }, 0)).toBe(false);
});

test("columnWidths fit header and content up to the maximum", () => {
  expect(columnWidths(result)).toEqual([2, 12, 11, 40]);
  expect(columnWidths({ ...result, rows: [] })).toEqual([2, 4, 4, 4]);
  expect(columnWidths(result, 1)).toEqual([2, 4, 11, 4]);
});

test("fit pads and cuts", () => {
  expect(fit("ab", 5, "left")).toBe("ab   ");
  expect(fit("ab", 5, "right")).toBe("   ab");
  expect(fit("abcdefgh", 5, "left")).toBe("abcd…");
  expect(fit("abcdefgh", 5, "right")).toBe("abcd…");
  expect(fit("abc", 3, "left")).toBe("abc");
  expect(fit("abc", 0, "left")).toBe("");
});

test("fit cuts between grapheme clusters and always draws to the exact width", () => {
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const clustersOf = (s: string) => Array.from(seg.segment(s), (x) => x.segment);
  const samples = [
    "👍🏽",
    "1️⃣",
    "🇩🇪",
    "👨‍👩‍👧",
    "e\u0301",
    "日本語",
    "plain-ascii_123",
    "a👍🏽1️⃣🇩🇪👨‍👩‍👧e\u0301日b",
  ];
  const widths = [1, 2, 3, 10, 40];
  const aligns: ("left" | "right")[] = ["left", "right"];

  for (const sample of samples) {
    const repeated = sample.repeat(45);
    const inputClusters = clustersOf(repeated);
    for (const width of widths) {
      for (const align of aligns) {
        const out = fit(repeated, width, align);
        expect(Bun.stringWidth(out)).toBe(width);
        // Since repeated has width > 40, out must be cut with "…" and trailing spaces
        const ellipsisIdx = out.indexOf("…");
        expect(ellipsisIdx).toBeGreaterThanOrEqual(0);
        const prefix = out.slice(0, ellipsisIdx);
        const suffix = out.slice(ellipsisIdx + 1);
        expect(suffix).toBe(" ".repeat(suffix.length));
        const prefixClusters = clustersOf(prefix);
        expect(prefixClusters).toEqual(inputClusters.slice(0, prefixClusters.length));
        expect(prefix).toBe(inputClusters.slice(0, prefixClusters.length).join(""));
      }
    }
    // Also test when shorter than width (padding left and right)
    const short = sample;
    for (const align of aligns) {
      const out = fit(short, 40, align);
      expect(Bun.stringWidth(out)).toBe(40);
      expect(out.trim()).toBe(short);
    }
  }
});

describe("viewport", () => {
  const widths = [10, 10, 10, 10, 10];
  const base = { widths, rows: 100, previous: { firstRow: 0, firstColumn: 0 } };

  test("everything fits", () => {
    expect(viewport({ ...base, rows: 3, cursor: { row: 0, column: 0 }, width: 80, height: 10 })).toEqual({
      firstRow: 0, rowCount: 3, firstColumn: 0, columns: [0, 1, 2, 3, 4],
    });
  });

  test("the header takes one row and each column one separator cell", () => {
    const v = viewport({ ...base, cursor: { row: 0, column: 0 }, width: 33, height: 10 });
    expect(v.rowCount).toBe(9);
    expect(v.columns).toEqual([0, 1, 2]);
  });

  test("scrolls down and right only as far as needed to show the cursor", () => {
    expect(viewport({ ...base, cursor: { row: 9, column: 0 }, width: 80, height: 10 }).firstRow).toBe(1);
    expect(viewport({ ...base, cursor: { row: 50, column: 0 }, width: 80, height: 10 }).firstRow).toBe(42);
    const right = viewport({ ...base, cursor: { row: 0, column: 4 }, width: 33, height: 10 });
    expect(right.firstColumn).toBe(2);
    expect(right.columns).toEqual([2, 3, 4]);
  });

  test("keeps the previous scroll position when the cursor is still visible", () => {
    const v = viewport({ ...base, previous: { firstRow: 40, firstColumn: 2 }, cursor: { row: 45, column: 3 }, width: 33, height: 10 });
    expect([v.firstRow, v.firstColumn]).toEqual([40, 2]);
  });

  test("scrolls back up and left", () => {
    const v = viewport({ ...base, previous: { firstRow: 40, firstColumn: 2 }, cursor: { row: 10, column: 0 }, width: 33, height: 10 });
    expect([v.firstRow, v.firstColumn]).toEqual([10, 0]);
  });

  test("a column wider than the Pane is still shown", () => {
    expect(viewport({ widths: [40, 5], rows: 1, cursor: { row: 0, column: 0 }, previous: { firstRow: 0, firstColumn: 0 }, width: 20, height: 5 }).columns).toEqual([0]);
  });

  test("no rows", () => {
    expect(viewport({ ...base, rows: 0, cursor: { row: 0, column: 0 }, width: 80, height: 10 }).rowCount).toBe(0);
  });
});

test("searchCells finds cells in reading order with smart case", () => {
  expect(searchCells(result, "a")).toEqual([
    { row: 0, column: 1 }, { row: 0, column: 2 }, { row: 2, column: 1 },
  ]);
  expect(searchCells(result, "Ada")).toEqual([{ row: 0, column: 1 }]);
  expect(searchCells(result, "^\\d+$")).toEqual([{ row: 0, column: 0 }, { row: 1, column: 0 }, { row: 2, column: 0 }]);
  expect(searchCells(result, "(")).toEqual([]);
  expect(searchCells(result, "")).toEqual([]);
});

test("recordFields pretty-prints JSON values", () => {
  const fields = recordFields(result, 0);
  expect(fields.map((f) => f.name)).toEqual(["id", "name", "meta", "note"]);
  expect(fields[0]).toEqual({ name: "id", type: "integer", lines: ["1"], json: false });
  expect(fields[2]).toEqual({ name: "meta", type: "json", lines: ["{", '  "a": [', "    1,", "    2", "  ]", "}"], json: true });
  expect(fields[3]!.lines).toEqual(["∅"]);
  expect(recordFields(result, 1)[3]!.lines).toEqual(["two", "lines"]);
  expect(recordFields(result, 99)).toEqual([]);
});

test("rowsToJson", () => {
  expect(JSON.parse(rowsToJson(result, [1]))).toEqual({ id: 2, name: "Linus", meta: null, note: "two\nlines" });
  expect(JSON.parse(rowsToJson(result, [0, 1])).map((r: { id: number }) => r.id)).toEqual([1, 2]);
  expect(rowsToJson(result, [1]).startsWith('{\n  "id": 2,')).toBe(true);
});
