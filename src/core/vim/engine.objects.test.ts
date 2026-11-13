import { describe, expect, test } from "bun:test";
import { MemoryBuffer } from "./buffer";
import { VimEngine } from "./engine";
import { parseKeys } from "./keys";
import { sqlStatementRange } from "./sql";
import { start, unmark, vim } from "./testing";

describe("text objects", () => {
  test.each([
    ["foo b|ar baz", "diw", "foo | baz"],
    ["foo b|ar baz", "daw", "foo |baz"],
    ["foo ba|r", "daw", "fo|o"],
    ["foo.b|ar baz", "diW", "| baz"],
    ['say "he|llo" now', 'di"', 'say "|" now'],
    ['say "he|llo" now', 'da"', "say |now"],
    ["x = 'a|b'", "di'", "x = '|'"],
    ["`a|b`", "di`", "`|`"],
    ["f(a, |b)", "di(", "f(|)"],
    ["f(a, |b)", "di)", "f(|)"],
    ["f(a, |b)", "dib", "f(|)"],
    ["f(a, |b)", "da(", "|f"],
    ["f|(a)", "di(", "f(|)"],
    ["f(a, g(|b), c)", "di(", "f(a, g(|), c)"],
    ["x[1|2]", "di[", "x[|]"],
    ["{ a|b }", "di{", "{|}"],
    ["{ a|b }", "diB", "{|}"],
    ["f(a, |b)", "ci(x<Esc>", "f(|x)"],
    ["a\nb\n\n|c\nd\n\ne", "dip", "a\nb\n\n|\ne"],
    ["no |quotes here", 'di"', "no |quotes here"],
    ["f|oo (bar)", "di(", "f|oo (bar)"],
    ["f|oo [bar]", "di[", "f|oo [bar]"],
    ["f|oo {bar}", "di{", "f|oo {bar}"],
  ] as const)("%j + %s -> %j", (before, keys, after) => {
    expect(vim(before, keys)).toBe(after);
  });

  test("pair text object outside pair cancels ci( and keeps visual selection unchanged", () => {
    const s = start("|foo (bar) baz");
    s.feed("ci(X<Esc>");
    expect(s.buffer.text()).toBe("foo (bar) baz");
    expect(s.engine.mode).toBe("normal");

    const v = start("|foo (bar)");
    v.feed("ve");
    const selBefore = v.buffer.selection;
    v.feed("i(");
    expect(v.buffer.selection).toEqual(selBefore);
    expect(v.marked()).toBe("fo|o (bar)");
  });

  test("yiw and yip fill the register", () => {
    const s = start("foo b|ar baz");
    s.feed("yiw");
    expect(s.engine.register('"')).toBe("bar");
    const p = start("a\n\n|c\nd\n\ne");
    p.feed("yip");
    expect(p.engine.register('"')).toBe("c\nd\n");
  });
});

describe("the SQL statement object", () => {
  const sqlVim = (marked: string, keys: string) => {
    const { text, row, col } = unmark(marked);
    const buffer = new MemoryBuffer(text);
    buffer.setCursor({ row, col });
    const engine = new VimEngine(buffer, { statementRange: sqlStatementRange(buffer) });
    for (const key of parseKeys(keys)) engine.feed(key);
    const lines = buffer.text().split("\n");
    const c = buffer.cursor();
    lines[c.row] = lines[c.row]!.slice(0, c.col) + "|" + lines[c.row]!.slice(c.col);
    return { marked: lines.join("\n"), engine };
  };

  test.each([
    ["select 1; sel|ect 2; select 3", "dis", "select 1; |; select 3"],
    ["select 1; sel|ect 2; select 3", "das", "select 1; |select 3"],
    ["select 1; sel|ect 2", "das", "select 1;| "],
    ["select 1;\nsel|ect 2\nfrom t;\nselect 3;", "das", "select 1;\n|select 3;"],
    ["select ';|' as a; select 2", "dis", "|; select 2"],
    ["sel|ect 1", "cisselect 2<Esc>", "select |2"],
  ] as const)("%j + %s -> %j", (before, keys, after) => {
    expect(sqlVim(before, keys).marked).toBe(after);
  });

  test("yis yanks the statement text", () => {
    const { engine } = sqlVim("select 1; sel|ect 2 ; select 3", "yis");
    expect(engine.register('"')).toBe("select 2");
  });

  test("without a statementRange option the object does nothing", () => {
    expect(vim("sel|ect 1;", "dis")).toBe("sel|ect 1;");
  });
});
