import { describe, expect, test } from "bun:test";
import { start } from "./testing";

const at = (row: number, col: number) => ({ row, col });

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

describe("edit during an insert session is recorded for repeat (.)", () => {
  test("(a) A, cu + engine.edit replacing cu by customers + <Esc> + j. repeats the completed insert, and u twice restores both lines", () => {
    const s = start("|x\ny");
    s.feed("A, cu");
    s.engine.edit({ start: at(0, 3), end: at(0, 5) }, "customers");
    s.feed("<Esc>j.");
    expect(s.buffer.text()).toBe("x, customers\ny, customers");
    s.feed("uu");
    expect(s.buffer.text()).toBe("x\ny");
  });

  test("(b) repeating on a third line with a count (3.) matches a plain typed insert, and three repeats (...) append three times", () => {
    const s = start("|x\ny\nz");
    s.feed("A, cu");
    s.engine.edit({ start: at(0, 3), end: at(0, 5) }, "customers");
    s.feed("<Esc>j.j3.");

    const plain = start("|x\ny\nz");
    plain.feed("A, customers<Esc>j.j3.");
    expect(s.marked()).toBe(plain.marked());

    const sThree = start("|x\ny\nz");
    sThree.feed("A, cu");
    sThree.engine.edit({ start: at(0, 3), end: at(0, 5) }, "customers");
    sThree.feed("<Esc>j.j...");
    expect(sThree.buffer.text()).toBe("x, customers\ny, customers\nz, customers, customers, customers");

    const sCounted = start("|x\nyyy");
    sCounted.feed("scu");
    sCounted.engine.edit({ start: at(0, 0), end: at(0, 2) }, "customers");
    sCounted.feed("<Esc>j03.");
    const plainCounted = start("|x\nyyy");
    plainCounted.feed("scustomers<Esc>j03.");
    expect(sCounted.marked()).toBe(plainCounted.marked());
  });

  test("(c) an edit with an astral character in the replaced text and in the new text repeats without half characters", () => {
    const s = start("|x\ny");
    s.feed("A, 😀");
    expect(s.buffer.cursor()).toEqual(at(0, 5));
    s.engine.edit({ start: at(0, 3), end: at(0, 5) }, "a😀b");
    expect(s.buffer.text()).toBe("x, a😀b\ny");
    s.feed("<Esc>j.");
    expect(s.buffer.text()).toBe("x, a😀b\ny, a😀b");
    expect(hasLoneSurrogate(s.buffer.text())).toBe(false);
    s.feed("uu");
    expect(s.buffer.text()).toBe("x\ny");
  });

  test("(d) an edit whose range does not end at the cursor, or whose text contains a line break, leaves . repeating only the typed keys and does not throw", () => {
    const s1 = start("|x\ny");
    s1.feed("A, cu!");
    // Cursor is at col 6 (after '!'), range ends at col 5 (before '!')
    s1.engine.edit({ start: at(0, 3), end: at(0, 5) }, "customers");
    expect(s1.buffer.text()).toBe("x, customers!\ny");
    s1.feed("<Esc>j.");
    expect(s1.buffer.text()).toBe("x, customers!\ny, cu!");

    const s2 = start("|x\ny");
    s2.feed("A, cu");
    s2.engine.edit({ start: at(0, 3), end: at(0, 5) }, "customers\nmore");
    expect(s2.buffer.text()).toBe("x, customers\nmore\ny");
    s2.feed("<Esc>G.");
    expect(s2.buffer.text()).toBe("x, customers\nmore\ny, cu");
  });

  test("(e) an edit in normal mode followed by . repeats the last change from before", () => {
    const s = start("|a b c");
    s.feed("dw");
    expect(s.buffer.text()).toBe("b c");
    s.engine.edit({ start: at(0, 0), end: at(0, 0) }, "x ");
    expect(s.buffer.text()).toBe("x b c");
    s.feed("0.");
    expect(s.buffer.text()).toBe("b c");
  });
});

