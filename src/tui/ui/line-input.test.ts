import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { parseKeys } from "../../core/vim/keys";
import { createLineInput, type LineInput } from "./line-input";

function run(input: LineInput, keys: string): boolean[] {
  return parseKeys(keys).map((key) => input.feed(key));
}
const state = (input: LineInput) => `${input.text().slice(0, input.cursor())}|${input.text().slice(input.cursor())}`;

test("typing, moving and deleting", () => {
  createRoot((dispose) => {
    const input = createLineInput();
    run(input, "hello world");
    expect(state(input)).toBe("hello world|");
    run(input, "<Left><Left><BS>");
    expect(state(input)).toBe("hello wo|ld");
    run(input, "<Home>X<End>!");
    expect(state(input)).toBe("Xhello wold!|");
    run(input, "<C-a><Del>");
    expect(state(input)).toBe("|hello wold!");
    run(input, "<C-e><C-w>");
    expect(state(input)).toBe("hello |");
    run(input, "<C-u>");
    expect(state(input)).toBe("|");
    run(input, "<BS><Left><Right>");
    expect(state(input)).toBe("|");
    dispose();
  });
});

test("set, initial text and paste", () => {
  createRoot((dispose) => {
    const input = createLineInput({ initial: "abc" });
    expect(state(input)).toBe("abc|");
    run(input, "<Left>");
    input.paste("XY\nZ");
    expect(state(input)).toBe("abXY Z|c");
    input.set("new");
    expect(state(input)).toBe("new|");
    dispose();
  });
});

test("multiline input takes line breaks from ctrl+j and paste", () => {
  createRoot((dispose) => {
    const input = createLineInput({ multiline: true });
    run(input, "a<C-j>b");
    expect(input.text()).toBe("a\nb");
    input.paste("\nc");
    expect(input.text()).toBe("a\nb\nc");
    dispose();
  });
});

test("keys it does not own are reported", () => {
  createRoot((dispose) => {
    const input = createLineInput();
    expect(run(input, "a<Left>")).toEqual([true, true]);
    expect(run(input, "<CR><Esc><Tab><Up><Down><C-n><C-p><C-j><F1>")).toEqual(Array(9).fill(false));
    expect(input.text()).toBe("a");
    dispose();
  });
});

test("edits whole graphemes and keeps the cursor on a grapheme boundary", () => {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const isBoundary = (text: string, pos: number) => {
    if (pos === 0 || pos === text.length) return true;
    for (const seg of segmenter.segment(text)) {
      if (seg.index === pos) return true;
    }
    return false;
  };

  createRoot((dispose) => {
    const input = createLineInput();

    // paste("a😀") then <BS> leaves "a" (no lone surrogate), and <Left>/<Right> step over the pair
    input.paste("a😀");
    expect(isBoundary(input.text(), input.cursor())).toBe(true);
    run(input, "<Left>");
    expect(input.cursor()).toBe(1);
    expect(isBoundary(input.text(), input.cursor())).toBe(true);
    run(input, "<Right>");
    expect(input.cursor()).toBe(3);
    expect(isBoundary(input.text(), input.cursor())).toBe(true);
    run(input, "<BS>");
    expect(input.text()).toBe("a");
    expect(input.cursor()).toBe(1);
    expect(isBoundary(input.text(), input.cursor())).toBe(true);

    // <Del> in front of 😀
    input.set("a😀b");
    run(input, "<Home><Right><Del>");
    expect(state(input)).toBe("a|b");
    expect(isBoundary(input.text(), input.cursor())).toBe(true);

    // combining mark (e + combining acute) and ZWJ family emoji
    const eAcute = "e\u0301";
    const family = "👨‍👩‍👧";
    input.set(`${eAcute}${family}`);
    expect(isBoundary(input.text(), input.cursor())).toBe(true);
    run(input, "<Left>");
    expect(input.cursor()).toBe(eAcute.length);
    expect(isBoundary(input.text(), input.cursor())).toBe(true);
    run(input, "<Left>");
    expect(input.cursor()).toBe(0);
    expect(isBoundary(input.text(), input.cursor())).toBe(true);
    run(input, "<Del>");
    expect(state(input)).toBe(`|${family}`);
    expect(isBoundary(input.text(), input.cursor())).toBe(true);
    run(input, "<Right><BS>");
    expect(state(input)).toBe("|");
    expect(isBoundary(input.text(), input.cursor())).toBe(true);

    // <C-w> over "naïve 👨‍👩‍👧"
    input.set("na\u0308ve 👨‍👩‍👧");
    run(input, "<C-w>");
    expect(state(input)).toBe("na\u0308ve |");
    expect(isBoundary(input.text(), input.cursor())).toBe(true);
    run(input, "<C-w>");
    expect(state(input)).toBe("|");
    expect(isBoundary(input.text(), input.cursor())).toBe(true);

    // Clamping cursor to nearest boundary at or before index
    input.set("a😀b", 2);
    expect(input.cursor()).toBe(1);
    expect(isBoundary(input.text(), input.cursor())).toBe(true);

    dispose();
  });
});

test("typed and pasted control characters never enter a single-line input", () => {
  createRoot((dispose) => {
    const input = createLineInput();
    input.paste("a\tb\r\nc\x1b[31m");
    expect(input.text()).toBe("a b c[31m");

    input.paste("\x00\x07\x7f\x80\x9f");
    expect(input.text()).toBe("a b c[31m");

    expect(input.feed({ name: "\x1b", ctrl: false, meta: false, shift: false, text: "\x1b" })).toBe(false);
    expect(input.feed({ name: "bell", ctrl: false, meta: false, shift: false, text: "\x07" })).toBe(false);
    expect(input.feed({ name: "del", ctrl: false, meta: false, shift: false, text: "\x7f" })).toBe(false);
    expect(input.feed({ name: "c1", ctrl: false, meta: false, shift: false, text: "\x9b" })).toBe(false);
    expect(input.text()).toBe("a b c[31m");

    const multi = createLineInput({ multiline: true });
    multi.paste("a\tb\r\nc\x1b[31m");
    expect(multi.text()).toBe("a b\nc[31m");

    dispose();
  });
});

test("U+2028 and U+2029 are treated as line breaks", () => {
  createRoot((dispose) => {
    const single = createLineInput();
    single.paste("aaa\u2028bbb\u2029ccc");
    expect(single.text()).toBe("aaa bbb ccc");

    single.set("");
    single.paste("x\u2028\u2029\r\ny");
    expect(single.text()).toBe("x y");

    // Key event whose text contains U+2028/U+2029 inserts with the break removed
    single.set("");
    expect(single.feed({ name: "a", ctrl: false, meta: false, shift: false, text: "a\u2028b\u2029" })).toBe(true);
    expect(single.text()).toBe("ab");
    expect(single.feed({ name: "sep", ctrl: false, meta: false, shift: false, text: "\u2028" })).toBe(false);

    const multi = createLineInput({ multiline: true });
    multi.paste("aaa\u2028bbb\u2029ccc");
    expect(multi.text()).toBe("aaa\nbbb\nccc");

    dispose();
  });
});
