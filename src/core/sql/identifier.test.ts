import { expect, test } from "bun:test";
import { quoteIdentifier } from "./identifier";

test("identifiers are quoted only when needed", () => {
  expect(quoteIdentifier("users")).toBe("users");
  expect(quoteIdentifier("order_items2")).toBe("order_items2");
  expect(quoteIdentifier("Order Items")).toBe('"Order Items"');
  expect(quoteIdentifier("Users")).toBe('"Users"');
  expect(quoteIdentifier("order")).toBe('"order"');
  expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
  expect(quoteIdentifier("2fast")).toBe('"2fast"');
});

test("quoteIdentifier quotes reserved words, upper-case names, spaces and quotes", () => {
  expect(quoteIdentifier("user")).toBe('"user"');
  expect(quoteIdentifier("both")).toBe('"both"');
  expect(quoteIdentifier("case")).toBe('"case"');
  expect(quoteIdentifier("Users")).toBe('"Users"');
  expect(quoteIdentifier("order items")).toBe('"order items"');
  expect(quoteIdentifier("Created At")).toBe('"Created At"');
  expect(quoteIdentifier('a"b')).toBe('"a""b"');
  expect(quoteIdentifier("id")).toBe("id");
  expect(quoteIdentifier("customers")).toBe("customers");
});
