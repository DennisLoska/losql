import { describe, expect, test } from "bun:test";
import { start, vim } from "./testing";

describe("visual mode", () => {
  test.each([
    ["|foo bar", "ved", "| bar"],
    ["|foo bar", "vex", "| bar"],
    ["|foo bar", "vecx<Esc>", "|x bar"],
    ["foo |bar baz", "vlohd", "foo|r baz"],
    ["foo b|ar baz", "viwd", "foo | baz"],
    ["f(a, |b)", "vi(d", "f(|)"],
    ["|abc def", "ve~", "|ABC def"],
    ["a\n|b\nc", "Vd", "a\n|c"],
    ["|a\nb\nc", "Vjd", "|c"],
    ["a\nb\n|c", "Vkd", "|a"],
    ["|a\nb", "Vj>", "  |a\n  b"],
    ["  |a\n  b", "Vj<", "|a\nb"],
    ["|foo bar", "yiwwviwp", "foo fo|o"],
    ["|a\nb\nc", "vjd", "|\nc"],
    ["ab|c\ndef", "v$d", "a|b\ndef"],
    ["|abc", "vv", "|abc"],
    ["|abc", "vVd", "|"],
  ] as const)("%j + %s -> %j", (before, keys, after) => {
    expect(vim(before, keys)).toBe(after);
  });

  test("y yanks the selection, returns to normal mode and puts the cursor at its start", () => {
    const s = start("foo |bar baz");
    s.feed("vey");
    expect(s.engine.register('"')).toBe("bar");
    expect(s.engine.mode).toBe("normal");
    expect(s.marked()).toBe("foo |bar baz");
  });

  test("the buffer is told about the selection", () => {
    const s = start("|foo bar\nbaz");
    s.feed("ve");
    expect(s.buffer.selection).toEqual({ range: { start: { row: 0, col: 0 }, end: { row: 0, col: 3 } }, linewise: false });
    s.feed("<Esc>");
    expect(s.buffer.selection).toBeNull();
    s.feed("Vj");
    expect(s.buffer.selection).toEqual({ range: { start: { row: 0, col: 0 }, end: { row: 1, col: 3 } }, linewise: true });
    s.feed("d");
    expect(s.buffer.selection).toBeNull();
  });

  test("Enter and : are left to the application in visual mode", () => {
    const s = start("|abc");
    s.feed("v");
    expect(s.engine.feed({ name: "enter" })).toBe("ignored");
    expect(s.engine.feed({ name: ":", text: ":" })).toBe("ignored");
    expect(s.engine.mode).toBe("visual");
  });
});
