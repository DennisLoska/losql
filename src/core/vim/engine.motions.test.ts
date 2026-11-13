import { describe, expect, test } from "bun:test";
import { parseKeys } from "./keys";
import { start, vim } from "./testing";

const twentyLines = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");

describe("motions", () => {
  test.each([
    // [before, keys, after]
    ["|hello world", "l", "h|ello world"],
    ["hello worl|d", "l", "hello worl|d"],
    ["|hello world", "3l", "hel|lo world"],
    ["hello |world", "h", "hello| world"],
    ["|hello", "h", "|hello"],
    ["|abcdefghijklmnop", "10l", "abcdefghij|klmnop"],
    ["|hello", "<Right><Right><Left>", "h|ello"],
    ["|ab\ncd", "j", "ab\n|cd"],
    ["ab\n|cd", "k", "|ab\ncd"],
    ["ab|c\nd", "j", "abc\n|d"],
    ["ab|c\nd", "jk", "ab|c\nd"],
    ["ab|c\nd\nxyz", "jj", "abc\nd\nxy|z"],
    ["|\nabc", "j", "\n|abc"],
    ["|foo bar baz", "w", "foo |bar baz"],
    ["|foo bar baz", "2w", "foo bar |baz"],
    ["foo ba|r", "w", "foo ba|r"],
    ["fo|o\nbar", "w", "foo\n|bar"],
    ["|foo.bar baz", "w", "foo|.bar baz"],
    ["|foo.bar baz", "W", "foo.bar |baz"],
    ["foo bar |baz", "b", "foo |bar baz"],
    ["foo\n|bar", "b", "|foo\nbar"],
    ["foo.bar |baz", "B", "|foo.bar baz"],
    ["|foo bar", "e", "fo|o bar"],
    ["|foo bar", "ee", "foo ba|r"],
    ["|foo.bar baz", "E", "foo.ba|r baz"],
    ["  hello wor|ld", "0", "|  hello world"],
    ["  hello wor|ld", "^", "  |hello world"],
    ["|hello", "$", "hell|o"],
    ["a\nb\n|c", "gg", "|a\nb\nc"],
    ["|a\nb\nc", "G", "a\nb\n|c"],
    ["|a\nb\nc", "2G", "a\n|b\nc"],
    ["|a\nb\n  c", "G", "a\nb\n  |c"],
    ["|select a, b from t", "fa", "select |a, b from t"],
    ["|select a, b from t", "tb", "select a,| b from t"],
    ["select a, b |from t", "Fa", "select |a, b from t"],
    ["select a, b |from t", "Ta", "select a|, b from t"],
    ["|a.b.c.d", "f.;", "a.b|.c.d"],
    ["|a.b.c.d", "f.;,", "a|.b.c.d"],
    ["|abc", "fz", "|abc"],
    ["count|(a, (b))", "%", "count(a, (b)|)"],
    ["count(a, (b)|)", "%", "count|(a, (b))"],
    ["x = |[1, {2}]", "%", "x = [1, {2}|]"],
    ["a\nb\n\nc\n|d", "{", "a\nb\n|\nc\nd"],
    ["|a\nb\n\nc\nd", "}", "a\nb\n|\nc\nd"],
    ["a\nb\n\nc\n|d", "{{", "|a\nb\n\nc\nd"],
  ] as const)("%j + %s -> %j", (before, keys, after) => {
    expect(vim(before, keys)).toBe(after);
  });

  test("ctrl+d and ctrl+u move half a page", () => {
    const s = start("|" + twentyLines, { pageSize: () => 10 });
    s.feed("<C-d>");
    expect(s.buffer.cursor().row).toBe(5);
    s.feed("<C-d><C-d><C-d><C-d>");
    expect(s.buffer.cursor().row).toBe(19);
    s.feed("<C-u>");
    expect(s.buffer.cursor().row).toBe(14);
  });
});

describe("insert mode", () => {
  test.each([
    ["|world", "ihello <Esc>", "hello| world"],
    ["hell|o", "a!<Esc>", "hello|!"],
    ["he|llo", "A!<Esc>", "hello|!"],
    ["  he|llo", "I> <Esc>", "  >| hello"],
    ["|a\nb", "ox<Esc>", "a\n|x\nb"],
    ["a\n|b", "Ox<Esc>", "a\n|x\nb"],
    ["  |foo", "obar<Esc>", "  foo\n  ba|r"],
    ["ab|cd", "i<CR><Esc>", "ab\n|cd"],
    ["  ab|cd", "i<CR>x<Esc>", "  ab\n  |xcd"],
    ["ab|c", "a<BS><BS><Esc>", "|a"],
    ["a\n|b", "i<BS><Esc>", "|ab"],
    ["|foo bar", "A<C-w><Esc>", "foo| "],
    ["|foo bar", "A<C-u><Esc>", "|"],
    ["|x", "i<Tab><Esc>", " | x"],
    ["|ac", "a<Right>b<Left><Left>-<Esc>", "a|-cb"],
    ["|a", "ix<C-c>", "|xa"],
    ["|a", "ix<C-[>", "|xa"],
  ] as const)("%j + %s -> %j", (before, keys, after) => {
    expect(vim(before, keys)).toBe(after);
  });

  test("typed punctuation and spaces are text in insert mode", () => {
    expect(vim("|", "iselect 1: a;<Esc>")).toBe("select 1: a|;");
  });
});

