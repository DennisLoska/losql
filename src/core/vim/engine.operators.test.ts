import { describe, expect, test } from "bun:test";
import { start, vim } from "./testing";

describe("operators with motions", () => {
  test.each([
    ["|foo bar baz", "dw", "|bar baz"],
    ["|foo bar baz", "d2w", "|baz"],
    ["|foo bar baz", "2dw", "|baz"],
    ["foo |bar", "dw", "foo| "],
    ["foo |bar\nbaz", "dw", "foo| \nbaz"],
    ["|foo bar", "de", "| bar"],
    ["foo |bar baz", "db", "|bar baz"],
    ["foo |bar baz", "d$", "foo| "],
    ["foo |bar baz", "D", "foo| "],
    ["foo |bar", "d0", "|bar"],
    ["a|bc", "dl", "a|c"],
    ["a|bc", "dh", "|bc"],
    ["|select a, b from t", "dfa", "|, b from t"],
    ["|a, b", "dt,", "|, b"],
    ["f|(a, b) c", "d%", "f| c"],
    ["a\n|b\nc", "dd", "a\n|c"],
    ["a\nb\n|c", "dd", "a\n|b"],
    ["|a\nb\nc", "2dd", "|c"],
    ["a\n|b", "5dd", "|a"],
    ["|only", "dd", "|"],
    ["a\n  b|x\n  c", "dd", "a\n  |c"],
    ["|a\nb\nc", "dj", "|c"],
    ["a\n|b\nc", "dk", "|c"],
    ["a\n|b\nc", "dG", "|a"],
    ["a\n|b\nc", "dgg", "|c"],
    ["|foo bar", "cwbaz<Esc>", "ba|z bar"],
    ["foo |bar", "cchello<Esc>", "hell|o"],
    ["  foo|bar", "ccx<Esc>", "  |x"],
    ["foo |bar baz", "Cx<Esc>", "foo |x"],
    ["f(|a, b)", "ct)x<Esc>", "f(|x)"],
    ["|a", ">>", "  |a"],
    ["  |a", "<<", "|a"],
    ["|a", "<<", "|a"],
    ["|a\nb", ">j", "  |a\n  b"],
    ["|a\n\nc", ">2j", "  |a\n\n  c"],
    ["|\nb", "cwX<Esc>", "|X\nb"],
    ["a\n|\nb", "cWX<Esc>", "a\n|X\nb"],
    ["|\nb", "1cwX<Esc>", "|X\nb"],
    ["|\nb", "dw", "|b"],
    ["a\n|\nb", "dw", "a\n|b"],
    ["|\nb", "dW", "|b"],
    ["a\n|\nb", "dwu", "a\n|\nb"],
    ["|\n\nb", "dw.", "|b"],
  ] as const)("%j + %s -> %j", (before, keys, after) => {
    expect(vim(before, keys)).toBe(after);
  });
});

describe("single-key edits", () => {
  test.each([
    ["a|bc", "x", "a|c"],
    ["ab|c", "x", "a|b"],
    ["|abcd", "3x", "|d"],
    ["a|bc", "X", "|bc"],
    ["a|bc", "sX<Esc>", "a|Xc"],
    ["a|bc", "SX<Esc>", "|X"],
    ["a|bc", "rX", "a|Xc"],
    ["a|bc", "r<Esc>", "a|bc"],
    ["|a\n  b", "J", "a| b"],
    ["|a", "J", "|a"],
    ["|abc", "~", "A|bc"],
    ["|abc", "3~", "AB|C"],
    ["|abc", "xhdhu", "|abc"],
    ["|abc", "x0d0u", "|abc"],
    ["|ab\n", "xjdwku", "|ab\n"],
    ["|ab cd ef", "dw0dh.", "|ef"],
  ] as const)("%j + %s -> %j", (before, keys, after) => {
    expect(vim(before, keys)).toBe(after);
  });
});

describe("yank and put", () => {
  test.each([
    ["|a\nb", "yyp", "a\n|a\nb"],
    ["|a\nb", "yyP", "|a\na\nb"],
    ["a\n|b", "yyp", "a\nb\n|b"],
    ["|foo bar", "ywP", "foo| foo bar"],
    ["|foo bar", "ywp", "ffoo| oo bar"],
    ["|a\nb\nc", "yjGp", "a\nb\nc\n|a\nb"],
    ["|a\nb", "ddp", "b\n|a"],
    ["|ab", "xp", "b|a"],
  ] as const)("%j + %s -> %j", (before, keys, after) => {
    expect(vim(before, keys)).toBe(after);
  });

  test("Y yanks to the end of the line", () => {
    const s = start("foo |bar baz");
    s.feed("Y");
    expect(s.engine.register('"')).toBe("bar baz");
  });

  test("linewise registers end with a line break", () => {
    const s = start("|a\nb");
    s.feed("yy");
    expect(s.engine.register('"')).toBe("a\n");
    s.feed("yj");
    expect(s.engine.register('"')).toBe("a\nb\n");
  });
});

