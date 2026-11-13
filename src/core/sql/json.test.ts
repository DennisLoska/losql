import { expect, test } from "bun:test";
import { tokenizeJson } from "./json";

const kinds = (text: string) =>
  tokenizeJson(text).filter((t) => t.kind !== "whitespace").map((t) => [t.kind, text.slice(t.start, t.end)]);

test("objects, arrays and scalars", () => {
  expect(kinds('{"a": 1, "b": [true, false, null, -2.5e3, "x\\"y"]}')).toEqual([
    ["punctuation", "{"], ["key", '"a"'], ["punctuation", ":"], ["number", "1"], ["punctuation", ","],
    ["key", '"b"'], ["punctuation", ":"], ["punctuation", "["], ["boolean", "true"], ["punctuation", ","],
    ["boolean", "false"], ["punctuation", ","], ["null", "null"], ["punctuation", ","],
    ["number", "-2.5e3"], ["punctuation", ","], ["string", '"x\\"y"'], ["punctuation", "]"], ["punctuation", "}"],
  ]);
});

test("a string is a key only when a colon follows it", () => {
  expect(kinds('["a", {"b" : "c"}]').filter(([k]) => k === "key" || k === "string")).toEqual([
    ["string", '"a"'], ["key", '"b"'], ["string", '"c"'],
  ]);
});

test("anything else is invalid, and tokens cover the text", () => {
  const text = '{"a": nope, "b';
  const tokens = tokenizeJson(text);
  expect(tokens.some((t) => t.kind === "invalid")).toBe(true);
  expect(tokens[0]!.start).toBe(0);
  expect(tokens[tokens.length - 1]!.end).toBe(text.length);
  for (let i = 1; i < tokens.length; i++) expect(tokens[i]!.start).toBe(tokens[i - 1]!.end);
});

test("boundary inputs cover the text exactly without throwing, and whitespace before colon still makes a key", () => {
  const assertCoversExactly = (text: string) => {
    const tokens = tokenizeJson(text);
    let at = 0;
    for (const t of tokens) {
      expect(t.start).toBe(at);
      expect(t.end).toBeGreaterThan(t.start);
      at = t.end;
    }
    expect(at).toBe(text.length);
  };

  const cases = [
    "truex",
    "-",
    "1.",
    "01",
    "1abc",
    '"a',
    '"a"   : 1',
    '"a\\',
    "",
    '{"a":[1,{"b":null}]}',
  ];
  for (const input of cases) {
    assertCoversExactly(input);
  }

  expect(kinds('"a"   : 1')[0]).toEqual(["key", '"a"']);
});
