import { expect, test } from "bun:test";
import { toHex } from "./color";
import { omarchyToThemeJson } from "./omarchy";
import { resolveTheme } from "./resolve";
import { ThemeError } from "./tokens";

const TOKYO = `
mode = "dark"

accent = "#7aa2f7"
selection = "#292e42"
muted = "#414868"

background = "#1a1b26"
dark_background = "#13141c"
darker_background = "#0e0e14"
lighter_background = "#24283b"

foreground = "#a9b1d6"
dark_foreground = "#565f89"
light_foreground = "#b4bee6"
bright_foreground = "#c0caf5"

red = "#f7768e"
yellow = "#e0af68"
orange = "#eb927b"
green = "#9ece6a"
cyan = "#449dab"
blue = "#7aa2f7"
magenta = "#ad8ee6"
brown = "#75493d"
`;

test("maps Omarchy colours onto theme tokens", () => {
  const { json, mode } = omarchyToThemeJson(TOKYO);
  expect(mode).toBe("dark");
  const t = resolveTheme("omarchy", json, { mode, transparent: false });
  const hex = (token: keyof typeof t) => toHex(t[token] as never);
  expect(hex("primary")).toBe("#7aa2f7");
  expect(hex("secondary")).toBe("#ad8ee6");
  expect(hex("accent")).toBe("#eb927b");
  expect(hex("error")).toBe("#f7768e");
  expect(hex("warning")).toBe("#e0af68");
  expect(hex("success")).toBe("#9ece6a");
  expect(hex("info")).toBe("#449dab");
  expect(hex("text")).toBe("#a9b1d6");
  expect(hex("textMuted")).toBe("#565f89");
  expect(hex("background")).toBe("#1a1b26");
  expect(hex("backgroundPanel")).toBe("#13141c");
  expect(hex("backgroundElement")).toBe("#24283b");
  expect(hex("border")).toBe("#414868");
  expect(hex("borderActive")).toBe("#7aa2f7");
  expect(hex("borderSubtle")).toBe("#292e42");
  expect(hex("syntaxKeyword")).toBe("#ad8ee6");
  expect(hex("syntaxFunction")).toBe("#7aa2f7");
  expect(hex("syntaxString")).toBe("#9ece6a");
  expect(hex("syntaxNumber")).toBe("#eb927b");
  expect(hex("syntaxType")).toBe("#449dab");
  expect(hex("syntaxComment")).toBe("#565f89");
  expect(hex("syntaxVariable")).toBe("#a9b1d6");
});

test("light mode and missing optional colours", () => {
  const { json, mode } = omarchyToThemeJson('mode = "light"\nbackground = "#ffffff"\nforeground = "#111111"\nblue = "#0000ff"\n');
  expect(mode).toBe("light");
  const t = resolveTheme("omarchy", json, { mode, transparent: false });
  expect(toHex(t.primary)).toBe("#0000ff");
  expect(toHex(t.backgroundPanel)).toBe("#ffffff");
  expect(toHex(t.text)).toBe("#111111");
});

test("a file without foreground or background is rejected", () => {
  expect(() => omarchyToThemeJson('accent = "#ff0000"\n')).toThrow(ThemeError);
  expect(() => omarchyToThemeJson("not = [valid")).toThrow(ThemeError);
});

test("empty or whitespace-only Omarchy colours fall back", () => {
  const { json, mode } = omarchyToThemeJson(
    'accent = ""\nblue = "#0000ff"\norange = "   "\nyellow = "#ffff00"\nbackground = "#000000"\nforeground = "#ffffff"\n',
  );
  const t = resolveTheme("omarchy", json, { mode, transparent: false });
  expect(toHex(t.primary)).toBe("#0000ff");
  expect(toHex(t.accent)).toBe("#ffff00");
});
