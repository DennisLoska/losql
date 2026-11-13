import { afterEach, describe, expect, test } from "bun:test";
import { createSignal, Show } from "solid-js";
import type { ExecRequest, ExecResult } from "../../../core/exec";
import { parseKeys } from "../../../core/vim/keys";
import { unmark } from "../../../core/vim/testing";
import { mount, spanWith, type TestApp } from "../../testing";
import { VimTextarea, type VimTextareaHandle } from "./VimTextarea";

let app: TestApp;
let handle: VimTextareaHandle;
afterEach(async () => { await app?.dispose(); });

async function open(options: { language?: "sql" | "json"; readOnly?: boolean; text?: string } = {}) {
  app = await mount({
    ui: () => (
      <VimTextarea
        language={options.language ?? "sql"}
        readOnly={options.readOnly}
        initialText={options.text}
        active
        onReady={(h) => (handle = h)}
      />
    ),
  });
}

/** The same cursor-marker form the core vim tests use, run against the real EditBuffer. */
async function vim(marked: string, keys: string): Promise<string> {
  const { text, row, col } = unmark(marked);
  handle.setText(text);
  handle.buffer.setCursor({ row, col });
  for (const key of parseKeys(keys)) handle.feed(key);
  await app.settle();
  const lines = handle.text().split("\n");
  const c = handle.buffer.cursor();
  lines[c.row] = lines[c.row]!.slice(0, c.col) + "|" + lines[c.row]!.slice(c.col);
  return lines.join("\n");
}

describe("the vim engine on an EditBuffer", () => {
  test.each([
    ["|foo bar baz", "dw", "|bar baz"],
    ["|foo bar baz", "3l", "foo| bar baz"],
    ["ab|c\nd", "jk", "ab|c\nd"],
    ["a\n|b\nc", "dd", "a\n|c"],
    ["|a\nb", "yyp", "a\n|a\nb"],
    ["|world", "ihello <Esc>", "hello| world"],
    ["ab|cd", "i<CR><Esc>", "ab\n|cd"],
    ["a\n|b", "i<BS><Esc>", "|ab"],
    ["|a\n  b", "J", "a| b"],
    ["f(a, |b)", "ci(x<Esc>", "f(|x)"],
    ["|a\nb\nc", "Vjd", "|c"],
    ["|foo bar", "ved", "| bar"],
    ["|abc", "xxu", "|bc"],
    ["|abc", "xu<C-r>", "|bc"],
    ["|a b c d", "dw.", "|c d"],
    ["|a\nb\nc", "G", "a\nb\n|c"],
    ["a\nb\n|c", "ggOx<Esc>", "|x\na\nb\nc"],
  ] as const)("%j + %s -> %j", async (before, keys, after) => {
    await open();
    expect(await vim(before, keys)).toBe(after);
  });

  test("the handle reports mode, pending keys and the cursor", async () => {
    await open({ text: "select 1\nfrom t" });
    expect(handle.text()).toBe("select 1\nfrom t");
    expect([handle.mode(), handle.pending(), handle.cursor()]).toEqual(["normal", "", { row: 0, col: 0 }]);
    handle.feed(parseKeys("j")[0]!);
    handle.feed(parseKeys("2")[0]!);
    expect([handle.pending(), handle.cursor()]).toEqual(["2", { row: 1, col: 0 }]);
    handle.feed(parseKeys("<Esc>")[0]!);
    handle.feed(parseKeys("i")[0]!);
    expect(handle.mode()).toBe("insert");
  });

  test("setText resets undo", async () => {
    await open({ text: "one" });
    handle.feed(parseKeys("x")[0]!);
    handle.setText("two");
    handle.feed(parseKeys("u")[0]!);
    expect(handle.text()).toBe("two");
  });

  test("onChange reports edits", async () => {
    const seen: string[] = [];
    app = await mount({
      ui: () => <VimTextarea language="sql" initialText="abc" active onReady={(h) => (handle = h)} onChange={(t) => seen.push(t)} />,
    });
    for (const key of parseKeys("xix<Esc>")) handle.feed(key);
    expect(seen).toEqual(["bc", "xbc"]);
  });
});

