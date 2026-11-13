import { expect, test } from "bun:test";
import { keyFromEvent, parseKeys } from "./keys";

test("parseKeys: plain characters", () => {
  expect(parseKeys("dw")).toEqual([{ name: "d", text: "d" }, { name: "w", text: "w" }]);
  expect(parseKeys("G")).toEqual([{ name: "g", text: "G", shift: true }]);
  expect(parseKeys("$3")).toEqual([{ name: "$", text: "$" }, { name: "3", text: "3" }]);
  expect(parseKeys("a b")).toEqual([{ name: "a", text: "a" }, { name: "space", text: " " }, { name: "b", text: "b" }]);
});

test("parseKeys: special keys", () => {
  expect(parseKeys("<Esc><CR><BS><Tab><Space><lt>")).toEqual([
    { name: "escape" }, { name: "enter" }, { name: "backspace" }, { name: "tab" },
    { name: "space", text: " " }, { name: "<", text: "<" },
  ]);
  expect(parseKeys("<C-r><C-CR><S-Tab><Up><Down><Left><Right><F1><C-[>")).toEqual([
    { name: "r", ctrl: true }, { name: "enter", ctrl: true }, { name: "tab", shift: true },
    { name: "up" }, { name: "down" }, { name: "left" }, { name: "right" }, { name: "f1" }, { name: "[", ctrl: true },
  ]);
});

test("parseKeys: a < that does not open a known key name is literal", () => {
  expect(parseKeys("<<")).toEqual([{ name: "<", text: "<" }, { name: "<", text: "<" }]);
  expect(parseKeys("a<b")).toEqual([{ name: "a", text: "a" }, { name: "<", text: "<" }, { name: "b", text: "b" }]);
});

test("keyFromEvent", () => {
  const ev = (name: string, sequence: string, mods: Partial<{ ctrl: boolean; meta: boolean; shift: boolean }> = {}) =>
    ({ name, sequence, ctrl: false, meta: false, shift: false, ...mods });
  expect(keyFromEvent(ev("a", "a"))).toEqual({ name: "a", text: "a" });
  expect(keyFromEvent(ev("a", "A", { shift: true }))).toEqual({ name: "a", text: "A", shift: true });
  expect(keyFromEvent(ev("$", "$"))).toEqual({ name: "$", text: "$" });
  expect(keyFromEvent(ev("space", " "))).toEqual({ name: "space", text: " " });
  expect(keyFromEvent(ev("return", "\r"))).toEqual({ name: "enter" });
  expect(keyFromEvent(ev("return", "\r", { ctrl: true }))).toEqual({ name: "enter", ctrl: true });
  expect(keyFromEvent(ev("linefeed", "\n"))).toEqual({ name: "j", ctrl: true });
  expect(keyFromEvent(ev("escape", "\x1b"))).toEqual({ name: "escape" });
  expect(keyFromEvent(ev("r", "\x12", { ctrl: true }))).toEqual({ name: "r", ctrl: true });
  expect(keyFromEvent(ev("tab", "\t", { shift: true }))).toEqual({ name: "tab", shift: true });
  expect(keyFromEvent(ev("up", "\x1b[A"))).toEqual({ name: "up" });
  expect(keyFromEvent(ev("x", "\x1b[120;1u"))).toEqual({ name: "x", text: "x" });
  // the kitty protocol reports a shifted letter with an upper-case name
  expect(keyFromEvent(ev("G", "G", { shift: true }))).toEqual({ name: "g", text: "G", shift: true });
  expect(keyFromEvent(ev("G", "\x1b[103;2u", { shift: true }))).toEqual({ name: "g", text: "G", shift: true });
  expect(keyFromEvent(ev("w", "w", { ctrl: true }))).toEqual({ name: "w", ctrl: true });
  expect(keyFromEvent(ev("[", "[", { ctrl: true }))).toEqual({ name: "[", ctrl: true });
});

test("keyFromEvent: astral character sequence is accepted as text", () => {
  const k = keyFromEvent({ name: "", sequence: "😀", ctrl: false, meta: false, shift: false });
  expect(k.text).toBe("😀");
});

test("parseKeys: keeps an astral character as one key", async () => {
  const { vim, start } = await import("./testing");
  const keys = parseKeys("r😀");
  expect(keys).toEqual([{ name: "r", text: "r" }, { name: "😀", text: "😀" }]);
  expect(vim("|ab", "r😀")).toBe("|😀b");
  const s = start("|a");
  s.feed("i😀<Esc>");
  expect(s.buffer.text()).toBe("😀a");
  expect(s.buffer.cursor()).toEqual({ row: 0, col: 0 });
  expect(s.marked()).toBe("|😀a");
});