describe("modes, pending keys and ownership", () => {
  test("mode changes are reported", () => {
    const s = start("|abc");
    const seen: string[] = [];
    s.engine.on("mode", (m) => seen.push(m));
    s.feed("i<Esc>v<Esc>V<Esc>");
    expect(seen).toEqual(["insert", "normal", "visual", "normal", "visual-line", "normal"]);
    expect(s.engine.mode).toBe("normal");
  });

  test("enterInsert starts insert mode", () => {
    const s = start("|");
    s.engine.enterInsert();
    s.feed("hi");
    expect(s.engine.mode).toBe("insert");
    expect(s.buffer.text()).toBe("hi");
  });

  test("pending shows unfinished input and Escape clears it", () => {
    const s = start("|abc");
    s.feed("2");
    expect(s.engine.pending).toBe("2");
    s.feed("g");
    expect(s.engine.pending).toBe("2g");
    s.feed("<Esc>");
    expect(s.engine.pending).toBe("");
    s.feed("g");
    s.engine.reset();
    expect(s.engine.pending).toBe("");
    expect(s.marked()).toBe("|abc");
  });

  test("keys the engine does not own are ignored so the application can use them", () => {
    const s = start("|abc");
    const one = (notation: string) => s.engine.feed(parseKeys(notation)[0]!);
    for (const k of ["<CR>", "<Space>", ":", "<Tab>", "<C-w>", "<C-s>", "<C-p>", "<C-c>", "<C-h>", "<C-j>", "<C-k>", "<C-l>", "<C-CR>", "<F1>"]) {
      expect(one(k)).toBe("ignored");
    }
    expect(one("j")).toBe("handled");
    expect(one("q")).toBe("handled"); // an unbound printable key is swallowed, not leaked
    s.feed("i");
    expect(one("<Space>")).toBe("handled");
    expect(one(":")).toBe("handled");
    expect(one("<CR>")).toBe("handled");
    for (const k of ["<C-n>", "<C-p>", "<C-s>", "<C-CR>", "<F1>"]) expect(one(k)).toBe("ignored");
  });

  test("a change event fires once per text change", () => {
    const s = start("|abc");
    let changes = 0;
    s.engine.on("change", () => changes++);
    s.feed("x");
    expect(changes).toBe(1);
    s.feed("l");
    expect(changes).toBe(1);
    s.feed("ihi<Esc>");
    expect(changes).toBe(3);
  });
});

describe("undo and redo", () => {
  test.each([
    ["|abc", "xxu", "|bc"],
    ["|abc", "xxuu", "|abc"],
    ["|abc", "xu<C-r>", "|bc"],
    ["|abc", "xuu", "|abc"],
    ["|abc", "x<C-r>", "|bc"],
    ["|", "ihello<Esc>u", "|"],
    ["|x", "ihello<Esc>ohi<Esc>u", "hell|ox"],
    ["|x", "ihello<Esc>ohi<Esc>uu", "|x"],
    ["|abc", "xux", "|bc"],
  ] as const)("%j + %s -> %j", (before, keys, after) => {
    expect(vim(before, keys)).toBe(after);
  });

  test("a new change after an undo clears redo", () => {
    expect(vim("|abc", "xuxl<C-r>")).toBe("b|c");
  });
});