describe("drawing", () => {
  const same = (a: { toInts(): number[] }, b: { toInts(): number[] }) => expect(a.toInts()).toEqual(b.toInts());

  test("SQL is highlighted from the theme and shows line numbers", async () => {
    await open({ text: "select 'x' -- note\nfrom t" });
    const frame = app.spans();
    same(spanWith(frame, "select")!.fg, app.api.theme.color("syntaxKeyword"));
    same(spanWith(frame, "'x'")!.fg, app.api.theme.color("syntaxString"));
    same(spanWith(frame, "-- note")!.fg, app.api.theme.color("syntaxComment"));
    expect(app.frame()).toMatch(/1 select/);
    expect(app.frame()).toMatch(/2 from t/);
  });

  test("highlighting follows edits and theme changes", async () => {
    await open({ text: "x" });
    for (const key of parseKeys("ccfrom<Esc>")) handle.feed(key);
    await app.settle();
    same(spanWith(app.spans(), "from")!.fg, app.api.theme.color("syntaxKeyword"));
    await app.api.theme.select("nord");
    await app.settle();
    same(spanWith(app.spans(), "from")!.fg, app.api.theme.color("syntaxKeyword"));
  });

  test("JSON is highlighted", async () => {
    await open({ language: "json", text: '{\n  "name": "Ada",\n  "n": 42\n}' });
    const frame = app.spans();
    same(spanWith(frame, '"name"')!.fg, app.api.theme.color("syntaxType"));
    same(spanWith(frame, '"Ada"')!.fg, app.api.theme.color("syntaxString"));
    same(spanWith(frame, "42")!.fg, app.api.theme.color("syntaxNumber"));
  });

  test("search matches, the visual selection and an error mark are drawn", async () => {
    await open({ text: "select frm t" });
    handle.engine.search("frm", 1);
    await app.settle();
    same(spanWith(app.spans(), "frm")!.bg, app.api.theme.color("warning"));
    handle.engine.clearSearch();
    handle.markError(8);
    await app.settle();
    same(spanWith(app.spans(), "frm")!.fg, app.api.theme.color("error"));
    for (const key of parseKeys("0ve")) handle.feed(key);
    await app.settle();
    same(spanWith(app.spans(), "select")!.bg, app.api.theme.color("selection"));
    for (const key of parseKeys("<Esc>x")) handle.feed(key);
    await app.settle();
    expect(spanWith(app.spans(), "frm")!.fg.toInts()).not.toEqual(app.api.theme.color("error").toInts());
  });

  test("a read-only view rejects edits and still yanks", async () => {
    await open({ readOnly: true, text: "keep me" });
    for (const key of parseKeys("xddiZ<Esc>yy")) handle.feed(key);
    expect(handle.text()).toBe("keep me");
    expect(handle.mode()).toBe("normal");
    expect(app.deps.written.length).toBe(1);
  });

  test("the background is not painted when the theme is Transparent", async () => {
    app = await mount({
      config: { transparent: true },
      ui: () => <VimTextarea language="sql" initialText="select 1" active onReady={(h) => (handle = h)} />,
    });
    expect(spanWith(app.spans(), "select")!.bg.toInts()[3]).toBe(0);
  });

  test("highlights and cursor positions are right after an emoji, wide character and tab", async () => {
    await open({ text: "\t/* 世 👍🏽 */ select 42" });
    const frame = app.spans();
    same(spanWith(frame, "select")!.fg, app.api.theme.color("syntaxKeyword"));
    same(spanWith(frame, "42")!.fg, app.api.theme.color("syntaxNumber"));
    expect(await vim("|\t/* 世 👍🏽 */ select 42", "fsdw")).toBe("\t/* 世 👍🏽 */ |42");
  });
});

