import { afterEach, describe, expect, test } from "bun:test";
import { measureEditText, type WidthMethod } from "@opentui/core";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { cellStats, cellWidth, cutCells, fitCells, setWidthMethod, widthMethod } from "./cells";

const TABLE = [
  "مَرْحَبًا",
  "שָׁלוֹם",
  "한국어".normalize("NFD"),
  "co­op­erate",
  "a\ud800b",
  "각",
  "👍🏽",
  "🇩🇪",
  "👨‍👩‍👧",
  "日本語",
  "é",
  "é",
  "1️⃣",
  "plain ascii",
];

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const clustersOf = (s: string) => Array.from(segmenter.segment(s), (x) => x.segment);

/** A small deterministic generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  "a", "b", "Z", "0", " ", "-", "~", ".",
  "م", "َ", "ْ", "ح", "ً", "ש", "ָ", "ׁ", "ו", "ֹ",
  "ᄒ", "ᅡ", "ᆫ", "ᄀ", "ᅮ", "ᆨ",
  "­", "\ud800", "\udfff", "​", "‍", "️", "︎", "́",
  "👍", "\u{1f3fd}", "🇩", "🇪", "👨", "👩", "👧", "1️⃣", "🏴\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}",
  "日", "本", "語", "é", "क", "्", "ष", "ก", "ั", "้", "မ", "ြ", "္", "ក", "្", "ස", "්",
  "�", "…", "∅", "↵",
];

function randomTexts(count: number, seed: number): string[] {
  const next = rng(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const n = Math.floor(next() * 24);
    let s = "";
    for (let j = 0; j < n; j++) s += PIECES[Math.floor(next() * PIECES.length)]!;
    out.push(s);
  }
  return out;
}

const METHODS: WidthMethod[] = ["unicode", "wcwidth"];
const RANDOM = randomTexts(5000, 18);

let saved: WidthMethod = widthMethod();
afterEach(() => setWidthMethod(saved));

describe("cellWidth", () => {
  test("is unicode until the renderer sets a method", () => {
    expect(saved).toBe("unicode");
  });

  for (const method of METHODS) {
    test(`equals the renderer's measure under ${method}`, () => {
      saved = widthMethod();
      setWidthMethod(method);
      for (const text of [...TABLE, ...RANDOM]) {
        expect([text, cellWidth(text)]).toEqual([text, measureEditText(text, { widthMethod: method })]);
      }
    });
  }

  test("the table of texts on which Bun.stringWidth and the renderer differ", () => {
    saved = widthMethod();
    setWidthMethod("unicode");
    expect(TABLE.slice(0, 6).map(cellWidth)).toEqual([5, 4, 6, 11, 3, 2]);
  });

  test("printable ASCII is its length without a library call", () => {
    const before = cellStats().measured;
    expect(cellWidth("hello, world")).toBe(12);
    expect(cellWidth("")).toBe(0);
    expect(cellStats().measured).toBe(before);
  });

  test("the cache is bounded and is cleared when the method changes", () => {
    saved = widthMethod();
    setWidthMethod("unicode");
    for (const text of RANDOM) for (const c of clustersOf(text)) cellWidth(c);
    for (let i = 0; i < 20_000; i++) cellWidth(String.fromCodePoint(0x4e00 + i));
    expect(cellStats().cached).toBeLessThanOrEqual(cellStats().cacheLimit);
    setWidthMethod("wcwidth");
    expect(cellStats().cached).toBe(0);
    expect(cellWidth("👍🏽")).toBe(measureEditText("👍🏽", { widthMethod: "wcwidth" }));
  });
});

describe("cluster widths and the width of the whole text", () => {
  for (const method of METHODS) {
    test(`under ${method} (reported, not required)`, () => {
      saved = widthMethod();
      setWidthMethod(method);
      let differ = 0;
      for (const text of RANDOM) {
        const sum = clustersOf(text).reduce((a, c) => a + measureEditText(c, { widthMethod: method }), 0);
        if (sum !== measureEditText(text, { widthMethod: method })) differ++;
      }
      console.log(`cluster widths add up under ${method}: ${RANDOM.length - differ} of ${RANDOM.length}`);
      expect(differ).toBeGreaterThanOrEqual(0);
    });
  }
});

describe("cutCells and fitCells", () => {
  for (const method of METHODS) {
    test(`cut on cluster boundaries, never wider than the budget, longest such prefix, under ${method}`, () => {
      saved = widthMethod();
      setWidthMethod(method);
      const measure = (s: string) => measureEditText(s, { widthMethod: method });
      for (const text of [...TABLE, ...RANDOM.slice(0, 1500)]) {
        const cs = clustersOf(text);
        for (let budget = 0; budget <= 60; budget++) {
          for (const ellipsis of [false, true]) {
            const out = cutCells(text, budget, { ellipsis });
            expect(measure(out) <= budget ? "ok" : JSON.stringify({ text, budget, ellipsis, out })).toBe("ok");
            if (measure(text) <= budget) {
              expect(out).toBe(text);
              continue;
            }
            const body = ellipsis && out.endsWith("…") ? out.slice(0, -1) : out;
            // on a cluster boundary
            let k = 0;
            let acc = "";
            while (acc.length < body.length) acc += cs[k++]!;
            expect([text, budget, acc]).toEqual([text, budget, body]);
            // the next cluster would not fit
            if (ellipsis && !out.endsWith("…")) expect(out).toBe("");
            else if (k < cs.length) {
              const longer = body + cs[k]! + (ellipsis && out.endsWith("…") ? "…" : "");
              expect(measure(longer) > budget ? "ok" : JSON.stringify({ text, budget, ellipsis, out, next: cs[k] })).toBe("ok");
            }
            if (ellipsis && budget >= 1) expect(out.endsWith("…") ? "ok" : JSON.stringify({ text, budget, out })).toBe("ok");
          }
          for (const align of ["left", "right"] as const) {
            const fitted = fitCells(text, budget, align);
            expect([text, budget, align, measure(fitted)]).toEqual([text, budget, align, budget]);
          }
        }
      }
    });
  }

  test("nothing throws for budget 0, the empty text, or a cluster wider than the budget", () => {
    expect(cutCells("", 0)).toBe("");
    expect(cutCells("", 5)).toBe("");
    expect(cutCells("abc", 0, { ellipsis: true })).toBe("");
    expect(cutCells("日", 1)).toBe("");
    expect(cutCells("日本", 1, { ellipsis: true })).toBe("…");
    expect(cutCells("日本", 2, { ellipsis: true })).toBe("…");
    expect(fitCells("日本", 1, "left")).toBe("…");
    expect(fitCells("日本", 3, "left")).toBe("日…");
    expect(fitCells("日本", 2, "right")).toBe("… ");
    expect(fitCells("", 0, "right")).toBe("");
    expect(fitCells("👨‍👩‍👧", 1, "left")).toBe("…");
  });

  test("a clean function runs on the bounded raw prefix only", () => {
    let seen = 0;
    const clean = (s: string) => {
      seen += s.length;
      return s.replace(/\n/g, " ");
    };
    expect(cutCells("a\nb\nc", 10, { clean })).toBe("a b c");
    const huge = "x\n".repeat(1_000_000);
    seen = 0;
    expect(cutCells(huge, 5, { clean, ellipsis: true })).toBe("x x …");
    expect(seen).toBeLessThanOrEqual(32 * 5 + 256);
  });

  test("a text of 50 MB is cut and fitted with work bounded by the budget", () => {
    const ascii = "x".repeat(50 * 1024 * 1024);
    const wide = "é日".repeat(25 * 1024 * 1024);
    wide.charCodeAt(wide.length - 1); // build the string before the clock starts
    for (const text of [ascii, wide]) {
      const before = cellStats();
      const t0 = performance.now();
      const cut = cutCells(text, 40, { ellipsis: true });
      const fitted = fitCells(text, 40, "left");
      const ms = performance.now() - t0;
      const after = cellStats();
      console.log(`50 MB ${text === ascii ? "ASCII" : "é日"}: cut and fit in ${ms.toFixed(3)} ms`);
      expect(cellWidth(cut)).toBeLessThanOrEqual(40);
      expect(cellWidth(fitted)).toBe(40);
      expect(after.unitsRead - before.unitsRead).toBeLessThanOrEqual(2 * (32 * 40 + 256));
      expect(after.measured - before.measured).toBeLessThanOrEqual(400);
      expect(after.measuredUnits - before.measuredUnits).toBeLessThanOrEqual(64 * (32 * 40 + 256));
    }
  });

  test("a surrogate pair is never split at the bounded prefix", () => {
    const text = "😀".repeat(5000);
    for (let budget = 1; budget < 30; budget++) {
      const out = cutCells(text, budget);
      expect(/[\ud800-\udbff]$/.test(out)).toBe(false);
      expect(cellWidth(out)).toBeLessThanOrEqual(budget);
    }
  });
});

describe("one module measures", () => {
  test("no non-test file under src/tui other than ui/cells.ts calls Bun.stringWidth or stringWidth(", () => {
    const root = join(import.meta.dir, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name) || /\.test\.(ts|tsx)$/.test(name)) continue;
        const rel = relative(root, path);
        if (rel === join("ui", "cells.ts")) continue;
        const source = readFileSync(path, "utf8");
        if (source.includes("Bun.stringWidth") || source.includes("stringWidth(")) offenders.push(rel);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
