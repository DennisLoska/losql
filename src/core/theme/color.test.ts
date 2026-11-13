import { expect, test } from "bun:test";
import { mix, parseColor, toHex } from "./color";
import { ThemeError } from "./tokens";

test("parseColor", () => {
  expect(parseColor("#1a1b26")).toEqual({ r: 26, g: 27, b: 38, a: 255 });
  expect(parseColor("#FFF")).toEqual({ r: 255, g: 255, b: 255, a: 255 });
  expect(parseColor("#11223380")).toEqual({ r: 17, g: 34, b: 51, a: 128 });
  expect(parseColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  expect(parseColor("none")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  expect(() => parseColor("#12")).toThrow(ThemeError);
  expect(() => parseColor("blue")).toThrow("not a color: blue");
});

test("toHex", () => {
  expect(toHex({ r: 26, g: 27, b: 38, a: 255 })).toBe("#1a1b26");
  expect(toHex({ r: 17, g: 34, b: 51, a: 128 })).toBe("#11223380");
});

test("mix", () => {
  const black = { r: 0, g: 0, b: 0, a: 255 };
  const white = { r: 255, g: 255, b: 255, a: 255 };
  expect(mix(black, white, 0)).toEqual(black);
  expect(mix(black, white, 1)).toEqual(white);
  expect(mix(black, white, 0.5)).toEqual({ r: 128, g: 128, b: 128, a: 255 });
  expect(mix(black, { r: 0, g: 0, b: 0, a: 0 }, 0.5).a).toBe(128);
});