describe("Fix 1: engine text always matches editBuffer text inside grapheme clusters", () => {
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });

  function expectedClusterCol(editBuffer: any, line: string, utf16Col: number): number {
    const clamped = Math.max(0, Math.min(line.length, utf16Col));
    if (clamped === 0) return 0;
    if (clamped >= line.length) return editBuffer.measureText(line);
    let clusterStart = clamped;
    for (const s of seg.segment(line)) {
      const start = s.index;
      const end = start + s.segment.length;
      if (clamped >= start && clamped < end) {
        clusterStart = start;
        break;
      }
    }
    return editBuffer.measureText(line.slice(0, clusterStart));
  }

  test("decomposed accent, zero-width space and skin-tone emoji edits inside clusters", async () => {
    await open();
    const eb = () => (handle.buffer as any).textarea.editBuffer;

    handle.setText("ae\u0301b");
    for (const k of parseKeys("ldl")) handle.feed(k);
    expect(handle.text()).toBe("a\u0301b");
    expect(eb().getText()).toBe("a\u0301b");

    handle.setText("a\u200bb");
    for (const k of parseKeys("lx")) handle.feed(k);
    expect(handle.text()).toBe("ab");
    expect(eb().getText()).toBe("ab");

    handle.setText("a\ud83d\udc4d\ud83c\udffdb");
    for (const k of parseKeys("lx")) handle.feed(k);
    expect(handle.text()).toBe("a\ud83c\udffdb");
    expect(eb().getText()).toBe("a\ud83c\udffdb");
  });

  test("seeded 20,000-key random test over combining marks, ZWJ, skin-tone, ZWSP, wide chars, tabs and plain text", async () => {
    await open();
    const eb = (handle.buffer as any).textarea.editBuffer;

    let state = 0x17012026 >>> 0;
    const nextU32 = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (t ^ (t >>> 14)) >>> 0;
    };
    const pick = <T,>(arr: readonly T[]): T => arr[nextU32() % arr.length]!;

    const initialLines = [
      "select ae\u0301b, a\u0300\u0301c from t;",
      "where x = 'a\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67b' and y = 'a\ud83d\udc4d\ud83c\udffdb';",
      "\ta\u200bb \t 世界 \t plain_text(1, 2);",
    ];
    handle.setText(initialLines.join("\n"));

    const keyNotations = [
      "h", "j", "k", "l", "w", "b", "e", "0", "^", "$", "gg", "G", "%",
      "x", "X", "s", "~", "J", "p", "P", "dd", "cc", "yy", "D", "C",
      "dw", "cw", "dl", "dh", "diw", "ci'", "rX", "u", "<C-r>", ".",
      "v", "V", "d", "y",
      "i", "a", "I", "A", "o", "O",
      "<Esc>", "<Esc>", "<Esc>", "<Esc>", "<Esc>", "<Esc>",
      "<BS>", "<Del>", "<CR>", "<Tab>", "<Left>", "<Right>", "<Up>", "<Down>",
      "a", "b", " ", "\u0301", "\u200b", "世", "\ud83d\udc4d", "\ud83c\udffd",
    ];
    const pool = keyNotations.map((n) => {
      if (n.length === 1 || n === "\ud83d\udc4d" || n === "\ud83c\udffd") {
        if (n === "\u0301" || n === "\u200b" || n === "世" || n === "\ud83d\udc4d" || n === "\ud83c\udffd") {
          return [{ name: n, text: n }];
        }
      }
      return parseKeys(n);
    });

    let keysFed = 0;
    while (keysFed < 20_000) {
      if (keysFed > 0 && keysFed % 4_000 === 0) {
        handle.setText(initialLines.join("\n"));
      }
      const seq = pick(pool);
      for (const k of seq) {
        if (keysFed >= 20_000) break;
        handle.feed(k);
        keysFed++;

        const adapterText = handle.text();
        const ebText = eb.getText();
        if (adapterText !== ebText) {
          throw new Error(`Text mismatch at step ${keysFed} after key ${JSON.stringify(k)}: adapter=${JSON.stringify(adapterText)} eb=${JSON.stringify(ebText)}`);
        }

        const engCur = handle.buffer.cursor();
        const ebCur = eb.getCursorPosition();
        if (ebCur.row !== engCur.row) {
          throw new Error(`Row mismatch at step ${keysFed}: engine=${engCur.row} eb=${ebCur.row}`);
        }
        const line = handle.buffer.line(engCur.row);
        const expCol = expectedClusterCol(eb, line, engCur.col);
        if (ebCur.col !== expCol) {
          throw new Error(
            `Cursor cell mismatch at step ${keysFed} on line ${JSON.stringify(line)} (utf16 col=${engCur.col}): eb.col=${ebCur.col} expected=${expCol}`,
          );
        }
      }
    }
  });
});

