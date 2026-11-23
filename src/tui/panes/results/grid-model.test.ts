import { describe, expect, test } from "bun:test";
import type { Result } from "../../../core/db/types";
import {
  columnWidths, displayCell, fit, type GridColumn, isNumericColumn, recordFields, rowsToJson, searchCells,
  type Viewport, viewport,
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

test("columnWidths reads a plain grid of columns and rows, not only a Result", () => {
  const columns: GridColumn[] = [{ name: "a" }, { name: "wide", align: "right" }];
  expect(columnWidths({ columns, rows: [[1, "xy"]] })).toEqual([1, 4]);
  expect(columnWidths({ columns, rows: [[1, "xy"]] }, 0)).toEqual([1, 4]);
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
  /** The cells a viewport draws: every slot, one separator between slots, and the two edge cells when they exist. */
  const drawn = (vp: Viewport, width: number) =>
    vp.slots.reduce((n, slot) => n + slot.valueWidth + 2 * slot.padding, 0) +
    Math.max(0, vp.slots.length - 1) +
    (width >= 8 ? 2 : 0);

  test("everything fits", () => {
    const vp = viewport({ ...base, rows: 3, cursor: { row: 0, column: 0 }, width: 80, height: 10 });
    expect(vp.firstRow).toBe(0);
    expect(vp.rowCount).toBe(3);
    expect(vp.firstColumn).toBe(0);
    expect(vp.columns).toEqual([0, 1, 2, 3, 4]);
    expect(vp.slots).toEqual(widths.map((valueWidth, column) => ({ column, valueWidth, padding: 1 })));
    expect(vp.divider).toBe(true);
    expect(vp.leftOverflow).toBe(false);
    expect(vp.rightOverflow).toBe(false);
  });

  test("the header and its divider take two rows", () => {
    const vp = viewport({ ...base, cursor: { row: 0, column: 0 }, width: 33, height: 10 });
    expect(vp.rowCount).toBe(8);
    expect(vp.divider).toBe(true);
    // 1 edge cell + (10 + 2) + 1 separator + (10 + 2) + 1 edge cell = 27 cells, so two columns fit
    expect(vp.columns).toEqual([0, 1]);
    expect(vp.slots).toEqual([
      { column: 0, valueWidth: 10, padding: 1 },
      { column: 1, valueWidth: 10, padding: 1 },
    ]);
  });

  test("a slot charges its value, one padding cell each side and one separator between slots", () => {
    const vp = viewport({ ...base, rows: 1, cursor: { row: 0, column: 0 }, width: 66, height: 10 });
    // 5 * (10 + 2) + 4 separators + 2 edge cells = 66: an exact fit
    expect(vp.slots).toEqual(widths.map((valueWidth, column) => ({ column, valueWidth, padding: 1 })));
    expect(drawn(vp, 66)).toBe(66);
  });

  test("one cell narrower drops the last column", () => {
    const vp = viewport({ ...base, rows: 1, cursor: { row: 0, column: 0 }, width: 65, height: 10 });
    expect(vp.columns).toEqual([0, 1, 2, 3]);
    expect(vp.rightOverflow).toBe(true);
    expect(drawn(vp, 65)).toBeLessThanOrEqual(65);
  });

  test("scrolls down and right only as far as needed to show the cursor", () => {
    expect(viewport({ ...base, cursor: { row: 9, column: 0 }, width: 80, height: 10 }).firstRow).toBe(2);
    expect(viewport({ ...base, cursor: { row: 50, column: 0 }, width: 80, height: 10 }).firstRow).toBe(43);
    const right = viewport({ ...base, cursor: { row: 0, column: 4 }, width: 33, height: 10 });
    expect(right.firstColumn).toBe(3);
    expect(right.columns).toEqual([3, 4]);
    expect(right.leftOverflow).toBe(true);
    expect(right.rightOverflow).toBe(false);
  });

  test("keeps the previous scroll position when the cursor is still visible", () => {
    const vp = viewport({ ...base, previous: { firstRow: 40, firstColumn: 2 }, cursor: { row: 45, column: 3 }, width: 33, height: 10 });
    expect([vp.firstRow, vp.firstColumn]).toEqual([40, 2]);
    expect(vp.columns).toEqual([2, 3]);
  });

  test("scrolls back up and left", () => {
    const vp = viewport({ ...base, previous: { firstRow: 40, firstColumn: 2 }, cursor: { row: 10, column: 0 }, width: 33, height: 10 });
    expect([vp.firstRow, vp.firstColumn]).toEqual([10, 0]);
    expect(vp.columns).toEqual([0, 1]);
    expect(vp.leftOverflow).toBe(false);
    expect(vp.rightOverflow).toBe(true);
  });

  test("a column wider than the viewport is clamped to the usable width", () => {
    const vp = viewport({ widths: [40, 5], rows: 1, cursor: { row: 0, column: 0 }, previous: { firstRow: 0, firstColumn: 0 }, width: 20, height: 5 });
    // 1 edge + 1 padding + value + 1 padding + 1 edge = 20, so the value is drawn 16 cells wide
    expect(vp.slots).toEqual([{ column: 0, valueWidth: 16, padding: 1 }]);
    expect(vp.columns).toEqual([0]);
    expect(vp.leftOverflow).toBe(false);
    expect(vp.rightOverflow).toBe(true);
    expect(drawn(vp, 20)).toBe(20);
  });

  test("widths below eight drop the edges and show only the cursor column", () => {
    const at = (width: number, column = 0) =>
      viewport({ widths: [10, 10], rows: 1, cursor: { row: 0, column }, previous: { firstRow: 0, firstColumn: 0 }, width, height: 5 });
    expect(at(0)).toMatchObject({ slots: [], columns: [], leftOverflow: false, rightOverflow: false });
    expect(at(1).slots).toEqual([{ column: 0, valueWidth: 1, padding: 0 }]);
    expect(at(2).slots).toEqual([{ column: 0, valueWidth: 2, padding: 0 }]);
    expect(at(3).slots).toEqual([{ column: 0, valueWidth: 1, padding: 1 }]);
    expect(at(7).slots).toEqual([{ column: 0, valueWidth: 5, padding: 1 }]);
    expect(at(7, 1)).toMatchObject({
      slots: [{ column: 1, valueWidth: 5, padding: 1 }],
      columns: [1],
      firstColumn: 1,
      leftOverflow: true,
      rightOverflow: false,
    });
    for (const width of [1, 2, 3, 7]) expect(drawn(at(width), width)).toBeLessThanOrEqual(width);
  });

  test("width eight reserves the two edge cells", () => {
    const vp = viewport({ widths: [10, 10], rows: 1, cursor: { row: 0, column: 0 }, previous: { firstRow: 0, firstColumn: 0 }, width: 8, height: 5 });
    expect(vp.slots).toEqual([{ column: 0, valueWidth: 4, padding: 1 }]);
    expect(vp.columns).toEqual([0]);
    expect(vp.rightOverflow).toBe(true);
    expect(drawn(vp, 8)).toBe(8);
  });

  test("the divider row only exists from height three on", () => {
    const at = (height: number) =>
      viewport({ widths: [4], rows: 10, cursor: { row: 0, column: 0 }, previous: { firstRow: 0, firstColumn: 0 }, width: 20, height });
    expect(at(0)).toMatchObject({ divider: false, rowCount: 0 });
    expect(at(1)).toMatchObject({ divider: false, rowCount: 0 });
    expect(at(2)).toMatchObject({ divider: false, rowCount: 1 });
    expect(at(3)).toMatchObject({ divider: true, rowCount: 1 });
    expect(at(10)).toMatchObject({ divider: true, rowCount: 8 });
  });

  test("slots never draw past the width, wide Unicode values included", () => {
    const columns: GridColumn[] = [{ name: "日本語" }, { name: "👍🏽" }, { name: "note" }];
    const rows = [["👨‍👩‍👧‍👦", "🇩🇪", "1️⃣"], ["e\u0301", "日本語", "plain"]];
    const colWidths = columnWidths({ columns, rows });
    for (let width = 0; width <= 40; width++) {
      for (const column of [0, 1, 2]) {
        const vp = viewport({
          widths: colWidths,
          rows: rows.length,
          cursor: { row: 0, column },
          previous: { firstRow: 0, firstColumn: 0 },
          width,
          height: 6,
        });
        if (width === 0) {
          expect(vp).toMatchObject({ slots: [], columns: [], leftOverflow: false, rightOverflow: false });
          continue;
        }
        expect(drawn(vp, width)).toBeLessThanOrEqual(width);
        expect(vp.slots.map((slot) => slot.column)).toEqual(vp.columns);
        for (const slot of vp.slots) {
          expect(slot.valueWidth).toBeGreaterThanOrEqual(1);
          expect([0, 1]).toContain(slot.padding);
        }
        expect(vp.slots.map((slot) => slot.column)).toContain(column);
      }
    }
  });

  test("no rows", () => {
    const vp = viewport({ ...base, rows: 0, cursor: { row: 0, column: 0 }, width: 80, height: 10 });
    expect(vp.rowCount).toBe(0);
    expect(vp.firstRow).toBe(0);
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
