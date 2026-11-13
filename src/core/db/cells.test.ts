import { describe, expect, test } from "bun:test";
import { defineOwnProperty, normalizeSharedCell, uniqueColumnNames } from "./cells";

describe("cells", () => {
  test("defineOwnProperty safely sets __proto__, constructor, and toString as own enumerable properties", () => {
    const obj: Record<string, unknown> = {};
    defineOwnProperty(obj, "__proto__", 1);
    defineOwnProperty(obj, "constructor", 2);
    defineOwnProperty(obj, "toString", 3);

    expect(Object.keys(obj)).toEqual(["__proto__", "constructor", "toString"]);
    expect(Object.getOwnPropertyDescriptor(obj, "__proto__")?.value).toBe(1);
    expect(obj["constructor"]).toBe(2);
    expect(obj["toString"]).toBe(3);
  });

  test("uniqueColumnNames produces non-colliding names even when _2 already exists later", () => {
    expect(uniqueColumnNames(["a", "a", "a_2"])).toEqual(["a", "a_3", "a_2"]);
    expect(uniqueColumnNames(["a", "a_2", "a"])).toEqual(["a", "a_2", "a_3"]);
    expect(uniqueColumnNames(["id", "id", "id"])).toEqual(["id", "id_2", "id_3"]);
  });

  test("normalizeSharedCell converts non-finite numbers to strings and preserves __proto__ in nested objects", () => {
    expect(normalizeSharedCell(Infinity)).toBe("Infinity");
    expect(normalizeSharedCell(-Infinity)).toBe("-Infinity");
    expect(normalizeSharedCell(Number.NaN)).toBe("NaN");
    expect(normalizeSharedCell(42)).toBe(42);
    const input = Object.defineProperty({}, "__proto__", {
      value: Infinity,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const out = normalizeSharedCell(input) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["__proto__"]);
    expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toBe("Infinity");
  });
});