describe("Fix 3: per-line highlights and frame-throttled highlighting for large Buffers", () => {
  const same = (a: { toInts(): number[] }, b: { toInts(): number[] }) => expect(a.toInts()).toEqual(b.toInts());

  test("SYNC_HIGHLIGHT_MAX_CHARS is exported and equals 50_000", async () => {
    const mod = await import("./VimTextarea");
    expect((mod as any).SYNC_HIGHLIGHT_MAX_CHARS).toBe(50_000);
  });

  test("typing one character in a 3,000-line Buffer adds highlights for at most a handful of lines and keeps colours below", async () => {
    const lines = Array.from(
      { length: 3_000 },
      (_, i) => `select col_${i}, 'str_${i}', ${i} from table_${i};`,
    );
    await open({ text: lines.join("\n") });
    await app.advance(16);
    const eb = (handle.buffer as any).textarea.editBuffer;

    const addedRows = new Set<number>();
    const origAdd = eb.addHighlight.bind(eb);
    eb.addHighlight = (lineIdx: number, hl: any) => {
      addedRows.add(lineIdx);
      return origAdd(lineIdx, hl);
    };

    for (const k of parseKeys("is")) handle.feed(k);
    // Above 50,000 chars: key handler does not tokenize synchronously
    expect(addedRows.size).toBe(0);
    await app.advance(16);
    expect(addedRows.size).toBeGreaterThan(0);
    expect(addedRows.size).toBeLessThanOrEqual(5);

    same(spanWith(app.spans(), "sselect")!.fg, app.api.theme.color("text"));
    same(spanWith(app.spans(), "from")!.fg, app.api.theme.color("syntaxKeyword"));
    // Check a line far below
    for (const k of parseKeys("<Esc>G")) handle.feed(k);
    await app.settle();
    same(spanWith(app.spans(), "'str_2999'")!.fg, app.api.theme.color("syntaxString"));
    same(spanWith(app.spans(), "from")!.fg, app.api.theme.color("syntaxKeyword"));
  });

  test("opening a string on line 10 re-colours the lines below, and inserting/deleting a line in the middle keeps colours below", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `select ${i} from t_${i};`);
    await open({ text: lines.join("\n") });
    const eb = (handle.buffer as any).textarea.editBuffer;
    const strStyleId = app.api.theme.syntax().resolveStyleId("string")!;
    const kwStyleId = app.api.theme.syntax().resolveStyleId("keyword")!;

    expect(eb.getLineHighlights(20)[0]?.styleId).toBe(kwStyleId);

    // Go to line 10 (row 9) and type a single quote
    for (const k of parseKeys("10GI'<Esc>")) handle.feed(k);
    await app.settle();
    expect(eb.getLineHighlights(20)).toEqual([{ start: 0, end: lines[20]!.length, styleId: strStyleId, priority: 0, hlRef: 0 }]);

    // Undo the quote: line 20 returns to keyword + number + keyword
    handle.feed(parseKeys("u")[0]!);
    await app.settle();
    expect(eb.getLineHighlights(20)[0]?.styleId).toBe(kwStyleId);

    // Insert a line in the middle (row 10) and delete it
    const hl25Before = eb.getLineHighlights(25);
    for (const k of parseKeys("11Go-- comment<Esc>")) handle.feed(k);
    await app.settle();
    expect(eb.getLineHighlights(26)).toEqual(hl25Before);

    for (const k of parseKeys("dd")) handle.feed(k);
    await app.settle();
    expect(eb.getLineHighlights(25)).toEqual(hl25Before);
  });

  test("above SYNC_HIGHLIGHT_MAX_CHARS, several keys in one frame trigger exactly one highlight pass", async () => {
    const bigText = ("select 1, 'hello', 42 from users where id = 1;\n").repeat(1200);
    expect(bigText.length).toBeGreaterThan(50_000);
    await open({ text: bigText });
    await app.advance(16);

    const eb = (handle.buffer as any).textarea.editBuffer;
    let clearOrAddCalls = 0;
    const origClearLine = eb.clearLineHighlights.bind(eb);
    eb.clearLineHighlights = (r: number) => {
      clearOrAddCalls++;
      return origClearLine(r);
    };

    for (const k of parseKeys("iabcde<Esc>")) {
      handle.feed(k);
    }
    // No highlight pass ran during the key handlers
    expect(clearOrAddCalls).toBe(0);

    // Advance one frame: exactly one pass updates row 0
    await app.advance(16);
    expect(clearOrAddCalls).toBe(1);
  });

  test("property test: after each of 300 random edits on a 400-line SQL text, per-line highlights equal a from-scratch computation", async () => {
    const initialLines = Array.from(
      { length: 400 },
      (_, i) => `select col_${i}, 'val_${i}', ${i} from tbl_${i} where id = ${i}; -- note ${i}`,
    );
    await open({ text: initialLines.join("\n") });
    const eb = (handle.buffer as any).textarea.editBuffer;

    const { highlightSql } = await import("../../../core/sql/highlight");
    const { spansByLine } = await import("./line-spans");
    const { toBufferCol, isAsciiPrintable } = await import("./edit-buffer-text");

    let seed = 0x300400 >>> 0;
    const nextInt = (max: number) => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) % max;
    };

    const actions = [
      "j", "k", "5j", "5k", "w", "b", "x", "dw", "dd", "yy", "p",
      "iselect <Esc>", "a'x'<Esc>", "o-- new line<Esc>", "J", "u", "<C-r>",
    ].map((s) => parseKeys(s));

    for (let step = 0; step < 300; step++) {
      const seq = actions[nextInt(actions.length)]!;
      for (const k of seq) handle.feed(k);

      const fullText = handle.text();
      const syntax = app.api.theme.syntax();
      const rawSpans = highlightSql(fullText);
      const pieces = spansByLine(fullText, rawSpans);
      const lineCount = handle.buffer.lineCount();
      const expectedByRow: Array<Array<{ start: number; end: number; styleId: number; priority: number }>> = Array.from(
        { length: lineCount },
        () => [],
      );
      for (const p of pieces) {
        if (p.role === "text") continue;
        const styleId = syntax.resolveStyleId(p.role);
        if (styleId === null || styleId === undefined) continue;
        const lineText = handle.buffer.line(p.row);
        const ascii = isAsciiPrintable(lineText);
        const start = toBufferCol(eb, lineText, p.start, ascii);
        const end = toBufferCol(eb, lineText, p.end, ascii);
        if (end > start) {
          expectedByRow[p.row]!.push({ start, end, styleId, priority: 0 });
        }
      }

      for (let r = 0; r < lineCount; r++) {
        const actual = eb.getLineHighlights(r).map((h: any) => ({
          start: h.start,
          end: h.end,
          styleId: h.styleId,
          priority: h.priority ?? 0,
        }));
        if (JSON.stringify(actual) !== JSON.stringify(expectedByRow[r])) {
          throw new Error(
            `Highlight mismatch at step ${step}, row ${r}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expectedByRow[r])}`,
          );
        }
      }
    }
  });

  test("pinning: on a line with an emoji, a CJK character, a tab and a combining mark before the cursor, the cursor cell, search match, visual selection and yank flash are on the right cells, also after an edit, an undo and a Theme switch", async () => {
    const initialLine = "\t/* 😀 世 e\u0301 */ select 42";
    app = await mount({
      animations: true,
      ui: () => (
        <VimTextarea
          language="sql"
          initialText={initialLine}
          active
          onReady={(h) => (handle = h)}
        />
      ),
    });
    const eb = (handle.buffer as any).textarea.editBuffer;

    const verifyState = async (prefixText: string) => {
      const prefixCells = eb.measureText(prefixText);

      // 1. Search match highlight on "select" (6 cells)
      handle.engine.search("select", 1);
      await app.settle();
      // Cursor lands on 's' of "select"
      expect(eb.getCursorPosition()).toMatchObject({ row: 0, col: prefixCells });
      same(spanWith(app.spans(), "select")!.bg, app.api.theme.color("warning"));
      const searchHl = eb.getLineHighlights(0).find((h: any) => h.priority === 1);
      expect(searchHl).toMatchObject({ start: prefixCells, end: prefixCells + 6 });
      handle.engine.clearSearch();
      await app.settle();

      // 2. Visual selection on "select"
      for (const k of parseKeys("ve")) handle.feed(k);
      await app.settle();
      expect(eb.getCursorPosition()).toMatchObject({ row: 0, col: prefixCells + 5 });
      same(spanWith(app.spans(), "select")!.bg, app.api.theme.color("selection"));
      handle.feed(parseKeys("<Esc>")[0]!);
      await app.settle();

      // 3. Yank flash on "select"
      for (const k of parseKeys("0fsyw")) handle.feed(k);
      await app.settle();
      expect(eb.getCursorPosition()).toMatchObject({ row: 0, col: prefixCells });
      same(spanWith(app.spans(), "select")!.bg, app.api.theme.color("selection"));
      const flashHl = eb.getLineHighlights(0).find((h: any) => h.priority === 1);
      expect(flashHl).toMatchObject({ start: prefixCells, end: prefixCells + 7 });
      await app.advance(200);
      expect(eb.getLineHighlights(0).find((h: any) => h.priority === 1)).toBeUndefined();
      same(spanWith(app.spans(), "select")!.fg, app.api.theme.color("syntaxKeyword"));
    };

    // Initial check
    await verifyState("\t/* 😀 世 e\u0301 */ ");

    // After an edit before "select" (insert "X" at start of line)
    for (const k of parseKeys("0iX<Esc>")) handle.feed(k);
    await app.settle();
    await verifyState("X\t/* 😀 世 e\u0301 */ ");

    // After an undo
    handle.feed(parseKeys("u")[0]!);
    await app.settle();
    expect(handle.text()).toBe(initialLine);
    await verifyState("\t/* 😀 世 e\u0301 */ ");

    // After a Theme switch
    await app.api.theme.select("nord");
    await app.advance(200);
    await app.settle();
    await verifyState("\t/* 😀 世 e\u0301 */ ");
  });

  test("Fix 3 (round 2): in a 5,000-line non-plain Buffer, one typed character converts columns only for the changed lines, and 300 random edits on mixed plain/non-plain lines equal from-scratch highlights", async () => {
    const ebMod = await import("./edit-buffer-text");
    const nonPlainLines = Array.from(
      { length: 5_000 },
      (_, i) => `select /* 世界 😀 */ col_${i}, 'str_${i}', ${i} from table_${i};`,
    );
    await open({ text: nonPlainLines.join("\n") });
    await app.advance(16);

    for (const k of parseKeys("is")) handle.feed(k);
    ebMod.resetToBufferColConversions();

    const tPass0 = performance.now();
    await app.advance(16);
    const passMs = performance.now() - tPass0;
    const conversions = ebMod.getToBufferColConversions();
    void passMs;
    // Row 0 has ~7 pieces (2 endpoints each = ~14 conversions), bounded by changed lines (not 5,000 lines!)
    expect(conversions).toBeGreaterThan(0);
    expect(conversions).toBeLessThanOrEqual(40);

    // Now test 300 random edits on a Buffer mixing plain and non-plain lines
    const mixedLines = Array.from({ length: 120 }, (_, i) =>
      i % 2 === 0
        ? `select col_${i}, 'val_${i}', ${i} from tbl_${i};`
        : `select /* 世界 😀 e\u0301 */ col_${i}, '값_${i}', ${i} from tbl_${i};`,
    );
    handle.setText(mixedLines.join("\n"));
    await app.settle();

    const eb = (handle.buffer as any).textarea.editBuffer;
    const { highlightSql } = await import("../../../core/sql/highlight");
    const { spansByLine } = await import("./line-spans");
    const { toBufferCol, isAsciiPrintable } = ebMod;

    let seed = 0x50002026 >>> 0;
    const nextInt = (max: number) => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) % max;
    };

    const actions = [
      "j", "k", "5j", "5k", "w", "b", "x", "dw", "dd", "yy", "p",
      "iselect <Esc>", "a'x'<Esc>", "o-- 世界 😀<Esc>", "J", "u", "<C-r>",
    ].map((s) => parseKeys(s));

    for (let step = 0; step < 300; step++) {
      const seq = actions[nextInt(actions.length)]!;
      for (const k of seq) handle.feed(k);

      const fullText = handle.text();
      const syntax = app.api.theme.syntax();
      const rawSpans = highlightSql(fullText);
      const pieces = spansByLine(fullText, rawSpans);
      const lineCount = handle.buffer.lineCount();
      const expectedByRow: Array<Array<{ start: number; end: number; styleId: number; priority: number }>> = Array.from(
        { length: lineCount },
        () => [],
      );
      for (const p of pieces) {
        if (p.role === "text") continue;
        const styleId = syntax.resolveStyleId(p.role);
        if (styleId === null || styleId === undefined) continue;
        const lineText = handle.buffer.line(p.row);
        const ascii = isAsciiPrintable(lineText);
        const start = toBufferCol(eb, lineText, p.start, ascii);
        const end = toBufferCol(eb, lineText, p.end, ascii);
        if (end > start) {
          expectedByRow[p.row]!.push({ start, end, styleId, priority: 0 });
        }
      }

      for (let r = 0; r < lineCount; r++) {
        const actual = eb.getLineHighlights(r).map((h: any) => ({
          start: h.start,
          end: h.end,
          styleId: h.styleId,
          priority: h.priority ?? 0,
        }));
        if (JSON.stringify(actual) !== JSON.stringify(expectedByRow[r])) {
          throw new Error(
            `Mixed highlight mismatch at step ${step}, row ${r}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expectedByRow[r])}`,
          );
        }
      }
    }
  });
});

