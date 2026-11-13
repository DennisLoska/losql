import { expect, test } from "bun:test";
import { spansByLine } from "./line-spans";

test("spans on one line keep their columns", () => {
  expect(spansByLine("select 1", [{ start: 0, end: 6, role: "keyword" }, { start: 7, end: 8, role: "number" }])).toEqual([
    { row: 0, start: 0, end: 6, role: "keyword" },
    { row: 0, start: 7, end: 8, role: "number" },
  ]);
});

test("columns are relative to the line", () => {
  expect(spansByLine("a\nfrom t", [{ start: 2, end: 6, role: "keyword" }])).toEqual([{ row: 1, start: 0, end: 4, role: "keyword" }]);
});

test("a span over several lines is split and empty pieces are dropped", () => {
  expect(spansByLine("/* a\n\nb */ x", [{ start: 0, end: 10, role: "comment" }])).toEqual([
    { row: 0, start: 0, end: 4, role: "comment" },
    { row: 2, start: 0, end: 4, role: "comment" },
  ]);
});

test("spans past the end are clipped", () => {
  expect(spansByLine("ab", [{ start: 1, end: 99, role: "string" }])).toEqual([{ row: 0, start: 1, end: 2, role: "string" }]);
  expect(spansByLine("", [{ start: 0, end: 5, role: "string" }])).toEqual([]);
});
