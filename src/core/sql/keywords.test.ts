import { expect, test } from "bun:test";
import { isReservedWord } from "./keywords";

const TWENTY_ONE_PG_WORDS = [
  "user",
  "current_schema",
  "current_role",
  "current_catalog",
  "localtime",
  "localtimestamp",
  "system_user",
  "both",
  "leading",
  "trailing",
  "binary",
  "freeze",
  "collation",
  "array",
  "asymmetric",
  "symmetric",
  "authorization",
  "overlaps",
  "placing",
  "tablesample",
  "variadic",
];

test("isReservedWord returns true for the 21 Postgres reserved/type words", () => {
  for (const w of TWENTY_ONE_PG_WORDS) {
    expect(isReservedWord(w)).toBe(true);
  }
});

test("isReservedWord is case-insensitive and covers SQLite/Postgres reserved words", () => {
  expect(isReservedWord("select")).toBe(true);
  expect(isReservedWord("order")).toBe(true);
  expect(isReservedWord("USER")).toBe(true);
  expect(isReservedWord("SELECT")).toBe(true);
  expect(isReservedWord("Order")).toBe(true);
  // SQLite-only documented keywords
  expect(isReservedWord("autoincrement")).toBe(true);
  expect(isReservedWord("pragma")).toBe(true);
  expect(isReservedWord("rowid")).toBe(false);
});

test("isReservedWord returns false for regular identifiers", () => {
  expect(isReservedWord("customers")).toBe(false);
  expect(isReservedWord("id")).toBe(false);
  expect(isReservedWord("name")).toBe(false);
});
