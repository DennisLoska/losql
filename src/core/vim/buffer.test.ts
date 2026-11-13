import { expect, test } from "bun:test";
import { comparePositions, MemoryBuffer, offsetToPosition, positionToOffset } from "./buffer";

test("lines and text", () => {
  const b = new MemoryBuffer("ab\ncd");
  expect(b.lineCount()).toBe(2);
  expect(b.line(1)).toBe("cd");
  expect(b.text()).toBe("ab\ncd");
  expect(new MemoryBuffer().lineCount()).toBe(1);
  expect(new MemoryBuffer("").line(0)).toBe("");
});

test("replace within and across lines", () => {
  const b = new MemoryBuffer("ab\ncd");
  b.replace({ start: { row: 0, col: 1 }, end: { row: 1, col: 1 } }, "X\nY");
  expect(b.text()).toBe("aX\nYd");
  b.replace({ start: { row: 0, col: 0 }, end: { row: 0, col: 0 } }, ">");
  expect(b.text()).toBe(">aX\nYd");
  b.replace({ start: { row: 0, col: 0 }, end: { row: 1, col: 2 } }, "");
  expect(b.text()).toBe("");
});

test("the cursor is clamped to the text", () => {
  const b = new MemoryBuffer("ab\ncd");
  b.setCursor({ row: 9, col: 9 });
  expect(b.cursor()).toEqual({ row: 1, col: 2 });
  b.setCursor({ row: -1, col: -1 });
  expect(b.cursor()).toEqual({ row: 0, col: 0 });
});

test("selection is recorded", () => {
  const b = new MemoryBuffer("abc");
  const range = { start: { row: 0, col: 0 }, end: { row: 0, col: 2 } };
  b.setSelection(range, false);
  expect(b.selection).toEqual({ range, linewise: false });
  b.setSelection(null);
  expect(b.selection).toBeNull();
});

test("positions and offsets", () => {
  const b = new MemoryBuffer("ab\ncd\n");
  expect(positionToOffset(b, { row: 1, col: 1 })).toBe(4);
  expect(offsetToPosition(b, 4)).toEqual({ row: 1, col: 1 });
  expect(offsetToPosition(b, 2)).toEqual({ row: 0, col: 2 });
  expect(offsetToPosition(b, 999)).toEqual({ row: 2, col: 0 });
  expect(comparePositions({ row: 0, col: 5 }, { row: 1, col: 0 })).toBeLessThan(0);
  expect(comparePositions({ row: 1, col: 1 }, { row: 1, col: 1 })).toBe(0);
});