describe("registers", () => {
  test("yank fills the unnamed register and register 0; delete fills only the unnamed register", () => {
    const s = start("|foo bar");
    s.feed("yiwwdiw");
    expect(s.engine.register("0")).toBe("foo");
    expect(s.engine.register('"')).toBe("bar");
  });

  test("named registers", () => {
    const s = start("|foo bar");
    s.feed('"ayiw');
    expect(s.engine.register("a")).toBe("foo");
    expect(s.engine.register('"')).toBe("foo");
    s.feed('w"aP');
    expect(s.marked()).toBe("foo fo|obar");
  });

  test("the black hole register keeps the unnamed register intact", () => {
    const s = start("|foo bar");
    s.feed('yiww"_diw');
    expect(s.engine.register('"')).toBe("foo");
  });

  test("every yank goes to the clipboard; deletes do not", () => {
    const copied: string[] = [];
    const s = start("|foo bar", { clipboard: (text) => copied.push(text) });
    s.feed("yiw");
    s.feed("wdw");
    s.feed('"+yy');
    expect(copied).toEqual(["foo", "foo \n"]);
  });

  test("the + register pastes the last yank", () => {
    expect(vim("|foo bar", 'yiww"+P')).toBe("foo fo|obar");
  });

  test("a yank event carries the range", () => {
    const s = start("foo |bar baz");
    const events: unknown[] = [];
    s.engine.on("yank", (e) => events.push(e));
    s.feed("yiw");
    expect(events).toEqual([{ range: { start: { row: 0, col: 4 }, end: { row: 0, col: 7 } }, linewise: false, text: "bar" }]);
    s.feed("yy");
    expect(events[1]).toEqual({ range: { start: { row: 0, col: 0 }, end: { row: 0, col: 11 } }, linewise: true, text: "foo bar baz\n" });
  });
});

describe("repeat", () => {
  test.each([
    ["|a b c d", "dw.", "|c d"],
    ["|a b c d e", "2dw.", "|e"],
    ["|a b c d e", "dw3.", "|e"],
    ["|abcd", "x..", "|d"],
    ["|a\nb\nc", "dd.", "|c"],
    ["|foo foo foo", "cwbar<Esc>w.", "bar ba|r foo"],
    ["|a\nb", "A;<Esc>j.", "a;\nb|;"],
    ["|a", ">>.", "    |a"],
    ["|a b c", "dwyw.", "|c"],
    ["|a b c", "dwu.", "|b c"],
    ["|a b c d e f g", "d2w3.", "|f g"],
    ["|a b c d e f g", "2dw.", "|e f g"],
    ["|a b c d e f g", "2dw3.", "|f g"],
    ["|a b c d e f g", "2d2w", "|e f g"],
    ["|a b c d e f g", "2d2w.", "|"],
    ["|a b c d e f g", "2d2w1.", "|f g"],
    ["|abcdef", "3x.", "|"],
    ["|abcdef", "3x2.", "|f"],
    ["|abcdef", "x3.", "|ef"],
    ["|foo bar", "ctrX.Y<Esc>$.", "X.Y|r"],
    ["|(a) b", "ci(X<Esc>$.", "(X) |b"],
    ["|foo bar", "ctrX.Y<Esc>$.u", "|foo bar"],
    ["|(a) b", "ci(X<Esc>$.u", "|(a) b"],
    ["|foo bar", "ctrX.Y<Esc>$.x", "X.|Y"],
    ["|(a) b", "ci(X<Esc>$.x", "(X)| "],
    ["|", "ifoo<Esc>.", "fofo|oo"],
  ] as const)("%j + %s -> %j", (before, keys, after) => {
    expect(vim(before, keys)).toBe(after);
  });
});

describe("edit: changes made from outside the keyboard", () => {
  const at = (row: number, col: number) => ({ row, col });

  test("is one undo unit and leaves the cursor after the new text", () => {
    const s = start("select |from t");
    s.engine.edit({ start: at(0, 7), end: at(0, 7) }, "name ");
    expect(s.marked()).toBe("select name |from t");
    s.feed("u");
    expect(s.marked()).toBe("select |from t");
  });

  test("replaces a range and fires one change event", () => {
    const s = start("select |nme from t");
    let changes = 0;
    s.engine.on("change", () => changes++);
    s.engine.edit({ start: at(0, 7), end: at(0, 10) }, "name");
    expect(s.buffer.text()).toBe("select name from t");
    expect(changes).toBe(1);
  });

  test("inside an insert session it belongs to that session", () => {
    const s = start("|");
    s.feed("ise");
    s.engine.edit({ start: at(0, 0), end: at(0, 2) }, "select");
    expect(s.engine.mode).toBe("insert");
    s.feed(" 1<Esc>");
    expect(s.buffer.text()).toBe("select 1");
    s.feed("u");
    expect(s.marked()).toBe("|");
  });

  test("is not what the dot command repeats, leaves visual mode, and is refused when read-only", () => {
    const s = start("|a b c");
    s.feed("dw");
    s.engine.edit({ start: at(0, 0), end: at(0, 0) }, "x ");
    s.feed("0.");
    expect(s.buffer.text()).toBe("b c");
    s.feed("v");
    s.engine.edit({ start: at(0, 0), end: at(0, 1) }, "B");
    expect(s.engine.mode).toBe("normal");
    const ro = start("|abc", { readOnly: true });
    ro.engine.edit({ start: at(0, 0), end: at(0, 1) }, "X");
    expect(ro.buffer.text()).toBe("abc");
  });
});

describe("read-only buffers", () => {
  test("changes are rejected and everything else works", () => {
    const copied: string[] = [];
    const s = start("|foo bar\nbaz", { readOnly: true, clipboard: (t) => copied.push(t) });
    s.feed("xddicwxJ~p>>");
    expect(s.buffer.text()).toBe("foo bar\nbaz");
    expect(s.engine.mode).toBe("normal");
    s.feed("wyiw");
    expect(copied).toEqual(["bar"]);
    s.feed("jv");
    expect(s.engine.mode).toBe("visual");
  });
});
