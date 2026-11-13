import { describe, expect, test } from "bun:test";
import { start, vim } from "./testing";

// gJ joins lines exactly as J does (the same function, with a count), in normal mode.
describe("gJ joins lines", () => {
  test.each([
    ["|a\n  b", "gJ", "a| b"],
    ["|a\n  b", "J", "a| b"],
    ["|a", "gJ", "|a"],
    ["|a\nb\nc\nd", "3gJ", "a b| c\nd"],
    ["|a\nb\nc\nd", "3J", "a b| c\nd"],
    ["|a\nb\nc\nd", "2gJ", "a| b\nc\nd"],
    ["|a\n\nb", "gJ", "|a\nb"],
  ] as const)("%j + %s -> %j", (before, keys, after) => {
    expect(vim(before, keys)).toBe(after);
  });

  test("gJ and J give the same text and cursor for every count", () => {
    for (const count of ["", "1", "2", "3", "5"]) {
      expect(vim("|a\n b\n  c\nd\ne\nf", `${count}gJ`)).toBe(vim("|a\n b\n  c\nd\ne\nf", `${count}J`));
    }
  });

  test(". repeats a join made by gJ", () => {
    const s = start("|a\nb\nc\nd");
    s.feed("gJ");
    expect(s.marked()).toBe("a| b\nc\nd");
    s.feed(".");
    expect(s.marked()).toBe("a b| c\nd");
  });

  test(". repeats a counted gJ with its count", () => {
    const s = start("|a\nb\nc\nd\ne\nf");
    s.feed("3gJ");
    expect(s.buffer.text()).toBe("a b c\nd\ne\nf");
    s.feed("j0.");
    expect(s.buffer.text()).toBe("a b c\nd e f");
  });

  test(". repeats a counted J with its count", () => {
    const s = start("|a\nb\nc\nd\ne\nf");
    s.feed("3J");
    expect(s.buffer.text()).toBe("a b c\nd\ne\nf");
    s.feed("j0.");
    expect(s.buffer.text()).toBe("a b c\nd e f");
  });

  test("gJ is undone in one step", () => {
    const s = start("|a\nb\nc");
    s.feed("3gJu");
    expect(s.buffer.text()).toBe("a\nb\nc");
  });

  test("gJ leaves nothing pending and gg still goes to the first line", () => {
    const s = start("a\nb\n|c");
    s.feed("gg");
    expect(s.marked()).toBe("|a\nb\nc");
    s.feed("gJ");
    expect(s.engine.pending).toBe("");
    expect(s.engine.mode).toBe("normal");
  });

  test("gJ in a read-only engine changes nothing", () => {
    expect(vim("|a\nb", "gJ", { readOnly: true })).toBe("|a\nb");
  });

  test("dgJ is not an operator motion and changes nothing", () => {
    expect(vim("|a\nb", "dgJ")).toBe("|a\nb");
  });
});
