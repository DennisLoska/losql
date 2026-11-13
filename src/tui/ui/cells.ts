import { measureEditText, type WidthMethod } from "@opentui/core";

/**
 * The one place in the interface that knows how wide text is. It measures as the renderer draws: with the
 * library's own rule under the width method of the running renderer (`renderer.widthMethod`), which the
 * application sets once the renderer is available. Until then the method is "unicode".
 *
 * Texts handed to these functions are single-line texts that have gone through `printable()` (no line
 * breaks, tabs or control characters), or raw texts with a `clean` function that makes them so.
 */

export type { WidthMethod };

/** Texts up to this many UTF-16 units are cached (clusters, labels); longer ones are measured each time. */
const CACHE_TEXT_MAX = 64;
/** At most this many measured texts are kept; the oldest is dropped first. */
const CACHE_LIMIT = 4096;

let method: WidthMethod = "unicode";
const cache = new Map<string, number>();
const stats = { measured: 0, measuredUnits: 0, unitsRead: 0 };

/** The one grapheme segmenter of the interface. */
export const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function widthMethod(): WidthMethod {
  return method;
}

/** Sets the width method of the running renderer; measured widths are forgotten when it changes. */
export function setWidthMethod(next: WidthMethod): void {
  if (next === method) return;
  method = next;
  cache.clear();
}

/** Counters for tests: library calls, units handed to the library, units of input read when cutting. */
export function cellStats(): {
  measured: number;
  measuredUnits: number;
  unitsRead: number;
  cached: number;
  cacheLimit: number;
} {
  return { ...stats, cached: cache.size, cacheLimit: CACHE_LIMIT };
}

function isPrintableAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function measure(text: string): number {
  stats.measured++;
  stats.measuredUnits += text.length;
  return measureEditText(text, { widthMethod: method });
}

/** The number of cells the renderer draws for a single-line printable text. */
export function cellWidth(text: string): number {
  if (isPrintableAscii(text)) return text.length;
  if (text.length > CACHE_TEXT_MAX) return measure(text);
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const width = measure(text);
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(text, width);
  return width;
}

/** The grapheme clusters of a text. */
export function clusters(text: string): string[] {
  return Array.from(graphemes.segment(text), (s) => s.segment);
}

/** How many UTF-16 units of a text are looked at to fill `budget` cells. */
export function prefixLimit(budget: number): number {
  return 32 * Math.max(0, budget) + 256;
}

/**
 * The first `prefixLimit(budget)` units of a text, never ending inside a surrogate pair; `cut` says whether
 * anything was left out.
 */
export function boundedPrefix(text: string, budget: number): { text: string; cut: boolean } {
  const limit = prefixLimit(budget);
  if (text.length <= limit) {
    stats.unitsRead += text.length;
    return { text, cut: false };
  }
  let end = limit;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  stats.unitsRead += end;
  return { text: text.slice(0, end), cut: true };
}

export interface CutOptions {
  /** End a cut text with `…` (the marker counts toward the budget). */
  ellipsis?: boolean;
  /** Applied to the bounded raw prefix before it is measured, for example `printable`. */
  clean?: (text: string) => string;
}

function cut(text: string, budget: number, options: CutOptions | undefined): { text: string; cut: boolean } {
  if (budget < 0) return { text: "", cut: text.length > 0 };
  const raw = boundedPrefix(text, budget);
  const s = options?.clean ? options.clean(raw.text) : raw.text;
  if (!raw.cut && cellWidth(s) <= budget) return { text: s, cut: false };

  const marker = options?.ellipsis ? "…" : "";
  const markerWidth = marker ? cellWidth(marker) : 0;
  if (markerWidth > budget) return { text: "", cut: true };
  const target = budget - markerWidth;

  if (isPrintableAscii(s)) return { text: s.slice(0, target) + marker, cut: true };

  const parts = clusters(s);
  // The last cluster of a bounded prefix may be the start of a longer one: never show it.
  if (raw.cut && parts.length > 0) parts.pop();
  const ends: number[] = [0];
  for (const part of parts) ends.push(ends[ends.length - 1]! + part.length);

  // Estimate from the widths of the clusters, then measure the candidate as a whole: under some width
  // methods the widths of the clusters do not add up to the width of the text.
  let k = 0;
  let used = 0;
  while (k < parts.length) {
    const w = cellWidth(parts[k]!);
    if (used + w > target) break;
    used += w;
    k++;
  }
  const fits = (n: number) => n === 0 || cellWidth(s.slice(0, ends[n]) + marker) <= budget;
  while (k > 0 && !fits(k)) k--;
  while (k < parts.length && fits(k + 1)) k++;
  return { text: s.slice(0, ends[k]) + marker, cut: true };
}

/**
 * The longest prefix of whole grapheme clusters of `text` that the renderer draws in at most `budget` cells,
 * optionally ending in `…` when the text is cut. Only a prefix of the text bounded by the budget is read.
 */
export function cutCells(text: string, budget: number, options?: CutOptions): string {
  return cut(text, budget, options).text;
}

/**
 * The text drawn in exactly `width` cells: cut with `…` when it is wider, otherwise padded with spaces on the
 * right (align left) or on the left (align right). A cut text is padded on the right.
 */
export function fitCells(
  text: string,
  width: number,
  align: "left" | "right",
  options?: { clean?: (text: string) => string },
): string {
  if (width <= 0) return "";
  const fitted = cut(text, width, { ellipsis: true, clean: options?.clean });
  const body = fitted.text;
  const pad = Math.max(0, width - cellWidth(body));
  if (pad === 0) return body;
  if (align === "right" && !fitted.cut) {
    // Spaces before a text can change how its first cluster is drawn (a space followed by U+FE0F is an
    // emoji of two cells): measure the whole and fall back to padding on the right when it is not exact.
    const padded = padTo(body, width, pad, (n) => " ".repeat(n) + body);
    if (padded !== null) return padded;
  }
  return padTo(body, width, pad, (n) => body + " ".repeat(n)) ?? body + " ".repeat(pad);
}

function padTo(body: string, width: number, pad: number, compose: (pad: number) => string): string | null {
  if (isPrintableAscii(body)) return compose(pad);
  let n = pad;
  for (let attempt = 0; attempt < 3 && n >= 0; attempt++) {
    const candidate = compose(n);
    const w = cellWidth(candidate);
    if (w === width) return candidate;
    n += width - w;
  }
  return null;
}