describe("clipboard copy failure reporting in VimTextarea", () => {
  test("a failed copy says Could not copy: <reason> on the status line and does not flash", async () => {
    app = await mount({
      animations: true,
      deps: {
        write: () => {
          throw new Error("terminal write failed");
        },
        which: (bin) => (bin === "wl-copy" ? "/usr/bin/wl-copy" : null),
        exec: async () => ({
          code: 1,
          stdout: "",
          stderr: "wl-copy broken\nsecond line",
          timedOut: false,
          aborted: false,
        }),
      },
      ui: () => (
        <VimTextarea
          language="sql"
          initialText="select 42"
          active
          onReady={(h) => (handle = h)}
        />
      ),
    });
    const eb = (handle.buffer as any).textarea.editBuffer;
    for (const k of parseKeys("yy")) handle.feed(k);
    await app.waitFor(() => app.api.status.message() !== null);
    expect(app.api.status.message()).toEqual({
      text: "Could not copy: wl-copy failed: wl-copy broken",
      kind: "error",
    });
    expect(eb.getLineHighlights(0).find((h: any) => h.priority === 1)).toBeUndefined();
  });

  test("a successful copy flashes and leaves the status line clear", async () => {
    app = await mount({
      animations: true,
      ui: () => (
        <VimTextarea
          language="sql"
          initialText="select 42"
          active
          onReady={(h) => (handle = h)}
        />
      ),
    });
    const eb = (handle.buffer as any).textarea.editBuffer;
    for (const k of parseKeys("yy")) handle.feed(k);
    await app.settle();
    expect(app.api.status.message()).toBeNull();
    expect(app.deps.written.length).toBe(1);
    expect(eb.getLineHighlights(0).find((h: any) => h.priority === 1)).toBeDefined();
  });
});

