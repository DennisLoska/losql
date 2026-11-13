import { describe, expect, test } from "bun:test";
import { MemoryBuffer } from "./buffer";
import { VimEngine } from "./engine";
import { parseKeys } from "./keys";

function feed(engine: VimEngine, seq: string): void {
  for (const k of parseKeys(seq)) {
    engine.feed(k);
  }
}

describe("VimEngine.moveTo", () => {
  test("after moveTo to a column beyond the line's end the cursor is clamped, and j afterwards keeps the new column", () => {
    const buf = new MemoryBuffer("abcdef\n0123456789");
    const engine = new VimEngine(buf);

    // Move to column 99 on row 0 ("abcdef", length 6 -> normal mode max col is 5)
    feed(engine, "2d");
    expect(engine.pending).toBe("2d");

    engine.moveTo({ row: 0, col: 99 });
    expect(engine.pending).toBe("");
    expect(buf.cursor()).toEqual({ row: 0, col: 5 });

    // j afterwards keeps the new column (col 5 on row 1)
    feed(engine, "j");
    expect(buf.cursor()).toEqual({ row: 1, col: 5 });
  });

  test("in visual mode the selection extends to the position", () => {
    const buf = new MemoryBuffer("hello world\nsecond line");
    const engine = new VimEngine(buf);

    feed(engine, "llv");
    expect(engine.mode).toBe("visual");
    expect(buf.cursor()).toEqual({ row: 0, col: 2 });

    engine.moveTo({ row: 1, col: 4 });
    expect(buf.cursor()).toEqual({ row: 1, col: 4 });
    expect(buf.selection).toEqual({
      range: {
        start: { row: 0, col: 2 },
        end: { row: 1, col: 5 },
      },
      linewise: false,
    });
  });

  test("a position inside a surrogate pair lands on the pair's start", () => {
    // "a😀b" -> 'a' at 0, '😀' at 1..2 (high surrogate at 1, low at 2), 'b' at 3
    const buf = new MemoryBuffer("a😀b");
    const engine = new VimEngine(buf);

    engine.moveTo({ row: 0, col: 2 });
    expect(buf.cursor()).toEqual({ row: 0, col: 1 });

    // Also in insert mode, inside surrogate pair lands on pair's start, and col at line.length is allowed
    feed(engine, "i");
    expect(engine.mode).toBe("insert");
    engine.moveTo({ row: 0, col: 2 });
    expect(buf.cursor()).toEqual({ row: 0, col: 1 });
    engine.moveTo({ row: 0, col: 99 });
    expect(buf.cursor()).toEqual({ row: 0, col: 4 });
  });
});
