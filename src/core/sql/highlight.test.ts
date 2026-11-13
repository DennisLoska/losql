import { expect, test } from "bun:test";
import { highlightJson, highlightSql } from "./highlight";

test("highlightSql maps token kinds to roles and skips whitespace", () => {
  const sql = "select name, 'x', 1, $1, \"Q\" from t -- c";
  expect(highlightSql(sql).map((s) => [s.role, sql.slice(s.start, s.end)])).toEqual([
    ["keyword", "select"], ["text", "name"], ["punctuation", ","], ["string", "'x'"], ["punctuation", ","],
    ["number", "1"], ["punctuation", ","], ["variable", "$1"], ["punctuation", ","], ["variable", '"Q"'],
    ["keyword", "from"], ["text", "t"], ["comment", "-- c"],
  ]);
});

test("highlightSql: functions, types and operators", () => {
  const sql = "count(*)::int";
  expect(highlightSql(sql).map((s) => [s.role, sql.slice(s.start, s.end)])).toEqual([
    ["function", "count"], ["punctuation", "("], ["operator", "*"], ["punctuation", ")"], ["operator", "::"], ["type", "int"],
  ]);
});

test("highlightJson roles", () => {
  const json = '{"k": "v", "n": 1, "b": true, "z": null}';
  expect(highlightJson(json).map((s) => [s.role, json.slice(s.start, s.end)])).toEqual([
    ["punctuation", "{"], ["type", '"k"'], ["punctuation", ":"], ["string", '"v"'], ["punctuation", ","],
    ["type", '"n"'], ["punctuation", ":"], ["number", "1"], ["punctuation", ","],
    ["type", '"b"'], ["punctuation", ":"], ["keyword", "true"], ["punctuation", ","],
    ["type", '"z"'], ["punctuation", ":"], ["keyword", "null"], ["punctuation", "}"],
  ]);
});