describe("`.` never deletes text that was not typed in the repeated insert", () => {
  test("a range that begins before the session's text: what is recorded is only what the session contributed", () => {
    for (const [before, range, text, after, expected] of [
      ["|from cu\nfrom y\nz", { start: at(0, 5), end: at(0, 7) }, "customers", "from customers\nfrom y\nz", "from customers\nfrom ystomers\nz"],
      ["|cu\ny\nz", { start: at(0, 0), end: at(0, 2) }, "customers", "customers\ny\nz", "customers\nystomers\nz"],
      ["|select 1\nfoo bar baz", { start: at(0, 0), end: at(0, 8) }, "select 2", "select 2\nfoo bar baz", "select 2\nfoo bar baz"],
    ] as const) {
      const s = start(before);
      s.feed("A");
      s.engine.edit(range, text);
      expect(s.buffer.text()).toBe(after);
      s.feed("<Esc>j.");
      expect(s.buffer.text()).toBe(expected);
      if (expected !== after) {
        s.feed("u");
        expect(s.buffer.text()).toBe(after);
      }
      s.feed("u");
      expect(s.buffer.text()).toBe(before.replace("|", ""));
    }
  });

  test("a word half typed before the session and half in it", () => {
    const s = start("|from c\nfrom y");
    s.feed("Au");
    s.engine.edit({ start: at(0, 5), end: at(0, 7) }, "customers");
    expect(s.buffer.text()).toBe("from customers\nfrom y");
    s.feed("<Esc>j.");
    expect(s.buffer.text()).toBe("from customers\nfrom yustomers");
    s.feed("u");
    expect(s.buffer.text()).toBe("from customers\nfrom y");
    s.feed("u");
    expect(s.buffer.text()).toBe("from c\nfrom y");
  });

  test("a range that starts on an earlier line than the session", () => {
    const s = start("ab\n|cd\nef");
    s.feed("Ax");
    s.engine.edit({ start: at(0, 1), end: at(1, 3) }, "QRSTUV");
    expect(s.buffer.text()).toBe("aQRSTUV\nef");
    expect(s.buffer.cursor()).toEqual(at(0, 7));
    s.feed("<Esc>j.");
    // The session typed `x` and its text began after `b\ncd` (4 units): `x` is deleted, `UV` is written.
    expect(s.buffer.text()).toBe("aQRSTUV\nefUV");
    s.feed("u");
    expect(s.buffer.text()).toBe("aQRSTUV\nef");
    s.feed("u");
    expect(s.buffer.text()).toBe("ab\ncd\nef");
  });

  test("an astral character at the boundary of the session's text is never split", () => {
    const s1 = start("|x😀\ny😀");
    s1.feed("Ab");
    s1.engine.edit({ start: at(0, 1), end: at(0, 4) }, "😀bc");
    expect(s1.buffer.text()).toBe("x😀bc\ny😀");
    s1.feed("<Esc>j.");
    expect(s1.buffer.text()).toBe("x😀bc\ny😀bc");
    s1.feed("uu");
    expect(s1.buffer.text()).toBe("x😀\ny😀");

    // The first replaced unit lies before the session, but the new text begins with an astral
    // character: it is written whole, not cut in half.
    const s2 = start("|a\nq");
    s2.feed("Ab");
    s2.engine.edit({ start: at(0, 0), end: at(0, 2) }, "😀z");
    expect(s2.buffer.text()).toBe("😀z\nq");
    s2.feed("<Esc>j.");
    expect(s2.buffer.text()).toBe("😀z\nq😀z");
    expect(hasLoneSurrogate(s2.buffer.text())).toBe(false);
    s2.feed("uu");
    expect(s2.buffer.text()).toBe("a\nq");

    // An astral character typed in the session and replaced together with text before it.
    const s3 = start("|ab\ncd");
    s3.feed("A😀");
    s3.engine.edit({ start: at(0, 1), end: at(0, 4) }, "XYZ");
    expect(s3.buffer.text()).toBe("aXYZ\ncd");
    s3.feed("<Esc>j.");
    expect(s3.buffer.text()).toBe("aXYZ\ncdYZ");
    expect(hasLoneSurrogate(s3.buffer.text())).toBe(false);
  });

  test("3. and .. repeat only what the session contributed, and u undoes each", () => {
    const s = start("|from cu\nfrom y\nfrom z");
    s.feed("A");
    s.engine.edit({ start: at(0, 5), end: at(0, 7) }, "customers");
    s.feed("<Esc>j3.");
    // A count on `.` does what it does after typing the recorded keys by hand (`A`, `stomers`).
    const plain = start("|from cu\nfrom y\nfrom z");
    plain.feed("Astomers<Esc>j3.");
    expect(s.marked().split("\n").slice(1)).toEqual(plain.marked().split("\n").slice(1));
    expect(s.buffer.text()).toBe("from customers\nfrom ystomers\nfrom z");
    s.feed("u");
    expect(s.buffer.text()).toBe("from customers\nfrom y\nfrom z");
    s.feed("G..");
    expect(s.buffer.text()).toBe("from customers\nfrom y\nfrom zstomersstomers");
    s.feed("u");
    expect(s.buffer.text()).toBe("from customers\nfrom y\nfrom zstomers");
    s.feed("u");
    expect(s.buffer.text()).toBe("from customers\nfrom y\nfrom z");
    s.feed("u");
    expect(s.buffer.text()).toBe("from cu\nfrom y\nfrom z");
  });

  test("Backspace past the start of the session moves the start back", () => {
    const s = start("|from cu\nfrom cy");
    s.feed("A<BS>u");
    s.engine.edit({ start: at(0, 5), end: at(0, 7) }, "customers");
    s.feed("<Esc>j.");
    // The session deleted `u` and typed `u`: on `from cy` that deletes `y`, as typing would.
    expect(s.buffer.text()).toBe("from customers\nfrom customers");
  });
});
