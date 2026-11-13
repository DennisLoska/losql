import { describe, expect, test } from "bun:test";
import { MAX_COUNT } from "./engine";
import { keyFromEvent } from "./keys";
import { start } from "./testing";

describe("no-op commands leave no trace (Fix 2 & Fix 4)", () => {
  test("change event is not emitted for empty or no-op commands", () => {
    const cases: Array<[string, string]> = [
      ["|abc", "dh"],
      ["|abc", "d0"],
      ["a\n|", "dw"],
      ["|", "dd"],
      ["|", "s"],
      ["|", "cw"],
      ["|", "cc"],
      ["|", "S"],
      ["|", "C"],
      ["|abc", "<<"],
      ["|", ">>"],
      ["|123", "~"],
      ["|abc", "J"],
    ];

    for (const [initial, keys] of cases) {
      const s = start(initial);
      let changes = 0;
      s.engine.on("change", () => changes++);
      s.feed(keys);
      expect(changes).toBe(0);
    }
  });

  test("empty delete/change/yank writes no register, no clipboard, no yank event", () => {
    const copied: string[] = [];
    const yankEvents: unknown[] = [];
    const s = start("|foo\n", { clipboard: (t) => copied.push(t) });
    s.engine.on("yank", (e) => yankEvents.push(e));
    s.feed("yiw");
    expect(s.engine.register('"')).toBe("foo");
    expect(copied).toEqual(["foo"]);
    expect(yankEvents).toHaveLength(1);

    // Move to empty line and try empty yw, dw, cw, s, cc, dd on single empty line
    s.feed("j");
    s.feed("yw");
    s.feed("dw");
    s.feed("s<Esc>");
    expect(s.engine.register('"')).toBe("foo");
    expect(copied).toEqual(["foo"]);
    expect(yankEvents).toHaveLength(1);

    const singleEmpty = start("|", { clipboard: (t) => copied.push(t) });
    singleEmpty.feed("yiw");
    singleEmpty.feed("yh");
    singleEmpty.feed("dd");
    expect(copied).toEqual(["foo"]);
    expect(singleEmpty.engine.register('"')).toBe("");
  });

  test("empty c-family commands enter insert mode without change event or register write, and record like i", () => {
    const s = start("|foo\n");
    s.feed("yiw");
    expect(s.engine.register('"')).toBe("foo");

    let changes = 0;
    s.engine.on("change", () => changes++);
    s.feed("jcw");
    expect(s.engine.mode).toBe("insert");
    expect(changes).toBe(0);
    expect(s.engine.register('"')).toBe("foo");

    s.feed("bar<Esc>");
    expect(s.engine.mode).toBe("normal");
    expect(s.buffer.text()).toBe("foo\nbar");
    expect(changes).toBeGreaterThan(0);

    // Undo should undo the typed "bar" in one step
    s.feed("u");
    expect(s.buffer.text()).toBe("foo\n");

    // And '.' repeats the cwbar<Esc> change
    s.feed("j.");
    expect(s.buffer.text()).toBe("foo\nbar");
  });

  test(">> on a single empty line leaves text unchanged with no change event and no undo entry", () => {
    const s = start("|a");
    s.feed("x");
    expect(s.marked()).toBe("|");

    let changes = 0;
    s.engine.on("change", () => changes++);
    s.feed(">>");
    expect(s.marked()).toBe("|");
    expect(changes).toBe(0);

    // Undo should undo the 'x', proving '>>' pushed no undo entry
    s.feed("u");
    expect(s.marked()).toBe("|a");
  });

  test("no-op single-key and operator commands do not push undo or replace repeat target", () => {
    const s = start("|123\nabc");
    s.feed("j~k"); // 'abc' -> 'Abc', cursor at 'b' on row 1, then 'k' moves to row 0 col 1
    expect(s.buffer.text()).toBe("123\nAbc");

    // '~' on '2' changes nothing, '<<' changes nothing, '0dh' at col 0 changes nothing
    let changes = 0;
    s.engine.on("change", () => changes++);
    s.feed("~<<0dh");
    expect(changes).toBe(0);

    // '.' still repeats '~' from earlier!
    s.feed("j.");
    expect(s.buffer.text()).toBe("123\nabc");

    // Undo twice gets back to "123\nabc"
    s.feed("2u");
    expect(s.buffer.text()).toBe("123\nabc");
  });

  test("cw and cW on an empty line followed by another line do not join lines, emit 1 change event for typed text, and leave register unchanged", () => {
    const s = start("|foo\n\nb");
    s.feed("yiw");
    expect(s.engine.register('"')).toBe("foo");

    let changes = 0;
    s.engine.on("change", () => changes++);
    s.feed("jcwX<Esc>");
    expect(s.marked()).toBe("foo\n|X\nb");
    expect(changes).toBe(1);
    expect(s.engine.register('"')).toBe("foo");
  });

  test("yy and Vy on a single-empty-line buffer yank '\\n' linewise, while dd leaves no trace and yh does nothing", () => {
    const copied1: string[] = [];
    const yanks1: Array<{ linewise: boolean; text: string }> = [];
    const s1 = start("|", { clipboard: (t) => copied1.push(t) });
    s1.engine.on("yank", (e) => yanks1.push({ linewise: e.linewise, text: e.text }));
    s1.feed("yy");
    expect(s1.engine.register('"')).toBe("\n");
    expect(copied1).toEqual(["\n"]);
    expect(yanks1).toEqual([{ linewise: true, text: "\n" }]);
    s1.feed("p");
    expect(s1.marked()).toBe("\n|");

    const copied2: string[] = [];
    const yanks2: Array<{ linewise: boolean; text: string }> = [];
    const s2 = start("|", { clipboard: (t) => copied2.push(t) });
    s2.engine.on("yank", (e) => yanks2.push({ linewise: e.linewise, text: e.text }));
    s2.feed("Vy");
    expect(s2.engine.register('"')).toBe("\n");
    expect(copied2).toEqual(["\n"]);
    expect(yanks2).toEqual([{ linewise: true, text: "\n" }]);

    const copied3: string[] = [];
    const yanks3: unknown[] = [];
    const s3 = start("|abc", { clipboard: (t) => copied3.push(t) });
    s3.engine.on("yank", (e) => yanks3.push(e));
    s3.feed("yh");
    expect(s3.engine.register('"')).toBe("");
    expect(copied3).toEqual([]);
    expect(yanks3).toEqual([]);
  });

  test("failed dot replay stops immediately without feeding insert keys to normal mode and preserves the recorded change", () => {
    const s = start("|foo bar\nfoo bar");
    s.feed("ctrX.Y<Esc>$.");
    expect(s.marked()).toBe("X.Y|r\nfoo bar");
    expect(s.engine.mode).toBe("normal");
    expect(s.engine.pending).toBe("");

    // Recorded change stays what it was: moving to the next line and pressing '.' replays ctrX.Y<Esc>
    s.feed("j0.");
    expect(s.marked()).toBe("X.Yr\nX.|Yr");

    // Replaying c with an empty range at col 0 enters insert mode and inserts the recorded text again
    const s2 = start("a|bc");
    s2.feed("chX.Y<Esc>0.");
    expect(s2.marked()).toBe("X.|YX.Ybc");
    expect(s2.engine.mode).toBe("normal");
    expect(s2.engine.pending).toBe("");
  });

  test("Fix 1: dw and dW on an empty line delete only that line and preserve next line indentation", () => {
    const s1 = start("|\n  b");
    s1.feed("dw");
    expect(s1.marked()).toBe("|  b");
    expect(s1.engine.register('"')).toBe("\n");

    const s2 = start("|\n  b");
    s2.feed("dW");
    expect(s2.marked()).toBe("|  b");
    expect(s2.engine.register('"')).toBe("\n");

    const s3 = start("a\n|\n  b");
    s3.feed("dw");
    expect(s3.marked()).toBe("a\n|  b");
    expect(s3.engine.register('"')).toBe("\n");

    const s4 = start("|\n\n  b");
    s4.feed("dw.");
    expect(s4.marked()).toBe("|  b");
    expect(s4.engine.register('"')).toBe("\n");
  });

  test("Fix 2: c with an empty range enters insert mode, while a failed motion still cancels", () => {
    const cases: Array<[string, string, string]> = [
      ["|ab", "chX<Esc>", "|Xab"],
      ["  |ab", "c^X<Esc>", "  |Xab"],
      ["a|b", "cTaX<Esc>", "a|Xb"],
      ["|", "clX<Esc>", "|X"],
    ];

    for (const [initial, keys, expected] of cases) {
      const s = start(initial);
      s.feed(keys);
      expect(s.marked()).toBe(expected);
      s.feed("u");
      expect(s.marked()).toBe(initial);
    }

    const failed = start("|ab");
    failed.feed("cfzX<Esc>");
    expect(failed.marked()).toBe("|ab");
    expect(failed.engine.mode).toBe("normal");
  });

  test("Fix 3: counts saturate at MAX_COUNT and counted motion loops stop when position stops changing", () => {
    expect(MAX_COUNT).toBe(999999);

    const t0 = performance.now();
    const s1 = start("|a b c");
    s1.feed("1000000000w");
    const elapsed1 = performance.now() - t0;
    expect(s1.marked()).toBe("a b |c");
    expect(elapsed1).toBeLessThan(50);

    const tenThousandWords = "|" + Array.from({ length: 10000 }, (_, i) => `w${i}`).join(" ");
    const t1 = performance.now();
    const s2 = start(tenThousandWords);
    s2.feed("1000000000w");
    const elapsed2 = performance.now() - t1;
    expect(s2.buffer.cursor().col).toBe(s2.buffer.line(0).length - 1);
    expect(elapsed2).toBeLessThan(50);

    // 22-digit count with '.' behaves like 999999. and does not emit scientific notation
    const s3 = start("|abcdef");
    s3.feed("x");
    s3.feed("1000000000000000000000.");
    expect(s3.marked()).toBe("|");

    // Counted b, e, }, {, j, k return at once at the end of text
    const t2 = performance.now();
    const s4 = start("|a b\nc d\n\ne f");
    s4.feed("999999e");
    expect(s4.marked()).toBe("a b\nc d\n\ne |f");
    s4.feed("999999b");
    expect(s4.marked()).toBe("|a b\nc d\n\ne f");
    s4.feed("999999}");
    expect(s4.marked()).toBe("a b\nc d\n\n|e f");
    s4.feed("999999{");
    expect(s4.marked()).toBe("|a b\nc d\n\ne f");
    s4.feed("999999j");
    expect(s4.marked()).toBe("a b\nc d\n\n|e f");
    s4.feed("999999k");
    expect(s4.marked()).toBe("|a b\nc d\n\ne f");
    expect(performance.now() - t2).toBeLessThan(50);
  });

  test("Fix 4: 1,200 changes in the engine leave exactly 1,000 undo steps", () => {
    const s = start("|" + "a".repeat(1205));
    const t0 = performance.now();
    for (let i = 0; i < 1200; i++) {
      s.feed("x");
    }
    expect(s.buffer.text().length).toBe(5);
    s.feed("2000u");
    const elapsed = performance.now() - t0;
    expect(s.buffer.text().length).toBe(1005);
    expect(elapsed).toBeLessThan(1000);
  });

  test("Fix 6: no command splits a surrogate pair", () => {
    expect(start("|😀x")).toBeDefined();

    const s1 = start("|😀x");
    s1.feed("x");
    expect(s1.marked()).toBe("|x");

    const s2 = start("😀|x");
    s2.feed("i<BS><Esc>");
    expect(s2.marked()).toBe("|x");

    const s3 = start("|a😀b");
    expect(s3.buffer.cursor().col).toBe(0);
    s3.feed("l");
    expect(s3.buffer.cursor().col).toBe(1);
    s3.feed("l");
    expect(s3.buffer.cursor().col).toBe(3);
    s3.feed("h");
    expect(s3.buffer.cursor().col).toBe(1);
    s3.feed("h");
    expect(s3.buffer.cursor().col).toBe(0);

    // r on 😀 replaces both units
    const s4 = start("a|😀b");
    s4.feed("rZ");
    expect(s4.marked()).toBe("a|Zb");

    // r with astral Key replaces character
    const s5 = start("a|xb");
    s5.feed("r");
    s5.engine.feed({ name: "😀", text: "😀" });
    expect(s5.marked()).toBe("a|😀b");

    // ~ on 😀 moves over it unchanged
    const s6 = start("|😀b");
    s6.feed("~");
    expect(s6.marked()).toBe("😀|b");

    // dl, X, e, insert <Del>, <Left>, <Right>
    const s7 = start("|😀b");
    s7.feed("dl");
    expect(s7.marked()).toBe("|b");

    const s8 = start("😀|b");
    s8.feed("X");
    expect(s8.marked()).toBe("|b");

    const s9 = start("|a😀");
    s9.feed("e");
    expect(s9.buffer.cursor().col).toBe(1);

    const s10 = start("|😀b");
    s10.feed("i<Del><Esc>");
    expect(s10.marked()).toBe("|b");

    const s11 = start("|😀b");
    s11.feed("i<Right>");
    expect(s11.buffer.cursor().col).toBe(2);
    s11.feed("<Left>");
    expect(s11.buffer.cursor().col).toBe(0);
    s11.feed("<Esc>");
  });

  test("Fix 7: a typed astral character event yields text and inserts in insert mode", () => {
    const k = keyFromEvent({ name: "", sequence: "😀", ctrl: false, meta: false, shift: false });
    expect(k.text).toBe("😀");
    const s = start("|ab");
    s.feed("i");
    s.engine.feed(k);
    s.feed("<Esc>");
    expect(s.marked()).toBe("|😀ab");
  });

  test("Fix 8: cursor is clamped in normal mode in constructor and before handling keys", () => {
    const s = start("ab|\n  b");
    expect(s.marked()).toBe("a|b\n  b");
    s.feed("dw");
    expect(s.marked()).toBe("|a\n  b");

    // Also when buffer.setCursor or buffer.setText places cursor past last char in normal mode after construction
    const s2 = start("|ab\n  b");
    s2.buffer.setCursor({ row: 0, col: 2 });
    s2.feed("dw");
    expect(s2.marked()).toBe("|a\n  b");
  });

  test("Fix 9: visual p that changes nothing leaves no trace", () => {
    const s = start("|abc");
    s.feed("x");
    expect(s.marked()).toBe("|bc");
    s.feed("u");
    expect(s.marked()).toBe("|abc");
    // Put a previous undoable change so we can verify 'u' undoes that, or test on fresh buffer
    const s1 = start("|abc");
    let changes = 0;
    s1.engine.on("change", () => changes++);
    s1.feed("yiwviwp");
    expect(changes).toBe(0);
    expect(s1.marked()).toBe("ab|c");
    s1.feed("u");
    expect(changes).toBe(0);

    // Also verify previous undo entry and named register are untouched when visual p is a no-op
    const s2 = start("|abc def");
    s2.feed("x"); // deletes 'a', unnamed = 'a', text = 'bc def'
    s2.feed('"ayiw'); // yanks 'bc' into 'a' and '"'
    let c2 = 0;
    s2.engine.on("change", () => c2++);
    s2.feed("viwp"); // pastes 'bc' over 'bc' -> no-op
    expect(c2).toBe(0);
    s2.feed("u"); // undoes 'x'
    expect(s2.buffer.text()).toBe("abc def");
  });

  test("Fix 10: edit normalises reversed ranges, clamps positions, and ignores no-op edits", () => {
    const s = start("|abcdef");
    s.engine.edit({ start: { row: 0, col: 5 }, end: { row: 0, col: 1 } }, "X");
    expect(s.buffer.text()).toBe("aXf");

    // Clamping out-of-bounds positions
    const s2 = start("|abc");
    s2.engine.edit({ start: { row: -5, col: -2 }, end: { row: 99, col: 99 } }, "Z");
    expect(s2.buffer.text()).toBe("Z");

    // Empty edit and identical replacement emit no change event and push no undo entry
    const s3 = start("|abcdef");
    s3.feed("x"); // text is "bcdef"
    let changes = 0;
    s3.engine.on("change", () => changes++);
    s3.engine.edit({ start: { row: 0, col: 2 }, end: { row: 0, col: 2 } }, "");
    s3.engine.edit({ start: { row: 0, col: 1 }, end: { row: 0, col: 3 } }, "cd");
    expect(changes).toBe(0);
    s3.feed("u");
    expect(s3.buffer.text()).toBe("abcdef");
  });
});

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= text.length) return true;
      const next = text.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("T1 & T3: whole-character coverage and ~ length-changing case mapping", () => {
  test("T1: ~ when case mapping changes length moves cursor past the toggled text", () => {
    const s1 = start("|ßa");
    s1.feed("~");
    expect(s1.marked()).toBe("SS|a");
    expect(hasLoneSurrogate(s1.buffer.text())).toBe(false);

    const s2 = start("|ßb");
    s2.feed("~.");
    expect(s2.marked()).toBe("SS|B");
    expect(hasLoneSurrogate(s2.buffer.text())).toBe(false);
  });

  test("T3: insert-mode <Left> over an astral character and normal a on an astral character", () => {
    const s1 = start("a😀|b");
    s1.feed("i<Left>X<Esc>");
    expect(s1.marked()).toBe("a|X😀b");
    expect(s1.buffer.cursor()).toEqual({ row: 0, col: 1 });
    expect(hasLoneSurrogate(s1.buffer.text())).toBe(false);

    const s2 = start("a|😀b");
    s2.feed("aX<Esc>");
    expect(s2.marked()).toBe("a😀|Xb");
    expect(s2.buffer.cursor()).toEqual({ row: 0, col: 3 });
    expect(hasLoneSurrogate(s2.buffer.text())).toBe(false);
  });

  test("T3: p and P of charwise text after and before an astral character, including astral pasted text", () => {
    // Paste ASCII charwise text after and before an astral character
    const s1 = start("|xy 😀z");
    s1.feed("yiwwp");
    expect(s1.marked()).toBe("xy 😀x|yz");
    expect(s1.buffer.cursor()).toEqual({ row: 0, col: 6 });
    expect(hasLoneSurrogate(s1.buffer.text())).toBe(false);

    const s2 = start("|xy 😀z");
    s2.feed("yiwwP");
    expect(s2.marked()).toBe("xy x|y😀z");
    expect(s2.buffer.cursor()).toEqual({ row: 0, col: 4 });
    expect(hasLoneSurrogate(s2.buffer.text())).toBe(false);

    // Paste charwise text ending with an astral character after and before an astral character
    const s3 = start("|a😀 b😀c");
    s3.feed("y2l3wp");
    expect(s3.marked()).toBe("a😀 b😀a|😀c");
    expect(s3.buffer.cursor()).toEqual({ row: 0, col: 8 });
    expect(hasLoneSurrogate(s3.buffer.text())).toBe(false);

    const s4 = start("|a😀 b😀c");
    s4.feed("y2l3wP");
    expect(s4.marked()).toBe("a😀 ba|😀😀c");
    expect(s4.buffer.cursor()).toEqual({ row: 0, col: 6 });
    expect(hasLoneSurrogate(s4.buffer.text())).toBe(false);
  });

  test("T3: visual p over a selection that ends on an astral character", () => {
    const s1 = start("|XY a😀b");
    s1.feed("yiwwvlp");
    expect(s1.marked()).toBe("XY X|Yb");
    expect(s1.buffer.cursor()).toEqual({ row: 0, col: 4 });
    expect(s1.engine.register('"')).toBe("a😀");
    expect(hasLoneSurrogate(s1.buffer.text())).toBe(false);

    // Also when pasting text ending on an astral character over a selection ending on an astral character
    const s2 = start("|a😀 x😀z");
    s2.feed("y2lwwvlp");
    expect(s2.marked()).toBe("a😀 a|😀z");
    expect(s2.buffer.cursor()).toEqual({ row: 0, col: 5 });
    expect(s2.engine.register('"')).toBe("x😀");
    expect(hasLoneSurrogate(s2.buffer.text())).toBe(false);
  });

  test("T3: visual selection and buffer selection range whose end sits on an astral character (v then d and y)", () => {
    const s1 = start("a|b😀c");
    s1.feed("vl");
    expect(s1.buffer.cursor()).toEqual({ row: 0, col: 2 });
    expect(s1.buffer.selection).toEqual({
      range: { start: { row: 0, col: 1 }, end: { row: 0, col: 4 } },
      linewise: false,
    });
    s1.feed("y");
    expect(s1.engine.register('"')).toBe("b😀");
    expect(s1.marked()).toBe("a|b😀c");
    expect(s1.buffer.cursor()).toEqual({ row: 0, col: 1 });
    expect(hasLoneSurrogate(s1.buffer.text())).toBe(false);

    const s2 = start("a|b😀c");
    s2.feed("vl");
    expect(s2.buffer.selection).toEqual({
      range: { start: { row: 0, col: 1 }, end: { row: 0, col: 4 } },
      linewise: false,
    });
    s2.feed("d");
    expect(s2.engine.register('"')).toBe("b😀");
    expect(s2.marked()).toBe("a|c");
    expect(s2.buffer.cursor()).toEqual({ row: 0, col: 1 });
    expect(hasLoneSurrogate(s2.buffer.text())).toBe(false);
  });

  test("T3: f, t, F, T with an astral target character and ; , after them", () => {
    const s1 = start("|a😀b😀c");
    s1.feed("f");
    s1.engine.feed({ name: "😀", text: "😀" });
    expect(s1.marked()).toBe("a|😀b😀c");
    expect(s1.buffer.cursor()).toEqual({ row: 0, col: 1 });
    s1.feed(";");
    expect(s1.marked()).toBe("a😀b|😀c");
    expect(s1.buffer.cursor()).toEqual({ row: 0, col: 4 });
    s1.feed(",");
    expect(s1.marked()).toBe("a|😀b😀c");
    expect(s1.buffer.cursor()).toEqual({ row: 0, col: 1 });
    expect(hasLoneSurrogate(s1.buffer.text())).toBe(false);

    const s2 = start("|ax😀bx😀c");
    s2.feed("t");
    s2.engine.feed({ name: "😀", text: "😀" });
    expect(s2.marked()).toBe("a|x😀bx😀c");
    expect(s2.buffer.cursor()).toEqual({ row: 0, col: 1 });
    s2.feed(";");
    expect(s2.marked()).toBe("ax😀b|x😀c");
    expect(s2.buffer.cursor()).toEqual({ row: 0, col: 5 });
    s2.feed(",");
    expect(s2.marked()).toBe("ax😀|bx😀c");
    expect(s2.buffer.cursor()).toEqual({ row: 0, col: 4 });
    expect(hasLoneSurrogate(s2.buffer.text())).toBe(false);

    const s3 = start("a😀b😀|c");
    s3.feed("F");
    s3.engine.feed({ name: "😀", text: "😀" });
    expect(s3.marked()).toBe("a😀b|😀c");
    expect(s3.buffer.cursor()).toEqual({ row: 0, col: 4 });
    s3.feed(";");
    expect(s3.marked()).toBe("a|😀b😀c");
    expect(s3.buffer.cursor()).toEqual({ row: 0, col: 1 });
    s3.feed(",");
    expect(s3.marked()).toBe("a😀b|😀c");
    expect(s3.buffer.cursor()).toEqual({ row: 0, col: 4 });
    expect(hasLoneSurrogate(s3.buffer.text())).toBe(false);

    const s4 = start("a😀bx😀b|c");
    s4.feed("T");
    s4.engine.feed({ name: "😀", text: "😀" });
    expect(s4.marked()).toBe("a😀bx😀|bc");
    expect(s4.buffer.cursor()).toEqual({ row: 0, col: 7 });
    s4.feed(";");
    expect(s4.marked()).toBe("a😀|bx😀bc");
    expect(s4.buffer.cursor()).toEqual({ row: 0, col: 3 });
    s4.feed(",");
    expect(s4.marked()).toBe("a😀b|x😀bc");
    expect(s4.buffer.cursor()).toEqual({ row: 0, col: 4 });
    expect(hasLoneSurrogate(s4.buffer.text())).toBe(false);
  });

  test("T3: ~ over an astral character and visual ~ over an astral character", () => {
    const s1 = start("|😀a");
    s1.feed("~");
    expect(s1.marked()).toBe("😀|a");
    expect(s1.buffer.cursor()).toEqual({ row: 0, col: 2 });
    expect(hasLoneSurrogate(s1.buffer.text())).toBe(false);

    const s2 = start("|a😀b");
    s2.feed("3~");
    expect(s2.marked()).toBe("A😀|B");
    expect(s2.buffer.cursor()).toEqual({ row: 0, col: 3 });
    expect(hasLoneSurrogate(s2.buffer.text())).toBe(false);

    const s3 = start("|a😀b");
    s3.feed("vll~");
    expect(s3.marked()).toBe("|A😀B");
    expect(s3.buffer.cursor()).toEqual({ row: 0, col: 0 });
    expect(hasLoneSurrogate(s3.buffer.text())).toBe(false);
  });

  test("T3: iw and aw next to astral characters", () => {
    const s1 = start("😀|foo😀");
    s1.feed("diw");
    expect(s1.marked()).toBe("😀|😀");
    expect(s1.buffer.cursor()).toEqual({ row: 0, col: 2 });
    expect(hasLoneSurrogate(s1.buffer.text())).toBe(false);

    const s2 = start("a|😀😀b");
    s2.feed("diw");
    expect(s2.marked()).toBe("a|b");
    expect(s2.buffer.cursor()).toEqual({ row: 0, col: 1 });
    expect(hasLoneSurrogate(s2.buffer.text())).toBe(false);

    const s3 = start("😀 |foo 😀");
    s3.feed("daw");
    expect(s3.marked()).toBe("😀 |😀");
    expect(s3.buffer.cursor()).toEqual({ row: 0, col: 3 });
    expect(hasLoneSurrogate(s3.buffer.text())).toBe(false);

    const s4 = start("foo |😀😀");
    s4.feed("daw");
    expect(s4.marked()).toBe("fo|o");
    expect(s4.buffer.cursor()).toEqual({ row: 0, col: 2 });
    expect(hasLoneSurrogate(s4.buffer.text())).toBe(false);
  });

  test("T3: insert-mode <Up> and <Down> from a column inside the neighbouring line's surrogate pair", () => {
    const s1 = start("😀a\nb|cd");
    s1.feed("i<Up>X<Esc>");
    expect(s1.marked()).toBe("|X😀a\nbcd");
    expect(s1.buffer.cursor()).toEqual({ row: 0, col: 0 });
    expect(hasLoneSurrogate(s1.buffer.text())).toBe(false);

    const s2 = start("b|cd\n😀a");
    s2.feed("i<Down>X<Esc>");
    expect(s2.marked()).toBe("bcd\n|X😀a");
    expect(s2.buffer.cursor()).toEqual({ row: 1, col: 0 });
    expect(hasLoneSurrogate(s2.buffer.text())).toBe(false);
  });

  test("Fix 2 (fix-vim5): insert-mode <Left>, <Up> and <Down> next to an astral character place the cursor at the start of the pair immediately", () => {
    const startWithExactCursor = (marked: string) => {
      const s = start(marked);
      let pos = s.buffer.cursor();
      s.buffer.cursor = () => ({ row: pos.row, col: pos.col });
      s.buffer.setCursor = (next) => {
        const maxRow = Math.max(0, s.buffer.lineCount() - 1);
        const row = Math.max(0, Math.min(maxRow, next.row));
        const maxCol = s.buffer.line(row).length;
        const col = Math.max(0, Math.min(maxCol, next.col));
        pos = { row, col };
      };
      return s;
    };

    const sLeft = startWithExactCursor("a😀|b");
    sLeft.feed("i<Left>");
    expect(sLeft.buffer.cursor()).toEqual({ row: 0, col: 1 });
    sLeft.feed("X<Esc>");
    expect(sLeft.marked()).toBe("a|X😀b");
    expect(sLeft.buffer.cursor()).toEqual({ row: 0, col: 1 });
    expect(hasLoneSurrogate(sLeft.buffer.text())).toBe(false);

    const sUp = startWithExactCursor("😀a\nb|cd");
    sUp.feed("i<Up>");
    expect(sUp.buffer.cursor()).toEqual({ row: 0, col: 0 });
    sUp.feed("X<Esc>");
    expect(sUp.marked()).toBe("|X😀a\nbcd");
    expect(sUp.buffer.cursor()).toEqual({ row: 0, col: 0 });
    expect(hasLoneSurrogate(sUp.buffer.text())).toBe(false);

    const sDown = startWithExactCursor("b|cd\n😀a");
    sDown.feed("i<Down>");
    expect(sDown.buffer.cursor()).toEqual({ row: 1, col: 0 });
    sDown.feed("X<Esc>");
    expect(sDown.marked()).toBe("bcd\n|X😀a");
    expect(sDown.buffer.cursor()).toEqual({ row: 1, col: 0 });
    expect(hasLoneSurrogate(sDown.buffer.text())).toBe(false);

    // Also verify on plain MemoryBuffer that buffer.cursor() directly after i<Left> and <Right> (which updates preferredCol)
    // and i<Up> / i<Down> is at the start of the pair
    const pLeft = start("a😀|b");
    pLeft.feed("i<Left>");
    expect(pLeft.buffer.cursor()).toEqual({ row: 0, col: 1 });
    pLeft.feed("<Down>");
    expect(pLeft.buffer.cursor()).toEqual({ row: 0, col: 1 });

    const pUp = start("😀a\nb|cd");
    pUp.feed("i<Up>");
    expect(pUp.buffer.cursor()).toEqual({ row: 0, col: 0 });

    const pDown = start("b|cd\n😀a");
    pDown.feed("i<Down>");
    expect(pDown.buffer.cursor()).toEqual({ row: 1, col: 0 });
  });
});




