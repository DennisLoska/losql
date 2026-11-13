import { afterEach, describe, expect, test } from "bun:test";
import { MemoryBuffer, type Position } from "../../../core/vim/buffer";
import { VimEngine } from "../../../core/vim/engine";
import { type Key, parseKeys } from "../../../core/vim/keys";
import { mount, type TestApp } from "../../testing";
import { fromBufferCol, toBufferCol } from "./edit-buffer-text";
import { VimTextarea, type VimTextareaHandle } from "./VimTextarea";

let app: TestApp;
let handle: VimTextareaHandle;
afterEach(async () => {
  await app?.dispose();
});

async function open(initialText = "") {
  app = await mount({
    ui: () => (
      <VimTextarea
        language="sql"
        initialText={initialText}
        active
        onReady={(h) => (handle = h)}
      />
    ),
  });
}

function getEditBuffer(h: VimTextareaHandle): any {
  return (h.buffer as any).textarea.editBuffer;
}

function realCursorInEngineUnit(h: VimTextareaHandle): Position {
  const eb = getEditBuffer(h);
  const { row, col } = eb.getCursorPosition();
  const lineText = h.buffer.line(row);
  return {
    row,
    col: fromBufferCol(eb, row, lineText, col),
  };
}

function formatKey(k: Key): string {
  const mods = `${k.ctrl ? "C-" : ""}${k.meta ? "M-" : ""}${k.shift && (!k.text || k.text.length !== 1) ? "S-" : ""}`;
  if (k.text && k.text.length > 0 && !k.ctrl && !k.meta) {
    if (k.text === " ") return "<Space>";
    return k.text;
  }
  return `<${mods}${k.name}>`;
}

function compareState(
  h: VimTextareaHandle,
  refEngine: VimEngine,
  refBuffer: MemoryBuffer,
): string | null {
  const editorText = h.text();
  const eb = getEditBuffer(h);
  const ebText = eb.getText();
  const refText = refBuffer.text();

  if (editorText !== refText) {
    return `text mismatch: editor=${JSON.stringify(editorText)} vs ref=${JSON.stringify(refText)}`;
  }
  if (ebText !== refText) {
    return `editBuffer.getText() mismatch: eb=${JSON.stringify(ebText)} vs ref=${JSON.stringify(refText)}`;
  }

  const editorMode = h.engine.mode;
  const refMode = refEngine.mode;
  if (editorMode !== refMode) {
    return `mode mismatch: editor=${editorMode} vs ref=${refMode}`;
  }

  const editorCur = h.buffer.cursor();
  const refCur = refBuffer.cursor();
  if (editorCur.row !== refCur.row || editorCur.col !== refCur.col) {
    return `buffer.cursor() mismatch: editor=${JSON.stringify(editorCur)} vs ref=${JSON.stringify(refCur)} (text=${JSON.stringify(refText)})`;
  }

  const ebCur = eb.getCursorPosition();
  const lineText = h.buffer.line(refCur.row);
  const expectedBufCol = toBufferCol(eb, lineText, refCur.col);
  if (ebCur.row !== refCur.row || ebCur.col !== expectedBufCol) {
    const converted = realCursorInEngineUnit(h);
    return `real editBuffer cursor mismatch: eb=(${ebCur.row},${ebCur.col}) [utf16=${converted.col}] vs expected eb=(${refCur.row},${expectedBufCol}) [ref utf16=${refCur.col}] on line ${JSON.stringify(lineText)}`;
  }

  return null;
}

function runSequenceAndCompare(
  h: VimTextareaHandle,
  text: string,
  keys: readonly Key[],
): { ok: true } | { ok: false; step: number; prefix: Key[]; reason: string } {
  h.setText(text);
  const refBuffer = new MemoryBuffer(text);
  const textarea = (h.buffer as any).textarea;
  const refEngine = new VimEngine(refBuffer, {
    pageSize: () => Math.max(1, textarea.height || 20),
  });

  const initDiff = compareState(h, refEngine, refBuffer);
  if (initDiff) {
    return { ok: false, step: 0, prefix: [], reason: `initial state: ${initDiff}` };
  }

  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    h.feed(k);
    refEngine.feed(k);
    const diff = compareState(h, refEngine, refBuffer);
    if (diff) {
      return {
        ok: false,
        step: i + 1,
        prefix: keys.slice(0, i + 1),
        reason: diff,
      };
    }
  }
  return { ok: true };
}

