import { expect, test } from "bun:test";
import { fuzzyFilter, fuzzyScore } from "./fuzzy";

test("fuzzyScore", () => {
  expect(fuzzyScore("", "anything")).toBe(0);
  expect(fuzzyScore("xyz", "abc")).toBeNull();
  expect(fuzzyScore("ba", "ab")).toBeNull();
  expect(fuzzyScore("ORD", "orders")).not.toBeNull();
  expect(fuzzyScore("ord", "orders")!).toBeGreaterThan(fuzzyScore("ord", "border")!);
  expect(fuzzyScore("oi", "order_items")!).toBeGreaterThan(fuzzyScore("oi", "option")!);
  expect(fuzzyScore("ts", "theme switch")!).toBeGreaterThan(fuzzyScore("ts", "tests")!);
});

test("fuzzyFilter sorts by score, then by length, then keeps the original order", () => {
  const items = ["products", "orders", "order_items", "customers"];
  expect(fuzzyFilter("or", items, (x) => x)).toEqual(["orders", "order_items", "customers"]);
  expect(fuzzyFilter("", items, (x) => x)).toEqual(items);
  expect(fuzzyFilter("zzz", items, (x) => x)).toEqual([]);
  expect(fuzzyFilter("a", [{ n: "b" }, { n: "a" }], (x) => x.n)).toEqual([{ n: "a" }]);
});

test("fuzzyScore preserves UTF-16 positions on characters like İ and fuzzyFilter tie-breaks by original order", () => {
  expect(fuzzyScore("b", "İ_b")).toBe(fuzzyScore("b", "I_b"));
  expect(
    fuzzyFilter(
      "ab",
      [
        { k: "ab", i: 1 },
        { k: "ab", i: 2 },
      ],
      (x) => x.k,
    ),
  ).toEqual([
    { k: "ab", i: 1 },
    { k: "ab", i: 2 },
  ]);
});

