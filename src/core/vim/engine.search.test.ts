import { describe, expect, test } from "bun:test";
import { compilePattern, findMatches } from "./search";
import { start, vim } from "./testing";

describe("search", () => {
  test("search moves to the next match and wraps; n and N repeat", () => {
    const s = start("|foo bar foo baz");
    expect(s.engine.search("foo", 1)).toBe(true);
    expect(s.marked()).toBe("foo bar |foo baz");
    s.feed("n");
    expect(s.marked()).toBe("|foo bar foo baz");
    s.feed("N");
    expect(s.marked()).toBe("foo bar |foo baz");
  });

  test("backward search", () => {
    const s = start("foo bar foo |baz");
    expect(s.engine.search("foo", -1)).toBe(true);
    expect(s.marked()).toBe("foo bar |foo baz");
    s.feed("n");
    expect(s.marked()).toBe("|foo bar foo baz");
    s.feed("N");
    expect(s.marked()).toBe("foo bar |foo baz");
  });

  test("no match leaves the cursor and returns false", () => {
    const s = start("fo|o");
    expect(s.engine.search("zzz", 1)).toBe(false);
    expect(s.marked()).toBe("fo|o");
  });

  test("search crosses lines", () => {
    const s = start("|a\nb foo");
    s.engine.search("foo", 1);
    expect(s.marked()).toBe("a\nb |foo");
  });

  test("* and # search for the word under the cursor as a whole word", () => {
    expect(vim("|foo foobar foo", "*")).toBe("foo foobar |foo");
    expect(vim("foo foobar |foo", "#")).toBe("|foo foobar foo");
  });

  test("matches are exposed for highlighting and can be cleared", () => {
    const s = start("|Foo foo FOO");
    let notified = 0;
    s.engine.on("search", () => notified++);
    s.engine.search("foo", 1);
    expect(s.engine.searchMatches().length).toBe(3);
    s.engine.search("FOO", 1);
    expect(s.engine.searchMatches()).toEqual([{ start: { row: 0, col: 8 }, end: { row: 0, col: 11 } }]);
    s.engine.clearSearch();
    expect(s.engine.searchMatches()).toEqual([]);
    expect(notified).toBe(3);
    s.feed("n");
    expect(s.engine.searchMatches().length).toBe(1);
  });

  test("matches follow the text", () => {
    const s = start("|foo foo");
    s.engine.search("foo", 1);
    s.feed("0dw");
    expect(s.engine.searchMatches().length).toBe(1);
  });
});

describe("compilePattern", () => {
  test("smart case", () => {
    expect(findMatches("Foo foo FOO", compilePattern("foo")).length).toBe(3);
    expect(findMatches("Foo foo FOO", compilePattern("Foo")).length).toBe(1);
  });
  test("an invalid regular expression is matched literally", () => {
    expect(findMatches("x a( y", compilePattern("a("))).toEqual([{ start: 2, end: 4 }]);
  });
  test("regular expressions work", () => {
    expect(findMatches("a1 b22 c", compilePattern("\\d+"))).toEqual([{ start: 1, end: 2 }, { start: 4, end: 6 }]);
  });
  test("an empty match never loops forever", () => {
    expect(findMatches("abc", compilePattern("x*"))).toEqual([]);
  });
});

describe("Fix 5: searchMatches is linear", () => {
  test("50,000 lines with one match each finish within 150 ms and match exact positions on a small example", () => {
    const small = start("|ab foo cd\nfoo\n  foo bar");
    small.engine.search("foo", 1);
    expect(small.engine.searchMatches()).toEqual([
      { start: { row: 0, col: 3 }, end: { row: 0, col: 6 } },
      { start: { row: 1, col: 0 }, end: { row: 1, col: 3 } },
      { start: { row: 2, col: 2 }, end: { row: 2, col: 5 } },
    ]);

    const lines = Array.from({ length: 50000 }, (_, i) => `row ${i} match_here end`).join("\n");
    const big = start("|" + lines);
    big.engine.search("match_here", 1);
    const t0 = performance.now();
    const matches = big.engine.searchMatches();
    const elapsed = performance.now() - t0;
    expect(matches.length).toBe(50000);
    expect(matches[0]).toEqual({ start: { row: 0, col: 6 }, end: { row: 0, col: 16 } });
    expect(matches[49999]).toEqual({ start: { row: 49999, col: 10 }, end: { row: 49999, col: 20 } });
    expect(elapsed).toBeLessThan(150);
  });
});

