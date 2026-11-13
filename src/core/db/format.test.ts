import { expect, test } from "bun:test";
import { cellText, resultToCsv, resultToJson, resultToTable, rowToObject } from "./format";
import type { Result } from "./types";

const result: Result = {
  columns: [{ name: "id", type: "integer" }, { name: "name", type: "text" }, { name: "meta", type: "json" }],
  rows: [[1, "Ada", { a: 1 }], [2, 'Li"nus, jr', null]],
  truncated: false, affected: null, command: "SELECT", durationMs: 1,
};

test("cellText", () => {
  expect(cellText(null)).toBe("NULL");
  expect(cellText(true)).toBe("true");
  expect(cellText(1.5)).toBe("1.5");
  expect(cellText("x")).toBe("x");
  expect(cellText({ a: [1, 2] })).toBe('{"a":[1,2]}');
});

test("rowToObject suffixes duplicate column names", () => {
  expect(rowToObject([{ name: "id", type: "" }, { name: "id", type: "" }, { name: "id", type: "" }], [1, 2, 3]))
    .toEqual({ id: 1, id_2: 2, id_3: 3 });
});

test("rowToObject avoids collisions when a suffixed name already exists later", () => {
  expect(rowToObject([{ name: "a", type: "" }, { name: "a", type: "" }, { name: "a_2", type: "" }], [1, 2, 3]))
    .toEqual({ a: 1, a_3: 2, a_2: 3 });
  expect(rowToObject([{ name: "a", type: "" }, { name: "a_2", type: "" }, { name: "a", type: "" }], [1, 2, 3]))
    .toEqual({ a: 1, a_2: 2, a_3: 3 });
});

test("rowToObject, resultToJson, resultToCsv and resultToTable preserve __proto__, constructor, and toString", () => {
  const protoResult: Result = {
    columns: [
      { name: "__proto__", type: "int4" },
      { name: "constructor", type: "int4" },
      { name: "toString", type: "int4" },
    ],
    rows: [[1, 2, 3]],
    truncated: false,
    affected: null,
    command: "SELECT",
    durationMs: 1,
  };
  const obj = rowToObject(protoResult.columns, protoResult.rows[0]!);
  expect(Object.keys(obj)).toEqual(["__proto__", "constructor", "toString"]);
  expect(Object.getOwnPropertyDescriptor(obj, "__proto__")?.value).toBe(1);
  expect(obj["constructor"]).toBe(2);
  expect(obj["toString"]).toBe(3);

  const json = resultToJson(protoResult);
  expect(json).toContain('"__proto__": 1');
  expect(json).toContain('"constructor": 2');
  expect(json).toContain('"toString": 3');

  const csv = resultToCsv(protoResult);
  expect(csv).toBe("__proto__,constructor,toString\n1,2,3\n");

  const table = resultToTable(protoResult);
  expect(table).toContain("__proto__");
  expect(table).toContain("constructor");
  expect(table).toContain("toString");
});

test("resultToJson is an array of objects with two-space indentation", () => {
  expect(JSON.parse(resultToJson(result))).toEqual([
    { id: 1, name: "Ada", meta: { a: 1 } },
    { id: 2, name: 'Li"nus, jr', meta: null },
  ]);
  expect(resultToJson(result).startsWith('[\n  {\n    "id": 1,')).toBe(true);
});

test("resultToCsv quotes where needed and leaves NULL empty", () => {
  expect(resultToCsv(result)).toBe('id,name,meta\n1,Ada,"{""a"":1}"\n2,"Li""nus, jr",\n');
});

test("resultToTable aligns columns and right-aligns numbers", () => {
  expect(resultToTable(result)).toBe(
    [
      " id | name       | meta    ",
      "----+------------+---------",
      "  1 | Ada        | {\"a\":1} ",
      "  2 | Li\"nus, jr | NULL    ",
      "(2 rows)",
      "",
    ].join("\n"),
  );
});

test("resultToTable for a statement without rows", () => {
  expect(resultToTable({ columns: [], rows: [], truncated: false, affected: 3, command: "UPDATE", durationMs: 1 })).toBe("UPDATE 3\n");
});

test("resultToTable notes truncation", () => {
  expect(resultToTable({ ...result, truncated: true })).toContain("(2 rows, more available)");
});

test("resultToTable escapes control characters and aligns wide characters using Bun.stringWidth", () => {
  const complexResult: Result = {
    columns: [
      { name: "head\ner", type: "text" },
      { name: "wide", type: "text" },
      { name: "ctrl", type: "text" },
    ],
    rows: [
      ["a\nb\rc\td", "日本語", "\x1b[31mred\x7f\x80\x9f"],
      ["ascii", "abc", "\x00\x1f"],
    ],
    truncated: false,
    affected: null,
    command: "SELECT",
    durationMs: 1,
  };

  const table = resultToTable(complexResult);
  expect(table).not.toContain("\x1b");
  expect(table).not.toContain("\x7f");
  expect(table).toContain("head\\ner");
  expect(table).toContain("a\\nb\\rc\\td");
  expect(table).toContain("\\x1b[31mred\\x7f\\x80\\x9f");
  expect(table).toContain("\\x00\\x1f");

  const lines = table.trimEnd().split("\n");
  // Header, rule, and 2 body rows should all have the exact same display width
  const tableLines = lines.slice(0, 4);
  const widths = tableLines.map((l) => Bun.stringWidth(l));
  expect(new Set(widths).size).toBe(1);

  const json = resultToJson(complexResult);
  expect(JSON.parse(json)[0]["head\ner"]).toBe("a\nb\rc\td");
});

test("resultToJson computes column keys once per Result and handles 1,600 identical names over 1,000 rows within 1 second", () => {
  const small: Result = {
    columns: [{ name: "a", type: "int4" }, { name: "a", type: "int4" }, { name: "a_2", type: "int4" }],
    rows: [[1, 2, 3], [4, 5, 6]],
    truncated: false,
    affected: null,
    command: "SELECT",
    durationMs: 1,
  };
  expect(JSON.parse(resultToJson(small))).toEqual([
    { a: 1, a_3: 2, a_2: 3 },
    { a: 4, a_3: 5, a_2: 6 },
  ]);

  const colCount = 1600;
  const rowCount = 1000;
  const columns = Array.from({ length: colCount }, () => ({ name: "x", type: "int4" }));
  const row = Array.from({ length: colCount }, (_, i) => i);
  const rows = Array.from({ length: rowCount }, () => row);

  const t0 = performance.now();
  const json = resultToJson({
    columns,
    rows,
    truncated: false,
    affected: null,
    command: "SELECT",
    durationMs: 1,
  });
  const elapsedMs = performance.now() - t0;

  expect(elapsedMs).toBeLessThan(1000);
  const parsed = JSON.parse(json);
  expect(parsed.length).toBe(rowCount);
  expect(parsed[0].x).toBe(0);
  expect(parsed[0].x_2).toBe(1);
  expect(parsed[0].x_1600).toBe(1599);
}, 2000);