/** An exec whose clipboard tool fails only once `release` is called. */
function heldFailingTool(bin: string) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const calls: string[] = [];
  const exec = async (req: ExecRequest): Promise<ExecResult> => {
    calls.push(req.cmd[0]!);
    if (req.cmd[0] === `/usr/bin/${bin}`) await held;
    return { code: 1, stdout: "", stderr: `${bin} broken`, timedOut: false, aborted: false };
  };
  return { exec, calls, release: () => release() };
}

test("a failed copy that finishes after the VimTextarea is gone changes nothing", async () => {
  const [shown, setShown] = createSignal(true);
  const tool = heldFailingTool("wl-copy");
  app = await mount({
    animations: true,
    deps: {
      write: () => {
        throw new Error("terminal write failed");
      },
      which: (bin) => (bin === "wl-copy" ? "/usr/bin/wl-copy" : null),
      exec: tool.exec,
    },
    ui: () => (
      <Show when={shown()}>
        <VimTextarea language="sql" initialText="select 42" active onReady={(h) => (handle = h)} />
      </Show>
    ),
  });
  for (const k of parseKeys("yy")) handle.feed(k);
  await app.settle();
  expect(tool.calls).toEqual(["/usr/bin/wl-copy"]);
  setShown(false);
  await app.settle();
  tool.release();
  await app.settle();
  expect(app.api.status.message()).toBeNull();
});

test("a yank flashes only if the text did not change while the copy was under way", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  app = await mount({
    animations: true,
    deps: {
      which: (bin) => (bin === "wl-copy" ? "/usr/bin/wl-copy" : null),
      exec: async () => {
        await held;
        return { code: 0, stdout: "", stderr: "", timedOut: false, aborted: false };
      },
    },
    ui: () => <VimTextarea language="sql" initialText={"select 42\nselect 7"} active onReady={(h) => (handle = h)} />,
  });
  const eb = (handle.buffer as any).textarea.editBuffer;
  for (const k of parseKeys("jyy")) handle.feed(k);
  handle.setText("x");
  release();
  await app.settle();
  expect(app.api.status.message()).toBeNull();
  expect(eb.getLineHighlights(0).find((h: any) => h.priority === 1)).toBeUndefined();
  expect(eb.getLineHighlights(1).find((h: any) => h.priority === 1)).toBeUndefined();
});