describe("Fix 11: smart case ignores letters that belong to an escape", () => {
  test("\\D, \\W, \\S, \\B do not make pattern case-sensitive; uppercase outside an escape does", () => {
    expect(findMatches("xFOO", compilePattern("\\Dfoo"))).toEqual([{ start: 0, end: 4 }]);
    expect(findMatches("1FOO", compilePattern("\\W+foo"))).toEqual([]);
    expect(findMatches(" FOO", compilePattern("\\Wfoo"))).toEqual([{ start: 0, end: 4 }]);
    expect(findMatches("xFOO", compilePattern("\\Sfoo"))).toEqual([{ start: 0, end: 4 }]);
    expect(findMatches("xFOO", compilePattern("x\\Bfoo"))).toEqual([{ start: 0, end: 4 }]);
    expect(findMatches("foo", compilePattern("Foo"))).toEqual([]);
  });
});

describe("search repetition and surrogate-pair / line-break landing (fix-vim4)", () => {
  test("1. forward search and n over surrogate pairs advance through all characters for \\S, ., and [^a]", () => {
    for (const pattern of ["\\S", ".", "[^a]"]) {
      const s = start("|😀x😀y");
      expect(s.engine.search(pattern, 1)).toBe(true);
      const cols: number[] = [s.buffer.cursor().col];
      for (let i = 0; i < 5; i++) {
        s.feed("n");
        cols.push(s.buffer.cursor().col);
      }
      expect(cols).toEqual([2, 3, 5, 0, 2, 3]);
    }
  });

  test("2. backward search and n/N over surrogate pairs visit 3, 2, 0, 5 and never rest on a second unit", () => {
    const s1 = start("😀x😀|y");
    expect(s1.engine.search("\\S", -1)).toBe(true);
    const cols1 = [s1.buffer.cursor().col];
    for (let i = 0; i < 3; i++) {
      s1.feed("n");
      cols1.push(s1.buffer.cursor().col);
    }
    expect(cols1).toEqual([3, 2, 0, 5]);
    expect(s1.engine.searchMatches().map((r) => r.start.col)).toEqual([0, 2, 3, 5]);

    const s2 = start("😀x😀|y");
    expect(s2.engine.search("\\S", 1)).toBe(true);
    s2.buffer.setCursor({ row: 0, col: 5 });
    const cols2: number[] = [];
    for (let i = 0; i < 4; i++) {
      s2.feed("N");
      cols2.push(s2.buffer.cursor().col);
    }
    expect(cols2).toEqual([3, 2, 0, 5]);
  });

  test("3. searchMatches() returns whole-character ranges without splitting surrogate pairs", () => {
    const s1 = start("|😀x😀y");
    s1.engine.search(".", 1);
    expect(s1.engine.searchMatches()).toEqual([
      { start: { row: 0, col: 0 }, end: { row: 0, col: 2 } },
      { start: { row: 0, col: 2 }, end: { row: 0, col: 3 } },
      { start: { row: 0, col: 3 }, end: { row: 0, col: 5 } },
      { start: { row: 0, col: 5 }, end: { row: 0, col: 6 } },
    ]);

    const s2 = start("|a😀");
    s2.engine.search("\\S", 1);
    expect(s2.engine.searchMatches()).toEqual([
      { start: { row: 0, col: 0 }, end: { row: 0, col: 1 } },
      { start: { row: 0, col: 1 }, end: { row: 0, col: 3 } },
    ]);
  });

  test("4. searching for \\n and pressing n alternates between lines instead of getting stuck after clamping", () => {
    const s = start("|ab\ncd\nef");
    expect(s.engine.search("\\n", 1)).toBe(true);
    expect(s.buffer.cursor()).toEqual({ row: 0, col: 1 });
    const positions: Array<{ row: number; col: number }> = [];
    for (let i = 0; i < 4; i++) {
      s.feed("n");
      positions.push(s.buffer.cursor());
    }
    expect(positions).toEqual([
      { row: 1, col: 1 },
      { row: 0, col: 1 },
      { row: 1, col: 1 },
      { row: 0, col: 1 },
    ]);
  });

  test("5. a match that starts at the start of a pair is found as before and wraps on n", () => {
    const s = start("|a😀b");
    expect(s.engine.search("😀", 1)).toBe(true);
    expect(s.buffer.cursor().col).toBe(1);
    s.feed("n");
    expect(s.buffer.cursor().col).toBe(1);
  });

  test("6. performance guard: 50,000 one-char matches on one long line and on 50,000 short lines take < 50 ms per n", () => {
    const longLine = "|" + "a ".repeat(50000);
    const sLong = start(longLine);
    sLong.engine.search("a", 1);
    const t0 = performance.now();
    sLong.feed("n");
    const elapsedLong = performance.now() - t0;
    expect(sLong.buffer.cursor()).toEqual({ row: 0, col: 4 });
    expect(elapsedLong).toBeLessThan(50);

    const shortLines = "|" + Array.from({ length: 50000 }, () => "a").join("\n");
    const sShort = start(shortLines);
    sShort.engine.search("a", 1);
    const t1 = performance.now();
    sShort.feed("n");
    const elapsedShort = performance.now() - t1;
    expect(sShort.buffer.cursor()).toEqual({ row: 2, col: 0 });
    expect(elapsedShort).toBeLessThan(50);
  });
});

