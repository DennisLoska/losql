import { MemoryBuffer } from "./buffer";
import { VimEngine, type VimOptions } from "./engine";
import { parseKeys } from "./keys";

/** "ab|c" -> text "abc", cursor at row 0, col 2. */
export function unmark(marked: string): { text: string; row: number; col: number } {
  const at = marked.indexOf("|");
  if (at < 0) throw new Error(`no cursor marker in ${JSON.stringify(marked)}`);
  const before = marked.slice(0, at).split("\n");
  return {
    text: marked.slice(0, at) + marked.slice(at + 1),
    row: before.length - 1,
    col: before[before.length - 1]!.length,
  };
}

export function start(marked: string, options: VimOptions = {}) {
  const { text, row, col } = unmark(marked);
  const buffer = new MemoryBuffer(text);
  buffer.setCursor({ row, col });
  const engine = new VimEngine(buffer, options);
  return {
    buffer,
    engine,
    feed(keys: string) {
      for (const key of parseKeys(keys)) engine.feed(key);
    },
    marked(): string {
      const lines = buffer.text().split("\n");
      const c = buffer.cursor();
      lines[c.row] = lines[c.row]!.slice(0, c.col) + "|" + lines[c.row]!.slice(c.col);
      return lines.join("\n");
    },
  };
}

/** Feed keys to a buffer described with a cursor marker and return the result in the same form. */
export function vim(marked: string, keys: string, options: VimOptions = {}): string {
  const s = start(marked, options);
  s.feed(keys);
  return s.marked();
}
