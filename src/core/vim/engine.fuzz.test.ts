import { describe, expect, test } from "bun:test";
import { MemoryBuffer } from "./buffer";
import { VimEngine } from "./engine";
import { type Key, parseKeys } from "./keys";
import { sqlStatementRange } from "./sql";

function makePrng(seed: number) {
  let state = seed >>> 0;
  return {
    nextU32(): number {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (t ^ (t >>> 14)) >>> 0;
    },
    int(max: number): number {
      return this.nextU32() % max;
    },
    pick<T>(arr: readonly T[]): T {
      return arr[this.int(arr.length)]!;
    },
  };
}

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

function isOnSecondSurrogateUnit(line: string, col: number): boolean {
  if (col <= 0 || col >= line.length) return false;
  const low = line.charCodeAt(col);
  const high = line.charCodeAt(col - 1);
  return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
}

const INITIAL_TEXTS = [
  "",
  "select \t a\u0301, 😀 from t;\n\n  where (x = 'a' and [y] = {1});",
  "\tfoo(bar, \"baz\")\n\n😀\n  `qux`;",
  "a\n\nb\t😀\nc\u0301d",
  "  ( [ { 'x' \"y\" `z` } ] )  ",
];

type FuzzStep =
  | { kind: "key"; key: Key; label: string }
  | { kind: "search"; pattern: string; dir: 1 | -1; label: string }
  | { kind: "clearSearch"; label: string }
  | { kind: "edit"; text: string; r1: number; c1: number; r2: number; c2: number; label: string };

function buildKeyPool(): Array<{ keys: Key[]; label: string }> {
  const notations = [
    // counts
    "1", "2", "3", "5", "9", "0",
    // registers
    '"a', '"b', '"0', '"+', '"_', '""',
    // operators
    "d", "c", "y", ">", "<",
    "dd", "cc", "yy", ">>", "<<", "D", "C", "S", "Y",
    // motions
    "h", "j", "k", "l", "w", "W", "b", "B", "e", "E",
    "h", "j", "k", "l", "w", "W", "b", "B", "e", "E",
    "h", "j", "k", "l", "w", "W", "b", "B", "e", "E",
    "0", "^", "$", "gg", "G", "%", "{", "}", ";", ",",
    "0", "^", "$", "gg", "G", "%", "{", "}", ";", ",",
    "<Left>", "<Right>", "<Up>", "<Down>", "<Home>", "<End>", "<C-d>", "<C-u>",
    // find motions
    "fa", "f😀", "f(", "Fa", "ta", "Ta", "f\t", "f ",
    // text objects
    "iw", "aw", "iW", "aW", 'i"', 'a"', "i'", "a'", "i`", "a`",
    "i(", "a(", "i)", "ib", "ab", "i[", "a[", "i{", "a{", "iB", "aB",
    "ip", "ap", "is", "as",
    // visual modes
    "v", "v", "v", "v", "v", "v", "v", "v", "v", "v",
    "v", "v", "v", "v", "v", "v", "v", "v", "v", "v",
    "V", "V", "V", "V", "V", "V", "V", "V", "V", "V",
    "o", "o", "o", "o",
    // single-key normal edits
    "x", "X", "s", "~", "J", "p", "P", "rX", "ra", "r<Esc>", "<Del>",
    "x", "X", "~", "J", "p", "P",
    // insert sessions & keys (Esc heavily weighted so insert sessions exit quickly)
    "i", "a", "I", "A", "o", "O",
    "<Esc>", "<Esc>", "<Esc>", "<Esc>", "<Esc>", "<Esc>", "<Esc>", "<Esc>",
    "<Esc>", "<Esc>", "<Esc>", "<Esc>", "<Esc>", "<Esc>", "<Esc>", "<Esc>",
    "<Esc>", "<Esc>", "<Esc>", "<Esc>", "<Esc>", "<Esc>", "<Esc>", "<Esc>",
    "<Esc>", "<Esc>", "<Esc>", "<Esc>", "<Esc>", "<Esc>", "<Esc>", "<Esc>",
    "<Esc>", "<Esc>", "<Esc>", "<Esc>", "<Esc>", "<Esc>", "<Esc>", "<Esc>",
    "<Esc>", "<Esc>", "<Esc>", "<Esc>", "<Esc>", "<Esc>",
    "<C-[>", "<C-[>", "<C-[>", "<C-[>", "<C-[>", "<C-[>", "<C-[>", "<C-[>",
    "<C-c>", "<C-c>", "<C-c>", "<C-c>", "<C-c>", "<C-c>", "<C-c>", "<C-c>",
    "<BS>", "<CR>", "<Tab>", "<C-w>", "<C-u>",
    "a", "b", " ", ";", "(", ")", "'", '"',
    // undo, redo, repeat, search keys
    "u", "<C-r>", ".", "n", "N", "*", "#",
    ".", "n", "N", "*", "#",
  ];

  const pool: Array<{ keys: Key[]; label: string }> = [];
  for (const n of notations) {
    if (n === "f😀") {
      pool.push({
        keys: [{ name: "f", text: "f" }, { name: "😀", text: "😀" }],
        label: "f😀",
      });
    } else {
      pool.push({ keys: parseKeys(n), label: n });
    }
  }
  // Astral character key and combining mark key
  pool.push({ keys: [{ name: "😀", text: "😀" }], label: "😀" });
  pool.push({ keys: [{ name: "\u0301", text: "\u0301" }], label: "◌́" });
  pool.push({ keys: [{ name: "r", text: "r" }, { name: "😀", text: "😀" }], label: "r😀" });
  return pool;
}