describe("Fix 1 (fix-vim5): a match that begins inside a surrogate pair is moved to the start of the pair, not dropped", () => {
  test("matches starting on the second unit of a surrogate pair are moved to the start of the pair in searchMatches() and search + n", () => {
    const cases: Array<{
      markedText: string;
      pattern: string;
      expectedRange: { start: { row: number; col: number }; end: { row: number; col: number } };
      expectedPos: { row: number; col: number };
    }> = [
      {
        markedText: "|😀;",
        pattern: "\\S;",
        expectedRange: { start: { row: 0, col: 0 }, end: { row: 0, col: 3 } },
        expectedPos: { row: 0, col: 0 },
      },
      {
        markedText: "|a😀",
        pattern: "\\S$",
        expectedRange: { start: { row: 0, col: 1 }, end: { row: 0, col: 3 } },
        expectedPos: { row: 0, col: 1 },
      },
      {
        markedText: "|😀x\nb",
        pattern: ".x",
        expectedRange: { start: { row: 0, col: 0 }, end: { row: 0, col: 3 } },
        expectedPos: { row: 0, col: 0 },
      },
      {
        markedText: "|😀\nb",
        pattern: ".\\n",
        expectedRange: { start: { row: 0, col: 0 }, end: { row: 1, col: 0 } },
        expectedPos: { row: 0, col: 0 },
      },
    ];

    for (const c of cases) {
      const rawText = c.markedText.slice(1);
      expect(findMatches(rawText, compilePattern(c.pattern))).toEqual([
        { start: c.expectedRange.start.col, end: 3 },
      ]);

      const s = start(c.markedText);
      expect(s.engine.search(c.pattern, 1)).toBe(true);
      expect(s.engine.searchMatches()).toEqual([c.expectedRange]);
      expect(s.buffer.cursor()).toEqual(c.expectedPos);
      s.feed("n");
      expect(s.buffer.cursor()).toEqual(c.expectedPos);
    }
  });

  test("property check: random texts with surrogates, lone surrogates, and line breaks yield valid non-overlapping ranges", () => {
    const alphabet = ["a", ";", "😀", "\n", "\ud83d", "\ude00"];
    const patterns = [".", "\\S", "\\S;", ".\\n", "[^a]"].map(compilePattern);

    let seed = 0x12345678;
    const nextRand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };

    const isInsidePair = (text: string, idx: number): boolean => {
      if (idx <= 0 || idx >= text.length) return false;
      const high = text.charCodeAt(idx - 1);
      const low = text.charCodeAt(idx);
      return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
    };

    for (let t = 0; t < 3000; t++) {
      const len = nextRand() % 14;
      let text = "";
      for (let i = 0; i < len; i++) {
        text += alphabet[nextRand() % alphabet.length]!;
      }

      for (const re of patterns) {
        const ranges = findMatches(text, re);
        let prevEnd = 0;
        for (const r of ranges) {
          expect(r.start).toBeGreaterThanOrEqual(prevEnd);
          expect(r.end).toBeGreaterThan(r.start);
          expect(r.end).toBeLessThanOrEqual(text.length);
          expect(isInsidePair(text, r.start)).toBe(false);
          expect(isInsidePair(text, r.end)).toBe(false);
          prevEnd = r.end;
        }
      }
    }
  });
});

