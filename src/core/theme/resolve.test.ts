import { describe, expect, test } from "bun:test";
import { toHex } from "./color";
import { BUILTIN_THEMES } from "./registry";
import { resolveTheme } from "./resolve";
import { THEME_TOKENS, ThemeError, type ThemeJson } from "./tokens";

const tokyo = BUILTIN_THEMES.tokyonight!;

describe("resolveTheme", () => {
  test("tokyonight, dark", () => {
    const t = resolveTheme("tokyonight", tokyo, { mode: "dark", transparent: false });
    expect(t.name).toBe("tokyonight");
    expect(t.mode).toBe("dark");
    expect(t.transparent).toBe(false);
    expect(toHex(t.primary)).toBe("#82aaff");
    expect(toHex(t.secondary)).toBe("#c099ff");
    expect(toHex(t.accent)).toBe("#ff966c");
    expect(toHex(t.text)).toBe("#c8d3f5");
    expect(toHex(t.textMuted)).toBe("#828bb8");
    expect(toHex(t.background)).toBe("#1a1b26");
    expect(toHex(t.backgroundPanel)).toBe("#1e2030");
    expect(toHex(t.backgroundElement)).toBe("#222436");
    expect(toHex(t.border)).toBe("#737aa2");
    expect(toHex(t.paneBackground)).toBe("#1e2030");
    expect(toHex(t.overlayBackground)).toBe("#1e2030");
  });

  test("tokyonight, light", () => {
    const t = resolveTheme("tokyonight", tokyo, { mode: "light", transparent: false });
    expect(toHex(t.primary)).toBe("#2e7de9");
    expect(toHex(t.background)).toBe("#e1e2e7");
  });

  test("transparent clears the base and pane backgrounds and keeps overlays opaque", () => {
    const t = resolveTheme("tokyonight", tokyo, { mode: "dark", transparent: true });
    expect(t.transparent).toBe(true);
    expect(t.background.a).toBe(0);
    expect(t.paneBackground.a).toBe(0);
    expect(toHex(t.overlayBackground)).toBe("#1e2030");
    expect(t.backgroundElement.a).toBe(255);
    expect(t.selection.a).toBe(255);
    expect(toHex(t.text)).toBe("#c8d3f5");
  });

  test("a theme whose own background is transparent still has opaque overlays", () => {
    const json: ThemeJson = { theme: { primary: "#112233", text: "#ffffff", background: "transparent", backgroundPanel: "none" } };
    const t = resolveTheme("clear", json, { mode: "dark", transparent: false });
    expect(t.background.a).toBe(0);
    expect(t.paneBackground.a).toBe(0);
    expect(t.overlayBackground.a).toBe(255);
    expect(t.selection.a).toBe(255);
  });

  test("references resolve through defs and through other tokens", () => {
    const json: ThemeJson = {
      defs: { blue: "#0000ff", main: "blue" },
      theme: { primary: "main", text: { dark: "#eeeeee", light: "#111111" }, background: "#000000", borderActive: "primary" },
    };
    const t = resolveTheme("x", json, { mode: "light", transparent: false });
    expect(toHex(t.primary)).toBe("#0000ff");
    expect(toHex(t.text)).toBe("#111111");
    expect(toHex(t.borderActive)).toBe("#0000ff");
  });

  test("missing optional tokens fall back", () => {
    const t = resolveTheme("min", { theme: { primary: "#112233", text: "#ffffff", background: "#000000" } }, { mode: "dark", transparent: false });
    for (const token of THEME_TOKENS) expect(t[token].a).toBe(255);
    expect(toHex(t.secondary)).toBe("#112233");
    expect(toHex(t.borderActive)).toBe("#112233");
    expect(toHex(t.backgroundPanel)).toBe("#000000");
    expect(toHex(t.backgroundElement)).toBe("#000000");
    expect(toHex(t.syntaxFunction)).toBe("#112233");
    expect(toHex(t.syntaxVariable)).toBe("#ffffff");
    expect(toHex(t.textMuted)).toBe("#999999");
  });

  test("errors name the theme and the problem", () => {
    expect(() => resolveTheme("bad", { theme: { text: "#fff", background: "#000" } }, { mode: "dark", transparent: false }))
      .toThrow("theme bad: missing required color primary");
    expect(() => resolveTheme("bad", { theme: { primary: "nope", text: "#fff", background: "#000" } }, { mode: "dark", transparent: false }))
      .toThrow("theme bad: unknown color reference nope");
    expect(() => resolveTheme("bad", { defs: { a: "b", b: "a" }, theme: { primary: "a", text: "#fff", background: "#000" } }, { mode: "dark", transparent: false }))
      .toThrow("theme bad: circular color reference a");
    expect(() => resolveTheme("bad", { theme: { primary: 4 as unknown as string, text: "#fff", background: "#000" } }, { mode: "dark", transparent: false }))
      .toThrow(ThemeError);
  });

  test("every built-in theme resolves in every combination", () => {
    expect(Object.keys(BUILTIN_THEMES).sort()).toEqual(["catppuccin", "everforest", "gruvbox", "kanagawa", "nord", "rosepine", "tokyonight"]);
    for (const [name, json] of Object.entries(BUILTIN_THEMES)) {
      for (const mode of ["dark", "light"] as const) {
        for (const transparent of [false, true]) {
          const t = resolveTheme(name, json, { mode, transparent });
          expect(t.text.a).toBe(255);
          expect(t.overlayBackground.a).toBe(255);
          expect(t.paneBackground.a).toBe(transparent ? 0 : 255);
        }
      }
    }
  });

  test("a theme token may share its name with the def it refers to", () => {
    const json: ThemeJson = {
      defs: { primary: "#123456" },
      theme: { primary: "primary", text: "#ffffff", background: "#000000" },
    };
    for (const mode of ["dark", "light"] as const) {
      const t = resolveTheme("same", json, { mode, transparent: false });
      expect(t.primary).toEqual({ r: 0x12, g: 0x34, b: 0x56, a: 255 });
    }
  });

  test("a real cycle is still an error", () => {
    expect(() =>
      resolveTheme(
        "bad",
        { theme: { primary: "secondary", secondary: "primary", text: "#fff", background: "#000" } },
        { mode: "dark", transparent: false },
      ),
    ).toThrow("theme bad: circular color reference primary");
  });

  test("selection is opaque even when primary is translucent", () => {
    const json: ThemeJson = {
      theme: { primary: "#11223380", text: "#ffffff", background: "#000000" },
    };
    for (const transparent of [false, true]) {
      const t = resolveTheme("semi", json, { mode: "dark", transparent });
      expect(t.selection.a).toBe(255);
      expect(t.selection).toEqual({ r: 6, g: 12, b: 18, a: 255 });
      expect(toHex(t.selection)).toBe("#060c12");
    }
  });

  test("bounded reference chain depth", () => {
    const defs10: Record<string, string> = {};
    for (let i = 0; i < 9; i++) {
      defs10[`d${i}`] = `d${i + 1}`;
    }
    defs10.d9 = "#abcdef";
    const resolved = resolveTheme(
      "chain10",
      { defs: defs10, theme: { primary: "d0", text: "#ffffff", background: "#000000" } },
      { mode: "dark", transparent: false },
    );
    expect(toHex(resolved.primary)).toBe("#abcdef");

    const defs5000: Record<string, string> = {};
    for (let i = 0; i < 4999; i++) {
      defs5000[`d${i}`] = `d${i + 1}`;
    }
    defs5000.d4999 = "#abcdef";
    expect(() =>
      resolveTheme(
        "deep",
        { defs: defs5000, theme: { primary: "d0", text: "#ffffff", background: "#000000" } },
        { mode: "dark", transparent: false },
      ),
    ).toThrow(ThemeError);
    expect(() =>
      resolveTheme(
        "deep",
        { defs: defs5000, theme: { primary: "d0", text: "#ffffff", background: "#000000" } },
        { mode: "dark", transparent: false },
      ),
    ).toThrow("theme deep: color reference chain too deep for primary");
  });
});
