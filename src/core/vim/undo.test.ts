import { describe, expect, test } from "bun:test";
import { MAX_UNDO_CHARS, MAX_UNDO_ENTRIES, UndoHistory } from "./undo";

describe("UndoHistory", () => {
  const snap = (text: string, row = 0, col = 0) => ({ text, cursor: { row, col } });

  test("exports limits", () => {
    expect(MAX_UNDO_ENTRIES).toBe(1000);
    expect(MAX_UNDO_CHARS).toBe(16_000_000);
  });

  test("undo and redo restore snapshots and new push clears redo", () => {
    const h = new UndoHistory();
    h.push(snap("one"));
    h.push(snap("two"));

    const u1 = h.undo(snap("three"));
    expect(u1?.text).toBe("two");
    const u2 = h.undo(snap("two"));
    expect(u2?.text).toBe("one");
    expect(h.undo(snap("one"))).toBeNull();

    const r1 = h.redo(snap("one"));
    expect(r1?.text).toBe("two");

    // A new change clears redo
    h.push(snap("two"));
    expect(h.redo(snap("two-b"))).toBeNull();

    h.clear();
    expect(h.undo(snap("two-b"))).toBeNull();
  });

  test("caps at MAX_UNDO_ENTRIES and drops oldest entries", () => {
    const h = new UndoHistory();
    for (let i = 0; i < MAX_UNDO_ENTRIES + 50; i++) {
      h.push(snap(`entry-${i}`));
    }

    let count = 0;
    let lastText = "";
    let cur = snap("current");
    while (true) {
      const prev = h.undo(cur);
      if (!prev) break;
      lastText = prev.text;
      cur = prev;
      count++;
    }
    expect(count).toBe(MAX_UNDO_ENTRIES);
    expect(lastText).toBe("entry-50");
  });

  test("caps at MAX_UNDO_CHARS and always keeps the newest entry", () => {
    const h = new UndoHistory(1000, 100);
    h.push(snap("a".repeat(40)));
    h.push(snap("b".repeat(40)));
    h.push(snap("c".repeat(40))); // total 120 > 100 -> drops "a"*40

    const u1 = h.undo(snap("current"));
    expect(u1?.text).toBe("c".repeat(40));
    const u2 = h.undo(u1!);
    expect(u2?.text).toBe("b".repeat(40));
    expect(h.undo(u2!)).toBeNull();

    // Single entry larger than maxChars is still kept as the newest entry
    const h2 = new UndoHistory(1000, 100);
    h2.push(snap("small"));
    h2.push(snap("x".repeat(250)));
    const big = h2.undo(snap("after"));
    expect(big?.text.length).toBe(250);
    expect(h2.undo(big!)).toBeNull();
  });
});