describe("key ownership details", () => {
  const press = (s: ReturnType<typeof start>, notation: string) => s.engine.feed(parseKeys(notation)[0]!);

  test("an application key after a count or a prefix is still ignored and clears the pending input", () => {
    const s = start("|abc\ndef");
    s.feed("2");
    expect(press(s, "<C-s>")).toBe("ignored");
    expect(s.engine.pending).toBe("");
    s.feed("g");
    expect(press(s, "<F1>")).toBe("ignored");
    expect(s.engine.pending).toBe("");
    expect(s.marked()).toBe("|abc\ndef");
  });

  test("a find command takes a space or a colon as its target", () => {
    expect(vim("|a b:c", "f<Space>")).toBe("a| b:c");
    expect(vim("|a b:c", "f:")).toBe("a b|:c");
  });

  test("an application key cancels a pending find and is still ignored", () => {
    const s = start("|abc");
    s.feed("f");
    expect(press(s, "<C-s>")).toBe("ignored");
    expect(s.engine.pending).toBe("");
    expect(s.marked()).toBe("|abc");
  });

  test("modified keys the engine has no binding for are swallowed, not leaked", () => {
    const s = start("|abc");
    for (const k of ["<C-a>", "<C-v>", "<M-x>"]) expect(press(s, k)).toBe("handled");
    s.feed("i");
    for (const k of ["<C-a>", "<C-l>", "<C-j>", "<C-k>", "<C-h>", "<M-x>"]) expect(press(s, k)).toBe("handled");
    expect(s.engine.mode).toBe("insert");
    expect(s.buffer.text()).toBe("abc");
  });

  test("every function key is ignored in both modes", () => {
    const s = start("|abc");
    expect(press(s, "<F5>")).toBe("ignored");
    expect(press(s, "<F12>")).toBe("ignored");
    s.feed("i");
    expect(press(s, "<F5>")).toBe("ignored");
    expect(s.buffer.text()).toBe("abc");
  });
});

describe("Home, End and Delete", () => {
  test("normal mode: Home and End move like 0 and $, Delete deletes like x", () => {
    expect(vim("ab|c def", "<Home>")).toBe("|abc def");
    expect(vim("ab|c def", "<End>")).toBe("abc de|f");
    expect(vim("a|bc", "<Del>")).toBe("a|c");
  });

  test("insert mode: Home and End move within the line", () => {
    expect(vim("ab|c", "i<Home>X<Esc>")).toBe("|Xabc");
    expect(vim("|abc", "i<End>X<Esc>")).toBe("abc|X");
  });

  test("insert mode: Delete removes the next character and joins lines at the end of a line", () => {
    expect(vim("a|bc", "i<Del><Esc>")).toBe("|ac");
    expect(vim("a|b\ncd", "A<Del><Esc>")).toBe("a|bcd");
    expect(vim("a|b", "A<Del><Esc>")).toBe("a|b");
  });

  test("Delete in insert mode is part of the insert session's single undo unit", () => {
    const s = start("a|bc");
    s.feed("i<Del>X<Esc>u");
    expect(s.buffer.text()).toBe("abc");
  });
});

describe("key ownership with modifiers", () => {
  const shifted = (name: string, text?: string) => ({ name, shift: true, ...(text === undefined ? {} : { text }) });

  test("shifted application keys are ignored in normal mode", () => {
    const s = start("|abc");
    expect(s.engine.feed(shifted("enter"))).toBe("ignored");
    expect(s.engine.feed(shifted("space", " "))).toBe("ignored");
    expect(s.engine.feed(shifted(":", ":"))).toBe("ignored");
    expect(s.engine.feed(shifted("tab"))).toBe("ignored");
    expect(s.marked()).toBe("|abc");
  });

  test("a shifted application key clears a pending count and is ignored", () => {
    const s = start("|abc");
    s.feed("2");
    expect(s.engine.feed(shifted(":", ":"))).toBe("ignored");
    expect(s.engine.pending).toBe("");
  });

  test("a shifted colon is still the target of a pending find", () => {
    const s = start("|a b:c");
    s.feed("f");
    expect(s.engine.feed(shifted(":", ":"))).toBe("handled");
    expect(s.marked()).toBe("a b|:c");
  });

  test("a pending find is cancelled by shift+enter, which is ignored", () => {
    const s = start("|abc");
    s.feed("f");
    expect(s.engine.feed(shifted("enter"))).toBe("ignored");
    expect(s.engine.pending).toBe("");
  });

  test("function keys are ignored with any modifiers in both modes", () => {
    const s = start("|abc");
    expect(s.engine.feed({ name: "f5", shift: true })).toBe("ignored");
    expect(s.engine.feed({ name: "f2", ctrl: true })).toBe("ignored");
    expect(s.engine.feed({ name: "f12", meta: true })).toBe("ignored");
    s.feed("i");
    expect(s.engine.feed({ name: "f5", shift: true })).toBe("ignored");
    expect(s.engine.feed({ name: "f2", ctrl: true })).toBe("ignored");
    expect(s.buffer.text()).toBe("abc");
  });

  test("in insert mode a shifted colon or space is typed, not ignored", () => {
    const s = start("|abc");
    s.feed("i");
    expect(s.engine.feed(shifted(":", ":"))).toBe("handled");
    expect(s.engine.feed(shifted("space", " "))).toBe("handled");
    expect(s.buffer.text()).toBe(": abc");
  });
});