describe("Fix 1 differential test: Editor vs VimEngine over MemoryBuffer", () => {
  test("reproduced table cases from the brief", async () => {
    await open();

    const cases: Array<{
      text: string;
      keys: string;
      expectedText: string;
      expectedCol: number;
    }> = [
      { text: "世界 abc", keys: "x", expectedText: "界 abc", expectedCol: 0 },
      { text: "世界 abc", keys: "xx", expectedText: " abc", expectedCol: 0 },
      { text: "世界 abc", keys: "lx", expectedText: "世 abc", expectedCol: 1 },
      { text: "世界 abc", keys: "xix<Esc>", expectedText: "x界 abc", expectedCol: 0 },
      { text: "a🇺🇸b", keys: "x", expectedText: "🇺🇸b", expectedCol: 0 },
      { text: "plain abc", keys: "x", expectedText: "lain abc", expectedCol: 0 },
    ];

    for (const c of cases) {
      const parsed = parseKeys(c.keys);
      const res = runSequenceAndCompare(handle, c.text, parsed);
      if (!res.ok) {
        throw new Error(
          `Table case failed for text=${JSON.stringify(c.text)} keys=${JSON.stringify(c.keys)} at step ${res.step} (${res.prefix.map(formatKey).join("")}): ${res.reason}`,
        );
      }
      expect(handle.text()).toBe(c.expectedText);
      expect(handle.buffer.cursor().col).toBe(c.expectedCol);
      expect(realCursorInEngineUnit(handle).col).toBe(c.expectedCol);
    }
  });

  const MATRIX_TEXTS: readonly string[] = [
    "世界 abc",
    "a🇺🇸b",
    "foo 😀 bar",
    "e\u0301tude",
    "a\u200bb c\u200bd",
    "한글 테스트 abc",
    "plain abc",
    "",
    "plain first\n世界 second 😀\ne\u0301tude third",
    "x".repeat(150) + "😀" + "y".repeat(150),
  ];

  const MATRIX_SEQUENCES: readonly string[] = [
    "x",
    "xx",
    "lx",
    "$x",
    "X",
    "<Del>",
    "xp",
    "xu",
    "xx.",
    "wx",
    "dw",
    "dd",
    "D",
    "cwZ<Esc>",
    "rZ",
    "~",
    "J",
    "ix<Esc>",
    "ax<Esc>",
    "Ax<Esc>",
    "ox<Esc>",
    "Ox<Esc>",
    "yyp",
    "yyP",
    "vjd",
    "vly",
    "u",
    "<C-r>",
    ">>",
    "<<",
    "ciwQ<Esc>",
    "3x",
    "2dd",
    "i<BS><Esc>",
    "i<CR><Esc>",
  ];

  test("matrix: texts × key sequences compared after every single key", async () => {
    await open();

    const failures: string[] = [];
    for (const text of MATRIX_TEXTS) {
      for (const seqStr of MATRIX_SEQUENCES) {
        const keys = parseKeys(seqStr);
        const res = runSequenceAndCompare(handle, text, keys);
        if (!res.ok) {
          failures.push(
            `text=${JSON.stringify(text.length > 40 ? text.slice(0, 40) + "…" : text)} seq=${JSON.stringify(seqStr)} failed at key #${res.step} (${res.prefix.map(formatKey).join("")}): ${res.reason}`,
          );
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `Matrix had ${failures.length} differences:\n` + failures.slice(0, 15).join("\n"),
      );
    }
  });

  test("30 seeded random runs of 1,500 keys each compared after every key", async () => {
    await open();

    const motionStrs = [
      "h",
      "j",
      "k",
      "l",
      "w",
      "b",
      "e",
      "0",
      "^",
      "$",
      "gg",
      "G",
      "%",
      "{",
      "}",
      ";",
      ",",
      "fa",
      "fb",
      "f ",
      "f世",
      "f😀",
      "Fe",
      "ta",
      "tb",
      "t ",
      "Ta",
      "W",
      "B",
      "E",
      "i",
      "a",
      "I",
      "A",
      "o",
      "O",
      "v",
      "V",
      "d",
      "c",
      "y",
      "p",
      "P",
      "s",
      "S",
      "C",
      "D",
      "<Esc>",
      "<BS>",
      "<Del>",
      "<CR>",
      "<Tab>",
      "<Left>",
      "<Right>",
      "<Up>",
      "<Down>",
      "<Home>",
      "<End>",
      "<C-w>",
      "<C-u>",
      "<C-d>",
      ".",
      "Z",
      "Q",
      " ",
      "世",
      "😀",
      "\u0301",
      "\u200b",
    ];

    const alphabetStrs = [...MATRIX_SEQUENCES, ...motionStrs];
    const alphabet: Key[][] = alphabetStrs.map((s) => {
      if (s === "世" || s === "😀" || s === "\u0301" || s === "\u200b") {
        return [{ name: s, text: s }];
      }
      return parseKeys(s);
    });

    for (let run = 0; run < 30; run++) {
      const seed = (0x20261112 + run * 0x9e3779b9) >>> 0;
      let rngState = seed;
      const nextU32 = () => {
        rngState = (rngState + 0x6d2b79f5) >>> 0;
        let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return (t ^ (t >>> 14)) >>> 0;
      };

      const initialText = MATRIX_TEXTS[run % MATRIX_TEXTS.length]!;
      const keys: Key[] = [];
      while (keys.length < 1_500) {
        const chunk = alphabet[nextU32() % alphabet.length]!;
        for (const k of chunk) {
          if (keys.length >= 1_500) break;
          keys.push(k);
        }
      }

      const res = runSequenceAndCompare(handle, initialText, keys);
      if (!res.ok) {
        const prefixNotation = res.prefix.map(formatKey).join("");
        throw new Error(
          `Random run #${run} (seed=0x${seed.toString(16)}) on text=${JSON.stringify(initialText)} failed at key ${res.step}/1500.\nShortest prefix (${res.prefix.length} keys): ${prefixNotation}\nReason: ${res.reason}`,
        );
      }
    }
  });
});