const SEARCH_PATTERNS = ["a", "😀", "\\D+", "\\w+", "(", "^", "select", "x*", "\\S", ".*"];
const EDIT_TEXTS = ["", "X", "😀", "a\nb", "\t", "a\u0301", "😀\n\t😀"];

describe("Fix 12: seeded robustness fuzz test", () => {
  test("300 sequences of 80 keys maintain all cursor and surrogate invariants, mode shares, and undo/redo round-trip", () => {
    const SEED = 0x20261112;
    const prng = makePrng(SEED);
    const pool = buildKeyPool();
    const t0 = performance.now();

    let totalFedKeys = 0;
    let normalModeKeys = 0;
    let visualModeKeys = 0;
    let insertModeKeys = 0;

    const recordAndFeed = (engine: VimEngine, k: Key) => {
      const m = engine.mode;
      totalFedKeys++;
      if (m === "normal") normalModeKeys++;
      else if (m === "visual" || m === "visual-line") visualModeKeys++;
      else insertModeKeys++;
      engine.feed(k);
    };

    for (let seqIdx = 0; seqIdx < 300; seqIdx++) {
      const initialText = prng.pick(INITIAL_TEXTS);
      const buffer = new MemoryBuffer(initialText);
      const engine = new VimEngine(buffer, {
        statementRange: sqlStatementRange(buffer),
        pageSize: () => 6,
      });

      const history: string[] = [];
      let keyCount = 0;

      const checkInvariants = (stepDesc: string) => {
        const text = buffer.text();
        if (hasLoneSurrogate(text)) {
          throw new Error(
            `Lone surrogate in text at seq ${seqIdx} (seed=${SEED}) after [${history.join(" ")}] (${stepDesc}): ${JSON.stringify(text)}`,
          );
        }
        const cur = buffer.cursor();
        const lineCount = buffer.lineCount();
        if (cur.row < 0 || cur.row >= lineCount) {
          throw new Error(
            `Cursor row out of bounds (${cur.row}/${lineCount}) at seq ${seqIdx} (seed=${SEED}) after [${history.join(" ")}]`,
          );
        }
        const line = buffer.line(cur.row);
        if (engine.mode === "insert") {
          if (cur.col < 0 || cur.col > line.length) {
            throw new Error(
              `Insert cursor col out of bounds (${cur.col}/${line.length}) at seq ${seqIdx} (seed=${SEED}) after [${history.join(" ")}]`,
            );
          }
        } else {
          const maxNormalCol = line.length === 0 ? 0 : line.length - 1;
          if (cur.col < 0 || cur.col > maxNormalCol) {
            throw new Error(
              `Normal/visual cursor col out of bounds (${cur.col}/${maxNormalCol}, mode=${engine.mode}) at seq ${seqIdx} (seed=${SEED}) after [${history.join(" ")}]`,
            );
          }
        }
        if (isOnSecondSurrogateUnit(line, cur.col)) {
          throw new Error(
            `Cursor on second unit of surrogate pair (row=${cur.row}, col=${cur.col}, line=${JSON.stringify(line)}) at seq ${seqIdx} (seed=${SEED}) after [${history.join(" ")}]`,
          );
        }
      };

      checkInvariants("init");

      while (keyCount < 80) {
        const roll = prng.int(22);
        if (roll === 0) {
          const pat = prng.pick(SEARCH_PATTERNS);
          const dir = prng.int(2) === 0 ? 1 : -1;
          const label = `search(${JSON.stringify(pat)},${dir})`;
          history.push(label);
          engine.search(pat, dir);
          engine.searchMatches();
          keyCount++;
          checkInvariants(label);
        } else if (roll === 1) {
          const label = "clearSearch()";
          history.push(label);
          engine.clearSearch();
          keyCount++;
          checkInvariants(label);
        } else if (roll === 2) {
          const txt = prng.pick(EDIT_TEXTS);
          const r1 = prng.int(5) - 1;
          const c1 = prng.int(12) - 1;
          const r2 = prng.int(5) - 1;
          const c2 = prng.int(12) - 1;
          const label = `edit({${r1},${c1}}..{${r2},${c2}},${JSON.stringify(txt)})`;
          history.push(label);
          engine.edit({ start: { row: r1, col: c1 }, end: { row: r2, col: c2 } }, txt);
          keyCount++;
          checkInvariants(label);
        } else if (roll === 3) {
          const label = "enterInsert()";
          history.push(label);
          engine.enterInsert();
          keyCount++;
          checkInvariants(label);
        } else if (roll === 4) {
          // External cursor placement (possibly targeting the 2nd unit of a surrogate pair or out of bounds)
          const r = prng.int(buffer.lineCount() + 2) - 1;
          const c = prng.int(15) - 1;
          buffer.setCursor({ row: r, col: c });
          const item = prng.pick(pool);
          const k = item.keys[0]!;
          const label = `setCursor(${r},${c})+${item.label}`;
          history.push(label);
          recordAndFeed(engine, k);
          keyCount++;
          checkInvariants(label);
        } else {
          const item = prng.pick(pool);
          for (const k of item.keys) {
            if (keyCount >= 80) break;
            history.push(item.label);
            recordAndFeed(engine, k);
            keyCount++;
            checkInvariants(item.label);
          }
        }
      }

      // Leave insert/visual mode cleanly so any open insert session is committed to undo
      engine.feed({ name: "escape" });
      engine.feed({ name: "escape" });
      checkInvariants("final-<Esc>");

      const finalText = buffer.text();

      // Undo everything
      for (let i = 0; i < 200; i++) {
        engine.feed({ name: "u", text: "u" });
        checkInvariants("undo-all");
      }

      if (buffer.text() !== initialText) {
        throw new Error(
          `Undo-all mismatch at seq ${seqIdx} (seed=${SEED}) after [${history.join(" ")}]: expected initial ${JSON.stringify(initialText)}, got ${JSON.stringify(buffer.text())}`,
        );
      }

      // Redo everything
      for (let i = 0; i < 200; i++) {
        engine.feed({ name: "r", ctrl: true });
        checkInvariants("redo-all");
      }

      if (buffer.text() !== finalText) {
        throw new Error(
          `Undo/redo round-trip mismatch at seq ${seqIdx} (seed=${SEED}) after [${history.join(" ")}]: expected ${JSON.stringify(finalText)}, got ${JSON.stringify(buffer.text())}`,
        );
      }
    }

    const normalShare = normalModeKeys / totalFedKeys;
    const visualShare = visualModeKeys / totalFedKeys;
    expect(normalShare).toBeGreaterThanOrEqual(0.4);
    expect(visualShare).toBeGreaterThanOrEqual(0.1);

    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(1000);
  });
});
